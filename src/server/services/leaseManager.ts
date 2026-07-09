// lease-test: verified
/**
 * Lease Manager Service
 * Provides atomic all-or-nothing file lease acquisition, renewal, and release
 * for lease-based concurrency control of parallel task execution.
 * Includes priority preemption, deadlock detection, and disk persistence.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileLease, LeaseRequest, LeaseResult, FileConflict, LeaseStoreSnapshot } from '../../types/index.js';
import { getFormicDir, getWorkspacePath } from '../utils/paths.js';
import { getTask, updateTaskStatus } from './store.js';
import { broadcastLeaseReleased } from './boardNotifier.js';
import { internalEvents, LEASE_RELEASED, LEASE_ACQUIRED, requestTaskStop } from './internalEvents.js';

const execAsync = promisify(exec);

import { engineConfig } from './engineConfig.js';

/** Active-task predicate: returns true when a task has a live workflow process. */
let isTaskActive: ((taskId: string) => boolean) | null = null;

/**
 * Register the active-task predicate callback. Used by workflow.ts to expose
 * its activeWorkflows knowledge to leaseManager so expiry checks can protect
 * leases held by tasks with live child processes.
 */
export function registerActiveTaskPredicate(fn: (taskId: string) => boolean): void {
  isTaskActive = fn;
}

/** In-memory lease store: filePath → FileLease */
const leaseStore = new Map<string, FileLease>();

/** Recorded file hashes for collision detection: taskId → Map<filePath, hash> */
const fileHashStore = new Map<string, Map<string, string>>();

/** Wait-for map: taskId → filePath the task is waiting to acquire */
const waitForMap = new Map<string, string>();

/** Priority rank for comparison: higher number = higher priority */
const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/**
 * Acquire file leases atomically (all-or-nothing).
 * If any exclusive file is already leased by another task, the entire request is denied.
 * Shared files are not exclusively locked.
 */
export function acquireLeases(request: LeaseRequest): LeaseResult {
  const { taskId, exclusiveFiles, sharedFiles } = request;
  const durationMs = request.leaseDurationMs ?? engineConfig.leaseDurationMs;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  // Clean expired leases before checking
  cleanExpiredLeases();

  // Check for conflicts on exclusive files
  const conflictingFiles: string[] = [];
  for (const filePath of exclusiveFiles) {
    const existing = leaseStore.get(filePath);
    if (existing && existing.taskId !== taskId) {
      conflictingFiles.push(filePath);
      continue;
    }
    // Also check for shared leases on this file held by other tasks
    for (const [key, lease] of leaseStore.entries()) {
      if (key.startsWith(`${filePath}::`) && lease.taskId !== taskId) {
        conflictingFiles.push(filePath);
        break;
      }
    }
  }

  // Check for conflicts on shared files against exclusive leases
  for (const filePath of sharedFiles) {
    const existing = leaseStore.get(filePath);
    if (existing && existing.taskId !== taskId && existing.leaseType === 'exclusive') {
      conflictingFiles.push(filePath);
    }
  }

  if (conflictingFiles.length > 0) {
    console.warn(`[LeaseManager] Lease denied for task ${taskId}: conflicts on ${conflictingFiles.join(', ')}`);
    return { granted: false, leases: [], conflictingFiles };
  }

  // Grant all leases atomically — all conflict checks passed
  const grantedLeases: FileLease[] = [];

  for (const filePath of exclusiveFiles) {
    const lease: FileLease = {
      filePath,
      taskId,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      leaseType: 'exclusive',
    };
    leaseStore.set(filePath, lease);
    grantedLeases.push(lease);
  }

  for (const filePath of sharedFiles) {
    const lease: FileLease = {
      filePath,
      taskId,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      leaseType: 'shared',
    };
    // Shared files don't block others - store with task-scoped key
    leaseStore.set(`${filePath}::${taskId}`, lease);
    grantedLeases.push(lease);
  }

  console.warn(`[LeaseManager] Leases granted for task ${taskId}: ${exclusiveFiles.length} exclusive, ${sharedFiles.length} shared`);
  internalEvents.emit(LEASE_ACQUIRED, { taskId, leases: grantedLeases });
  persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
  return { granted: true, leases: grantedLeases, conflictingFiles: [] };
}

/**
 * Release all leases held by a task
 */
export function releaseLeases(taskId: string): void {
  let released = 0;
  const releasedFiles: string[] = [];
  for (const [key, lease] of leaseStore.entries()) {
    if (lease.taskId === taskId) {
      if (lease.leaseType === 'exclusive') {
        releasedFiles.push(lease.filePath);
      }
      leaseStore.delete(key);
      released++;
    }
  }
  if (released > 0) {
    console.warn(`[LeaseManager] Released ${released} lease(s) for task ${taskId}`);
    broadcastLeaseReleased(taskId, releasedFiles);
    internalEvents.emit(LEASE_RELEASED, taskId, releasedFiles);
  }

  // Clean up file hash records
  fileHashStore.delete(taskId);
  persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
}

/**
 * Renew all leases for a task by extending their expiration.
 * No longer calls cleanExpiredLeases — expiry-driven cleanup is exclusively
 * handled by acquireLeases (the mutation entry point) and the watchdog.
 */
export function renewLeases(taskId: string, durationMs?: number): boolean {
  const extension = durationMs ?? engineConfig.leaseDurationMs;
  const newExpiresAt = new Date(Date.now() + extension).toISOString();
  let renewed = 0;

  for (const lease of leaseStore.values()) {
    if (lease.taskId === taskId) {
      lease.expiresAt = newExpiresAt;
      renewed++;
    }
  }

  if (renewed > 0) {
    console.warn(`[LeaseManager] Renewed ${renewed} lease(s) for task ${taskId}`);
    return true;
  }
  return false;
}

/**
 * Get all leases held by a specific task
 */
export function getLeasesByTask(taskId: string): FileLease[] {
  const leases: FileLease[] = [];
  for (const lease of leaseStore.values()) {
    if (lease.taskId === taskId) {
      leases.push(lease);
    }
  }
  return leases;
}

/**
 * Get all active leases, filtering out expired leases whose holder is not active.
 * This is a read-only operation — no mutation, no events, no persistence.
 */
export function getAllLeases(): FileLease[] {
  const now = Date.now();
  return Array.from(leaseStore.values()).filter(lease => {
    if (new Date(lease.expiresAt).getTime() > now) return true;
    // Expired but holder is active — still considered leased
    return isTaskActive ? isTaskActive(lease.taskId) : false;
  });
}

/**
 * Check if a file is currently leased (optionally excluding a specific task).
 * Expired leases whose holder is not active are treated as not leased.
 * This is a read-only operation — no mutation, no events, no persistence.
 */
export function isFileLeased(filePath: string, excludeTaskId?: string): boolean {
  const now = Date.now();
  const lease = leaseStore.get(filePath);
  if (!lease) return false;
  if (excludeTaskId && lease.taskId === excludeTaskId) return false;
  // Expired and holder not active — treat as free
  if (new Date(lease.expiresAt).getTime() <= now && !(isTaskActive && isTaskActive(lease.taskId))) {
    return false;
  }
  return true;
}

/**
 * Check whether a file would conflict if the given taskId intended to acquire it
 * exclusively. Mirrors the conflict logic in acquireLeases() so pre-dispatch
 * checks and actual lease grants are consistent.
 *
 * A conflict exists when:
 * 1. The file has an exclusive lease held by a different task, OR
 * 2. The file has one or more shared leases held by different tasks
 *
 * Expired leases are cleaned before checking, matching acquireLeases behaviour.
 * Returns true if there IS a conflict (i.e., the task would be denied).
 */
export function wouldConflict(filePath: string, taskId: string): boolean {
  // Clean expired leases before checking (consistent with acquireLeases)
  cleanExpiredLeases();

  // Check exclusive holder
  const exclusive = leaseStore.get(filePath);
  if (exclusive && exclusive.taskId !== taskId) {
    return true;
  }

  // Check shared holders — stored under filePath::taskId keys
  for (const [key, lease] of leaseStore.entries()) {
    if (key.startsWith(`${filePath}::`) && lease.taskId !== taskId) {
      return true;
    }
  }

  return false;
}

/**
 * Get the task ID that holds an exclusive lease on a file, or null if none.
 * Expired leases whose holder is not active are treated as not held.
 * Used to identify zombie lease holders.
 * This is a read-only operation — no mutation, no events, no persistence.
 */
export function getExclusiveLeaseHolder(filePath: string): string | null {
  const now = Date.now();
  const lease = leaseStore.get(filePath);
  if (!lease || lease.leaseType !== 'exclusive') return null;
  // Expired and holder not active — treat as not held
  if (new Date(lease.expiresAt).getTime() <= now && !(isTaskActive && isTaskActive(lease.taskId))) {
    return null;
  }
  return lease.taskId;
}

/**
 * Clean up expired leases from the store.
 *
 * Expired leases whose holder has a live workflow process are renewed in-place
 * (mirrors the watchdog's active-task guard). Leases whose holder is NOT active
 * are genuinely freed: deleted from the store, broadcast via boardNotifier,
 * emitted via internalEvents (LEASE_RELEASED), and persisted to leases.json.
 */
function cleanExpiredLeases(): void {
  const now = Date.now();
  const releasedExclusiveByTask = new Map<string, string[]>();

  for (const [key, lease] of leaseStore.entries()) {
    if (new Date(lease.expiresAt).getTime() <= now) {
      if (isTaskActive && isTaskActive(lease.taskId)) {
        // Active task: renew in-place instead of deleting
        const newExpiresAt = new Date(now + engineConfig.leaseDurationMs).toISOString();
        lease.expiresAt = newExpiresAt;
        console.warn(`[LeaseManager] Renewed expired lease for active task ${lease.taskId} on ${lease.filePath}`);
      } else {
        // Not active: genuinely free the lease
        if (lease.leaseType === 'exclusive') {
          const files = releasedExclusiveByTask.get(lease.taskId) || [];
          files.push(lease.filePath);
          releasedExclusiveByTask.set(lease.taskId, files);
        }
        leaseStore.delete(key);
      }
    }
  }

  // Emit LEASE_RELEASED and broadcast for genuinely freed leases
  for (const [taskId, files] of releasedExclusiveByTask) {
    console.warn(`[LeaseManager] Expired leases freed for inactive task ${taskId}: ${files.join(', ')}`);
    broadcastLeaseReleased(taskId, files);
    internalEvents.emit(LEASE_RELEASED, taskId, files);
  }

  if (releasedExclusiveByTask.size > 0) {
    persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
  }
}

/**
 * Get all expired leases (used by watchdog)
 */
export function getExpiredLeases(): FileLease[] {
  const now = Date.now();
  const expired: FileLease[] = [];
  for (const lease of leaseStore.values()) {
    if (new Date(lease.expiresAt).getTime() <= now) {
      expired.push(lease);
    }
  }
  return expired;
}

/**
 * Record git hash-object hashes for shared files at task start
 * Used for optimistic concurrency collision detection
 */
export async function recordFileHashes(taskId: string, filePaths: string[], cwd: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const filePath of filePaths) {
    try {
      const { stdout } = await execAsync(`git hash-object "${filePath}"`, { cwd });
      const hash = stdout.trim();
      if (hash) {
        hashes.set(filePath, hash);
      }
    } catch {
      // File may not exist yet, skip it
      console.warn(`[LeaseManager] Could not hash file: ${filePath}`);
    }
  }

  fileHashStore.set(taskId, hashes);
  console.warn(`[LeaseManager] Recorded ${hashes.size} file hash(es) for task ${taskId}`);
  return hashes;
}

/**
 * Detect collisions on shared files by comparing current hashes to recorded ones
 */
export async function detectCollisions(taskId: string, cwd: string): Promise<FileConflict[]> {
  const baseHashes = fileHashStore.get(taskId);
  if (!baseHashes || baseHashes.size === 0) {
    return [];
  }

  const conflicts: FileConflict[] = [];

  for (const [filePath, expectedHash] of baseHashes.entries()) {
    try {
      const { stdout } = await execAsync(`git hash-object "${filePath}"`, { cwd });
      const actualHash = stdout.trim();
      if (actualHash && actualHash !== expectedHash) {
        conflicts.push({
          filePath,
          expectedHash,
          actualHash,
        });
      }
    } catch {
      // File may have been deleted, treat as conflict
      conflicts.push({
        filePath,
        expectedHash,
        actualHash: '<deleted>',
      });
    }
  }

  if (conflicts.length > 0) {
    console.warn(`[LeaseManager] Detected ${conflicts.length} collision(s) for task ${taskId}`);
  }

  return conflicts;
}

/**
 * Register that a task is waiting to acquire a lease on a file.
 * Used to build the wait-for graph for deadlock detection.
 */
export function recordWait(taskId: string, filePath: string): void {
  waitForMap.set(taskId, filePath);
}

/**
 * Unregister a task's wait record once it acquires or abandons the lease.
 */
export function clearWait(taskId: string): void {
  waitForMap.delete(taskId);
}

/**
 * Persist the current leaseStore to .formic/leases.json.
 * Fire-and-forget — callers should .catch() the returned promise.
 */
export async function persistLeases(): Promise<void> {
  try {
    const snapshot: LeaseStoreSnapshot = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      leases: Array.from(leaseStore.entries()).map(([key, lease]) => ({ key, lease })),
    };
    const leasesPath = path.join(getFormicDir(), 'leases.json');
    await writeFile(leasesPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[LeaseManager] Failed to persist leases:', err instanceof Error ? err.message : 'Unknown error');
  }
}

/**
 * Restore non-expired leases from .formic/leases.json into leaseStore.
 * Called on server startup by the watchdog.
 */
export async function restoreLeases(): Promise<void> {
  try {
    const leasesPath = path.join(getFormicDir(), 'leases.json');
    const raw = await readFile(leasesPath, 'utf-8');
    const snapshot: LeaseStoreSnapshot = JSON.parse(raw) as LeaseStoreSnapshot;
    const now = Date.now();
    let restored = 0;
    for (const { key, lease } of snapshot.leases) {
      if (new Date(lease.expiresAt).getTime() > now) {
        leaseStore.set(key, lease);
        restored++;
      }
    }
    console.warn(`[LeaseManager] Restored ${restored} non-expired lease(s) from disk`);
  } catch (err) {
    // File not found on first startup is expected
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!message.includes('ENOENT')) {
      console.warn('[LeaseManager] Failed to restore leases:', message);
    } else {
      console.warn('[LeaseManager] No leases.json found — starting with empty lease store');
    }
  }
}

/**
 * Revert uncommitted changes on a task's exclusively-leased files after its
 * process has been stopped, so a half-written state is never handed to the
 * next lease holder (mirrors the watchdog's expired-lease path).
 */
async function revertExclusiveFiles(taskId: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  try {
    const fileList = files.map(f => `"${f}"`).join(' ');
    await execAsync(`git checkout -- ${fileList}`, { cwd: getWorkspacePath() });
    console.warn(`[LeaseManager] Reverted uncommitted changes on ${files.length} leased file(s) for task ${taskId}`);
  } catch (err) {
    console.warn(`[LeaseManager] Failed to revert leased files for task ${taskId}:`, err instanceof Error ? err.message : 'Unknown error');
  }
}

/**
 * Attempt to preempt an exclusive lease held by a lower-priority task.
 * The holder's process is stopped BEFORE its leases are released; if the
 * holder cannot be stopped, the preemption is refused — a lease must never
 * be handed to a new task while the previous holder may still be writing.
 * Returns true if the file was freed, false if preemption was not applicable
 * or was refused.
 */
export async function preemptLease(highPriorityTaskId: string, targetFilePath: string): Promise<boolean> {
  const holderLease = leaseStore.get(targetFilePath);
  if (!holderLease || holderLease.leaseType !== 'exclusive') {
    return false;
  }

  const holderId = holderLease.taskId;
  if (holderId === highPriorityTaskId) {
    return false;
  }

  const [holderTask, requesterTask] = await Promise.all([
    getTask(holderId),
    getTask(highPriorityTaskId),
  ]);

  const holderRank = PRIORITY_RANK[holderTask?.priority ?? 'medium'] ?? 1;
  const requesterRank = PRIORITY_RANK[requesterTask?.priority ?? 'medium'] ?? 1;

  if (holderRank >= requesterRank) {
    return false;
  }

  // The lease may have vanished while task lookups were awaited — distinguish
  // expiry from voluntary release rather than misattributing either.
  const leaseBeforeStop = leaseStore.get(targetFilePath);
  if (!leaseBeforeStop || leaseBeforeStop.taskId !== holderId) {
    if (new Date(holderLease.expiresAt).getTime() <= Date.now()) {
      console.warn(`[LeaseManager] Lease on ${targetFilePath} expired before preemption of task ${holderId} — no stop needed`);
    } else {
      console.warn(`[LeaseManager] Lease on ${targetFilePath} was released before preemption of task ${holderId} — no stop needed`);
    }
    return !leaseBeforeStop;
  }

  // Capture the holder's exclusive files before stopping so they can be reverted
  const holderExclusiveFiles = getLeasesByTask(holderId)
    .filter(l => l.leaseType === 'exclusive')
    .map(l => l.filePath);

  // Stop the holder's process BEFORE touching its leases
  const stopped = await requestTaskStop(holderId);
  if (!stopped) {
    console.warn(`[LeaseManager] Preemption of ${targetFilePath} refused: holder task ${holderId} could not be stopped`);
    return false;
  }

  // Holder is stopped: revert its half-written files, release, and re-queue.
  // The stop transition sets resumeFromStep for tasks past planning; the
  // 'queued' transition below preserves that marker.
  await revertExclusiveFiles(holderId, holderExclusiveFiles);
  releaseLeases(holderId);
  clearWait(holderId);
  await updateTaskStatus(holderId, 'queued', null, 'leaseManager.preemption');
  console.warn(`[LeaseManager] Preempted lease on ${targetFilePath}: stopped, reverted, and re-queued task ${holderId}`);

  return true;
}

/**
 * Detect and resolve deadlock cycles in the wait-for graph.
 * Resolves each cycle by stopping the lowest-priority task in the cycle,
 * reverting its leased files, releasing its leases, and re-queuing it.
 * If the victim cannot be stopped, resolution for that cycle is skipped this
 * tick (the watchdog re-runs detection every interval).
 * Returns the detected cycle arrays, or null if no cycles were found.
 */
export async function detectDeadlock(): Promise<string[][] | null> {
  if (waitForMap.size === 0) return null;

  // Build task-to-task wait-for graph: waiting task → holding task
  const waitGraph = new Map<string, string>();
  for (const [waitingTaskId, filePath] of waitForMap.entries()) {
    const holderLease = leaseStore.get(filePath);
    if (holderLease && holderLease.taskId !== waitingTaskId) {
      waitGraph.set(waitingTaskId, holderLease.taskId);
    }
  }

  if (waitGraph.size === 0) return null;

  // DFS-based cycle detection on a functional graph (each node has ≤1 outgoing edge)
  const cycles: string[][] = [];
  const visited = new Set<string>();

  for (const startNode of waitGraph.keys()) {
    if (visited.has(startNode)) continue;

    const path: string[] = [];
    const pathSet = new Set<string>();
    let current: string | undefined = startNode;

    while (current !== undefined && !visited.has(current)) {
      if (pathSet.has(current)) {
        const cycleStart = path.indexOf(current);
        cycles.push(path.slice(cycleStart));
        break;
      }
      path.push(current);
      pathSet.add(current);
      current = waitGraph.get(current);
    }

    for (const node of path) {
      visited.add(node);
    }
  }

  if (cycles.length === 0) return null;

  console.warn(`[LeaseManager] Detected ${cycles.length} deadlock cycle(s)`);

  // Resolve each cycle by aborting the lowest-priority task
  for (const cycle of cycles) {
    let victimId = cycle[0];
    let victimRank = PRIORITY_RANK[(await getTask(victimId))?.priority ?? 'medium'] ?? 1;

    for (const taskId of cycle.slice(1)) {
      const task = await getTask(taskId);
      const rank = PRIORITY_RANK[task?.priority ?? 'medium'] ?? 1;
      if (rank < victimRank) {
        victimId = taskId;
        victimRank = rank;
      }
    }

    // Capture the victim's exclusive files before stopping so they can be reverted
    const victimExclusiveFiles = getLeasesByTask(victimId)
      .filter(l => l.leaseType === 'exclusive')
      .map(l => l.filePath);

    // Stop the victim's process BEFORE releasing its leases; skip this cycle
    // if it cannot be stopped — never free files under a possibly-live writer
    const stopped = await requestTaskStop(victimId);
    if (!stopped) {
      console.warn(`[LeaseManager] Deadlock victim ${victimId} could not be stopped — skipping resolution this tick`);
      continue;
    }

    await revertExclusiveFiles(victimId, victimExclusiveFiles);
    releaseLeases(victimId);
    clearWait(victimId);
    await updateTaskStatus(victimId, 'queued', null, 'leaseManager.deadlock_resolution');
    console.warn(`[LeaseManager] Deadlock resolved: stopped, reverted, and re-queued task ${victimId}`);
  }

  return cycles;
}
