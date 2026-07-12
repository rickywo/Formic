import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Security Utilities
 *
 * Shared helpers for constant-time credential comparison.
 */

/**
 * Compare two strings in constant time.
 *
 * Both sides are hashed with sha256 first so the buffers passed to
 * `timingSafeEqual` always have equal length — a plain `timingSafeEqual`
 * throws on length mismatch, and a naive `===` comparison leaks timing
 * information about how many leading characters match.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
