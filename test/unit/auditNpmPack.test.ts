import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'auditNpmPack.mjs');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'formic-audit-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Run the audit script in a given working directory and return the exit code,
 * stdout, and stderr.
 */
function runAudit(cwd: string, extraArgs: string[] = []): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [AUDIT_SCRIPT, '--cwd', cwd, ...extraArgs], {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: (e.stdout as string) ?? '',
      stderr: (e.stderr as string) ?? '',
    };
  }
}

describe('auditNpmPack', () => {
  it('passes on a clean allowlisted file list', () => {
    // Run from the real repo root — the current package.json files whitelist
    // is clean, so the script should exit 0.
    const { code, stdout } = runAudit(REPO_ROOT);
    assert.equal(code, 0, `Expected exit 0, got ${code}\n${stdout}`);
    assert.match(stdout, /All files within allowlisted roots/);
  });

  it('fails when a file outside the allowlisted roots appears', async () => {
    // Build a minimal npm package where the `files` whitelist in package.json
    // includes a directory (config/) that is NOT in the audit script's
    // ALLOWED_ROOTS set.  This simulates someone adding a new root to the
    // package.json files whitelist without updating the audit allowlist.
    const pkgJson = {
      name: 'test-audit-fail',
      version: '1.0.0',
      // config/ is deliberately NOT in the audit ALLOWED_ROOTS
      files: ['dist/', 'skills/', 'config/'],
    };
    await writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(pkgJson, null, 2),
    );

    for (const dir of ['dist', 'skills', 'config']) {
      await mkdir(path.join(tempDir, dir), { recursive: true });
      await writeFile(path.join(tempDir, dir, '.gitkeep'), '');
    }

    const { code, stdout } = runAudit(tempDir);
    assert.notEqual(code, 0, `Expected non-zero exit, got ${code}\n${stdout}`);
    assert.match(stdout, /outside the allowlisted roots/);
    assert.match(stdout, /config/);
  });

  it('prints JSON output with --json flag', () => {
    const { code, stdout } = runAudit(REPO_ROOT, ['--json']);
    assert.equal(code, 0, `Expected exit 0, got ${code}`);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.files), 'Expected files array in JSON output');
    assert.ok(Array.isArray(parsed.blocked), 'Expected blocked array in JSON output');
    assert.equal(parsed.blocked.length, 0, 'Expected zero blocked files in clean repo');
  });
});
