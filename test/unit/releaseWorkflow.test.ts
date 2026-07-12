import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'release.yml');

describe('release workflow guardrails', () => {
  let workflow = '';

  before(async () => {
    workflow = await readFile(WORKFLOW_PATH, 'utf-8');
  });

  it('validates a strict semver tag against package.json before publishing', () => {
    assert.match(workflow, /validate-release:/);
    assert.match(workflow, /expected v<semver>/);
    assert.match(workflow, /Release version mismatch: tag=/);
    assert.match(workflow, /PACKAGE_VERSION=.*package\.json/);
  });

  it('makes every publishing job depend on release validation', () => {
    for (const job of ['npm-publish', 'docker', 'devcontainer']) {
      const start = workflow.indexOf(`\n  ${job}:`);
      assert.notEqual(start, -1, `missing ${job} job`);
      const remainder = workflow.slice(start + 1);
      const nextJobMatch = /\n  [a-z][a-z0-9-]*:\n/g.exec(remainder.slice(job.length + 3));
      const end = nextJobMatch
        ? start + 1 + job.length + 3 + nextJobMatch.index
        : workflow.length;
      const section = workflow.slice(start, end);
      assert.match(section, /needs: \[[^\]]*validate-release/);
    }
  });
});
