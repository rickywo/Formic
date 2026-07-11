#!/usr/bin/env node

/**
 * Audit the npm tarball file list against the allowlisted roots.
 *
 * Runs `npm pack --dry-run --json`, parses the file list, and exits non-zero
 * if any packed file falls outside the allowed directories / files.  The full
 * file list is printed to stdout so CI can capture it as a build artifact.
 *
 * Allowed roots (see `files` in package.json):
 *   dist/  src/client/  skills/  templates/  README.md  LICENSE  package.json
 *
 * Usage:
 *   node scripts/auditNpmPack.mjs
 *   node scripts/auditNpmPack.mjs --json   # print raw JSON instead of human-readable
 */

import { execFileSync } from 'node:child_process';

// Root may be overridden via --cwd <path> for testing; defaults to CWD.
const cwdArgIdx = process.argv.indexOf('--cwd');
const ROOT = cwdArgIdx >= 0 ? process.argv[cwdArgIdx + 1] : process.cwd();

// ---------------------------------------------------------------------------
// Allowlist — must match the `files` key in package.json exactly
// ---------------------------------------------------------------------------
const ALLOWED_ROOTS = new Set([
  'dist/',
  'src/client/',
  'skills/',
  'templates/',
  'README.md',
  'LICENSE',
  'package.json',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `npm pack --dry-run --json` from the repo root and return the parsed
 * JSON.  Throws on non-zero exit or unparseable output.
 */
function runNpmPack() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/**
 * Return true if `filePath` is allowed (starts with one of the allowed
 * directory prefixes or exactly matches an allowed root file).
 */
function isAllowed(filePath) {
  if (ALLOWED_ROOTS.has(filePath)) return true;
  for (const prefix of ALLOWED_ROOTS) {
    if (prefix.endsWith('/') && filePath.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outputJson = process.argv.includes('--json');

try {
  const result = runNpmPack();

  // npm pack --dry-run --json returns an array; first element is the package info
  const pkg = Array.isArray(result) ? result[0] : result;
  const files = pkg?.files ?? [];

  if (!Array.isArray(files)) {
    console.error('Unexpected npm pack output: missing files array');
    process.exit(2);
  }

  const paths = files.map((f) => f.path);
  const blocked = paths.filter((p) => !isAllowed(p));

  if (outputJson) {
    process.stdout.write(JSON.stringify({ files: paths, blocked }, null, 2) + '\n');
  } else {
    console.log(`\n📦 npm pack file audit (${paths.length} files total)\n`);
    for (const p of paths) {
      const status = isAllowed(p) ? '✅' : '❌';
      console.log(`  ${status}  ${p}`);
    }

    if (blocked.length > 0) {
      console.log(`\n❌ ${blocked.length} file(s) outside the allowlisted roots:\n`);
      for (const p of blocked) {
        console.log(`  - ${p}`);
      }
      console.log('\nAllowed roots:');
      for (const r of ALLOWED_ROOTS) {
        console.log(`  ${r}`);
      }
      console.log();
      process.exit(1);
    }

    console.log('\n✅ All files within allowlisted roots.\n');
  }
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.error('npm not found — is Node.js installed?');
    process.exit(2);
  }
  console.error(err.message || 'Unknown error during npm pack audit');
  process.exit(2);
}
