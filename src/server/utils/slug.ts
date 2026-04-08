/**
 * Generate a URL-friendly slug from a title
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Truncate to max 30 characters
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')          // Replace spaces with hyphens
    .replace(/-+/g, '-')           // Remove consecutive hyphens
    .replace(/^-|-$/g, '')         // Remove leading/trailing hyphens
    .slice(0, 30);                 // Truncate to 30 chars
}

/**
 * Convert an arbitrary string into a URL-friendly slug (no truncation)
 * - Lowercase all characters
 * - Replace whitespace with hyphens
 * - Strip non-alphanumeric, non-hyphen characters
 * - Collapse consecutive hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
