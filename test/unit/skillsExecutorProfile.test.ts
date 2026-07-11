import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyOpenCodeExecutorProfile } from '../../src/server/services/skills.js';
import { setWorkspacePath } from '../../src/server/utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_PATH = path.resolve(__dirname, '..', '..', 'templates', 'opencode-executor-agent.md');

let tempDir: string;
let savedWorkspace: string | undefined;

beforeEach(() => {
  savedWorkspace = process.env.WORKSPACE_PATH;
  tempDir = path.join(os.tmpdir(), `formic-test-executor-${Math.random().toString(36).slice(2, 10)}`);
  process.env.WORKSPACE_PATH = tempDir;
  setWorkspacePath(tempDir);
});

afterEach(async () => {
  if (savedWorkspace === undefined) {
    delete process.env.WORKSPACE_PATH;
  } else {
    process.env.WORKSPACE_PATH = savedWorkspace;
    setWorkspacePath(savedWorkspace);
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe('OpenCode executor profile', () => {
  it('is a primary profile with nested allow permissions and no model override', async () => {
    const content = await readFile(TEMPLATE_PATH, 'utf-8');

    assert.match(content, /^mode: primary$/m);
    assert.match(content, /^permission:\n  edit: allow\n  bash: allow\n  task: allow\n  todowrite: allow$/m);
    assert.doesNotMatch(content, /^model:/m);
    assert.doesNotMatch(content, /^edit: allow$/m);
  });

  it('replaces a stale workspace profile with the bundled template', async () => {
    const first = await copyOpenCodeExecutorProfile();
    assert.equal(first.copied, true);

    const targetFile = path.join(tempDir, '.opencode', 'agent', 'formic-executor.md');
    assert.ok(existsSync(targetFile));
    await writeFile(targetFile, '---\nname: formic-executor\nmodel: inherit\n---\nStale body\n', 'utf-8');

    const result = await copyOpenCodeExecutorProfile();
    assert.equal(result.copied, true);
    assert.equal(await readFile(targetFile, 'utf-8'), await readFile(TEMPLATE_PATH, 'utf-8'));
  });
});
