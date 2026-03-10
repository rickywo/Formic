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
import { getFormicDir } from '../utils/paths.js';
import { getTask, updateTaskStatus } from './store.js';
import { broadcastLeaseReleased } from './boardNotifier.js';
import { internalEvents, LEASE_RELEASED } from './internalEvents.js';

const execAsync = promisify(exec);

import { engineConfig } from './engineConfig.js';

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

  if (conflictingFiles.length > 0) {
    console.log(`[LeaseManager] Lease denied for task ${taskId}: conflicts on ${conflictingFiles.join(', ')}`);
    return { granted: false, leases: [], conflictingFiles };
  }

  // Grant all leases atomically
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

  // Check for conflicts on shared files against exclusive leases
  for (const filePath of sharedFiles) {
    const existing = leaseStore.get(filePath);
    if (existing && existing.taskId !== taskId && existing.leaseType === 'exclusive') {
      conflictingFiles.push(filePath);
    }
  }

  if (conflictingFiles.length > 0) {
    console.log(`[LeaseManager] Lease denied for task ${taskId}: conflicts on ${conflictingFiles.join(', ')}`);
    return { granted: false, leases: [], conflictingFiles };
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

  console.log(`[LeaseManager] Leases granted for task ${taskId}: ${exclusiveFiles.length} exclusive, ${sharedFiles.length} shared`);
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
    console.log(`[LeaseManager] Released ${released} lease(s) for task ${taskId}`);
    broadcastLeaseReleased(taskId, releasedFiles);
    internalEvents.emit(LEASE_RELEASED, taskId, releasedFiles);
  }

  // Clean up file hash records
  fileHashStore.delete(taskId);
  persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
}

/**
 * Renew all leases for a task by extending their expiration
 */
export function renewLeases(taskId: string, durationMs?: number): boolean {
  // Clean expired leases before renewing to avoid extending zombie leases
  cleanExpiredLeases();

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
    console.log(`[LeaseManager] Renewed ${renewed} lease(s) for task ${taskId}`);
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
 * Get all active leases
 */
export function getAllLeases(): FileLease[] {
  cleanExpiredLeases();
  return Array.from(leaseStore.values());
}

/**
 * Check if a file is currently leased (optionally excluding a specific task)
 */
export function isFileLeased(filePath: string, excludeTaskId?: string): boolean {
  cleanExpiredLeases();
  const lease = leaseStore.get(filePath);
  if (!lease) return false;
  if (excludeTaskId && lease.taskId === excludeTaskId) return false;
  return true;
}

/**
 * Clean up expired leases from the store
 */
function cleanExpiredLeases(): void {
  const now = Date.now();
  for (const [key, lease] of leaseStore.entries()) {
    if (new Date(lease.expiresAt).getTime() <= now) {
      leaseStore.delete(key);
    }
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
  console.log(`[LeaseManager] Recorded ${hashes.size} file hash(es) for task ${taskId}`);
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
    console.log(`[LeaseManager] Detected ${conflicts.length} collision(s) for task ${taskId}`);
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
    console.log(`[LeaseManager] Restored ${restored} non-expired lease(s) from disk`);
  } catch (err) {
    // File not found on first startup is expected
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!message.includes('ENOENT')) {
      console.warn('[LeaseManager] Failed to restore leases:', message);
    } else {
      console.log('[LeaseManager] No leases.json found — starting with empty lease store');
    }
  }
}

/**
 * Attempt to preempt an exclusive lease held by a lower-priority task.
 * Sets yieldSignal on the holder's lease and polls for voluntary release.
 * Force-releases after a 10 s timeout if the holder does not yield.
 * Returns true if preemption succeeded, false if not applicable.
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

  // Signal the holder to yield voluntarily
  holderLease.yieldSignal = true;
  console.log(`[LeaseManager] Sent yield signal to task ${holderId} for file ${targetFilePath}`);

  // Poll every 500 ms for up to 10 s
  const POLL_INTERVAL_MS = 500;
  const MAX_WAIT_MS = 10000;
  const deadline = Date.now() + MAX_WAIT_MS;

  await new Promise<void>(resolve => {
    const poll = setInterval(() => {
      if (!leaseStore.has(targetFilePath) || Date.now() >= deadline) {
        clearInterval(poll);
        resolve();
      }
    }, POLL_INTERVAL_MS);
  });

  if (leaseStore.has(targetFilePath)) {
    // Holder did not release voluntarily — force-release
    releaseLeases(holderId);
    console.warn(`[LeaseManager] Force-preempted lease on ${targetFilePath} from task ${holderId}`);
  } else {
    console.log(`[LeaseManager] Task ${holderId} voluntarily released ${targetFilePath} after yield signal`);
  }

  return true;
}

/**
 * Detect and resolve deadlock cycles in the wait-for graph.
 * Resolves each cycle by re-queuing the lowest-priority task in the cycle.
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

    releaseLeases(victimId);
    clearWait(victimId);
    await updateTaskStatus(victimId, 'queued', null, 'leaseManager.deadlock_resolution');
    console.warn(`[LeaseManager] Deadlock resolved: aborted task ${victimId}`);
  }

  return cycles;
}
