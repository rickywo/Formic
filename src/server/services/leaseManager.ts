/**
 * Lease Manager Service
 * Provides atomic all-or-nothing file lease acquisition, renewal, and release
 * for lease-based concurrency control of parallel task execution.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileLease, LeaseRequest, LeaseResult, FileConflict } from '../../types/index.js';

const execAsync = promisify(exec);

const LEASE_DURATION_MS = parseInt(process.env.LEASE_DURATION_MS || '300000', 10); // 5 min default

/** In-memory lease store: filePath → FileLease */
const leaseStore = new Map<string, FileLease>();

/** Recorded file hashes for collision detection: taskId → Map<filePath, hash> */
const fileHashStore = new Map<string, Map<string, string>>();

/**
 * Acquire file leases atomically (all-or-nothing).
 * If any exclusive file is already leased by another task, the entire request is denied.
 * Shared files are not exclusively locked.
 */
export function acquireLeases(request: LeaseRequest): LeaseResult {
  const { taskId, exclusiveFiles, sharedFiles } = request;
  const durationMs = request.leaseDurationMs ?? LEASE_DURATION_MS;
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
  return { granted: true, leases: grantedLeases, conflictingFiles: [] };
}

/**
 * Release all leases held by a task
 */
export function releaseLeases(taskId: string): void {
  let released = 0;
  for (const [key, lease] of leaseStore.entries()) {
    if (lease.taskId === taskId) {
      leaseStore.delete(key);
      released++;
    }
  }
  if (released > 0) {
    console.log(`[LeaseManager] Released ${released} lease(s) for task ${taskId}`);
  }

  // Clean up file hash records
  fileHashStore.delete(taskId);
}

/**
 * Renew all leases for a task by extending their expiration
 */
export function renewLeases(taskId: string, durationMs?: number): boolean {
  // Clean expired leases before renewing to avoid extending zombie leases
  cleanExpiredLeases();

  const extension = durationMs ?? LEASE_DURATION_MS;
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
