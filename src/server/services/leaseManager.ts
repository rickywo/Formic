/**
 * Lease Manager Service
 * Provides atomic all-or-nothing file lease acquisition, renewal, and release
 * for lease-based concurrency control of parallel task execution.
 * Includes priority preemption, deadlock detection, and disk persistence.
 */

import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { FileLease, LeaseRequest, LeaseResult, FileConflict, LeaseStoreSnapshot } from '../../types/index.js';
import { getFormicDir } from '../utils/paths.js';
import { getTask } from './store.js';
import { teardownTask } from './taskTeardown.js';
import { broadcastLeaseReleased } from './boardNotifier.js';
import { internalEvents, LEASE_RELEASED } from './internalEvents.js';
import { hashWorkspaceFile } from '../utils/safeGit.js';

import { engineConfig } from './engineConfig.js';

/** In-memory lease store: filePath → FileLease */
const leaseStore = new Map<string, FileLease>();

/** Recorded file hashes for collision detection: taskId → Map<filePath, hash> */
const fileHashStore = new Map<string, Map<string, string>>();

/** Wait-for map: taskId → set of filePaths the task is waiting to acquire */
const waitForMap = new Map<string, Set<string>>();

/** Async write mutex — serializes lease snapshots and preserves call order. */
let persistLock: Promise<void> = Promise.resolve();

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
  const conflictingFiles = new Set<string>();
  for (const filePath of exclusiveFiles) {
    const existing = leaseStore.get(filePath);
    if (existing && existing.taskId !== taskId) {
      conflictingFiles.add(filePath);
      continue;
    }
    // Also check for shared leases on this file held by other tasks
    for (const [key, lease] of leaseStore.entries()) {
      if (key.startsWith(`${filePath}::`) && lease.taskId !== taskId) {
        conflictingFiles.add(filePath);
        break;
      }
    }
  }

  // Check for conflicts on shared files against exclusive leases
  for (const filePath of sharedFiles) {
    const existing = leaseStore.get(filePath);
    if (existing && existing.taskId !== taskId && existing.leaseType === 'exclusive') {
      conflictingFiles.add(filePath);
    }
  }

  if (conflictingFiles.size > 0) {
    const conflicts = [...conflictingFiles];
    console.warn(`[LeaseManager] Lease denied for task ${taskId}: conflicts on ${conflicts.join(', ')}`);
    return { granted: false, leases: [], conflictingFiles: conflicts };
  }

  // Grant only after every requested file has passed conflict validation.
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
 * Renew all leases for a task by extending their expiration
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
    persistLeases().catch(e => console.warn('[LeaseManager] persist error:', e));
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
 * Get the task ID that holds an exclusive lease on a file, or null if none.
 * Used to identify zombie lease holders.
 */
export function getExclusiveLeaseHolder(filePath: string): string | null {
  cleanExpiredLeases();
  const lease = leaseStore.get(filePath);
  if (lease && lease.leaseType === 'exclusive') {
    return lease.taskId;
  }
  return null;
}

/**
 * Resolve ALL task IDs currently holding a lease on a file — both the
 * bare-key exclusive holder and every scoped-key shared holder
 * (`${filePath}::${taskId}`).  Used by `detectDeadlock()` to build a
 * complete wait-for graph including shared-lease participants.
 */
export function getFileHolders(filePath: string): Set<string> {
  cleanExpiredLeases();
  const holders = new Set<string>();

  // Exclusive holder (bare key)
  const exclusiveLease = leaseStore.get(filePath);
  if (exclusiveLease && exclusiveLease.leaseType === 'exclusive') {
    holders.add(exclusiveLease.taskId);
  }

  // Shared holders (scoped keys)
  const prefix = `${filePath}::`;
  for (const [key, lease] of leaseStore.entries()) {
    if (key.startsWith(prefix)) {
      holders.add(lease.taskId);
    }
  }

  return holders;
}

/**
 * Clean up expired leases from the store.
 *
 * IMPORTANT: This path is called from hot read paths (getAllLeases, isFileLeased,
 * acquireLeases), so the persist must only fire when something was actually deleted.
 *
 * POLICY CHOICE (see Issue 9 in docs/REMEDIATION_PLAN.md): we deliberately do NOT
 * emit LEASE_RELEASED from this cleanup path. The watchdog's scanExpiredLeases
 * relies on getExpiredLeases() + its stop/revert/re-queue teardown sequence —
 * emitting LEASE_RELEASED here would wake waiters before the holder's files are
 * reverted. Persist-only keeps the disk truthful without racing the watchdog.
 */
function cleanExpiredLeases(): void {
  const now = Date.now();
  let deleted = false;
  for (const [key, lease] of leaseStore.entries()) {
    if (new Date(lease.expiresAt).getTime() <= now) {
      leaseStore.delete(key);
      deleted = true;
    }
  }
  if (deleted) {
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
      const hash = await hashWorkspaceFile(filePath, cwd);
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
      const actualHash = await hashWorkspaceFile(filePath, cwd);
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
 * Register that a task is waiting to acquire leases on one or more files.
 * Used to build the wait-for graph for deadlock detection.
 */
export function recordWait(taskId: string, filePaths: string[]): void {
  waitForMap.set(taskId, new Set(filePaths));
}

/**
 * Unregister a task's wait record once it acquires or abandons the lease.
 */
export function clearWait(taskId: string): void {
  waitForMap.delete(taskId);
}

/**
 * Read-only inspection helper: returns a snapshot of the current wait-for map
 * (taskId -> filePaths it is waiting on). Added strictly for repro/diagnostic
 * tooling — does not alter any behavior of recordWait/clearWait/detectDeadlock.
 */
export function getWaitForEntries(): Array<{ taskId: string; filePaths: string[] }> {
  return Array.from(waitForMap.entries()).map(([taskId, filePaths]) => ({
    taskId,
    filePaths: [...filePaths],
  }));
}

/**
 * Persist the current leaseStore to .formic/leases.json.
 * Fire-and-forget — callers should .catch() the returned promise.
 */
export async function persistLeases(): Promise<void> {
  const resultPromise = persistLock.then(async () => {
    const snapshot: LeaseStoreSnapshot = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      leases: Array.from(leaseStore.entries()).map(([key, lease]) => ({ key, lease })),
    };
    const formicDir = getFormicDir();
    const leasesPath = path.join(formicDir, 'leases.json');
    const tmpPath = `${leasesPath}.tmp`;
    await mkdir(formicDir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    await rename(tmpPath, leasesPath);
  });

  persistLock = resultPromise.catch(() => {});
  return resultPromise;
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
 * Attempt to preempt an exclusive lease held by a lower-priority task.
 * Tears down the holder (stops its process, reverts files, releases leases, re-queues)
 * so the higher-priority requester can acquire the lease.
 * Returns true if preemption was attempted, false if not applicable.
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

  // Tear down the holder: stop its process, revert files, release leases, re-queue.
  console.warn(`[LeaseManager] Preempting lease on ${targetFilePath} from task ${holderId} (priority ${holderRank} < ${requesterRank})`);
  await teardownTask(holderId, 'preemption');

  return true;
}

/**
 * Detect and resolve deadlock cycles in the wait-for graph.
 *
 * Graph construction:
 *   For every (taskId, filePaths) entry in waitForMap, resolve ALL current
 *   holders of each file via `getFileHolders()` (which covers both exclusive
 *   bare-key and shared scoped-key leases).  An edge taskId → holder is only
 *   added when the holder is not the waiting task itself and the holder still
 *   actually holds a lease on that file.
 *
 * Cycle detection:
 *   Iterative white/grey/black DFS over the directed multi-edge wait graph.
 *   A cycle is collected when the DFS reaches a GREY (in-stack) node.
 *   Distinct cycles are deduplicated by a sorted-members key.
 *
 * Resolution:
 *   The lowest-priority task in each distinct cycle is torn down via
 *   `teardownTask()`.  After resolution, stale waitForMap entries of
 *   survivors are cleaned up — any file whose current holders set is empty
 *   (the lease was released) is removed from the survivor's wait set, and
 *   survivors with an empty wait set are cleared entirely.
 *
 * Returns the detected cycle arrays, or null if no cycles were found.
 */
export async function detectDeadlock(): Promise<string[][] | null> {
  if (waitForMap.size === 0) return null;

  // ---- Build directed wait graph: waitingTaskId → Set<holderTaskId> ----
  const waitGraph = new Map<string, Set<string>>();

  for (const [waitingTaskId, filePaths] of waitForMap.entries()) {
    const holders = new Set<string>();
    for (const filePath of filePaths) {
      for (const holderId of getFileHolders(filePath)) {
        if (holderId !== waitingTaskId) {
          holders.add(holderId);
        }
      }
    }
    if (holders.size > 0) {
      waitGraph.set(waitingTaskId, holders);
    }
  }

  if (waitGraph.size === 0) return null;

  // ---- White/grey DFS cycle detection (no BLACK — reset on backtrack) ----
  // We reset nodes to WHITE on backtrack so every distinct simple cycle is
  // found even when cycles share nodes (e.g. A→B→A and A→C→B→A).
  // Deduplication by sorted-members key prevents duplicate reporting.
  const GREY = 1;
  const WHITE = 0;

  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  for (const startNode of waitGraph.keys()) {
    const color = new Map<string, number>();
    const path: string[] = [];

    function dfs(node: string): void {
      color.set(node, GREY);
      path.push(node);

      const neighbors = waitGraph.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          const neighborColor = color.get(neighbor) ?? WHITE;
          if (neighborColor === GREY) {
            // Back edge — collect the cycle
            const cycleStart = path.indexOf(neighbor);
            if (cycleStart >= 0) {
              const cycle = path.slice(cycleStart);
              const dedupKey = [...cycle].sort().join(',');
              if (!seenCycleKeys.has(dedupKey)) {
                seenCycleKeys.add(dedupKey);
                cycles.push(cycle);
              }
            }
          } else if (neighborColor === WHITE) {
            dfs(neighbor);
          }
        }
      }

      path.pop();
      color.set(node, WHITE); // Reset so other paths can re-enter this node
    }

    dfs(startNode);
  }

  if (cycles.length === 0) return null;

  console.warn(`[LeaseManager] Detected ${cycles.length} deadlock cycle(s)`);

  // ---- Resolve each distinct cycle ----
  for (const cycle of cycles) {
    // Choose victim: lowest-priority task in the cycle
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

    await teardownTask(victimId, 'deadlock_resolution');
    console.warn(`[LeaseManager] Deadlock resolved: aborted task ${victimId}`);

    // ---- Survivor cleanup: remove stale wait-for entries ----
    for (const survivorId of cycle) {
      if (survivorId === victimId) continue;

      const survivorWaitFiles = waitForMap.get(survivorId);
      if (!survivorWaitFiles) continue;

      // Remove files whose holders are now gone
      const staleFiles: string[] = [];
      for (const fp of survivorWaitFiles) {
        const holders = getFileHolders(fp);
        // A file is stale if no holder remains, or the only holder was the victim
        if (holders.size === 0) {
          staleFiles.push(fp);
        }
      }

      for (const fp of staleFiles) {
        survivorWaitFiles.delete(fp);
      }

      if (survivorWaitFiles.size === 0) {
        waitForMap.delete(survivorId);
        console.warn(`[LeaseManager] Cleared stale wait entry for survivor ${survivorId}`);
      } else if (staleFiles.length > 0) {
        console.warn(
          `[LeaseManager] Removed ${staleFiles.length} stale file(s) from survivor ${survivorId}'s wait set`
        );
      }
    }
  }

  return cycles;
}
