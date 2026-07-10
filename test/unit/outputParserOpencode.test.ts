import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAgentOutput, usesJsonOutput } from '../../src/server/services/outputParser.js';

// Real captured samples from docs/OPENCODE_INTEGRATION_PLAN.md §10.2
const STEP_START =
  '{"type":"step_start","timestamp":1783674210712,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b448994001DePxZ3eI1G9Ih6","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","snapshot":"085fdb448bdee1ef1b3e351ce2daf1c9be204f51","type":"step-start"}}';

const TEXT_INSPECT =
  '{"type":"text","timestamp":1783674213973,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b4495b7001339ku33N8raqyz","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"text","text":"I\'ll inspect the README\'s current structure, then append the requested line with minimal formatting impact.","time":{"start":1783674213815,"end":1783674213966}}}';

const TOOL_USE_READ =
  '{"type":"tool_use","timestamp":1783674214112,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"type":"tool","tool":"read","callID":"call_UkyLHQVWF07jBQSvXNrBSpLc","state":{"status":"completed","input":{"filePath":"/private/tmp/opencode-spike/README.md"},"output":"<path>/private/tmp/opencode-spike/README.md</path>\\n<type>file</type>\\n<content>\\n1: # Spike Repo\\n\\n(End of file - total 1 lines)\\n</content>","title":"README.md","time":{"start":1783674214095,"end":1783674214107}}}}';

const STEP_FINISH_TOOL_CALLS =
  '{"type":"step_finish","timestamp":1783674214164,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b4497110017FnMTqcq8CrF6d","reason":"tool-calls","snapshot":"a767b7380d1bdf3ccad2dd7c38b5eb4eb6af5e34","messageID":"msg_f4b448107001zAtt9MmhpwMiah","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"step-finish","tokens":{"total":6383,"input":6316,"output":55,"reasoning":12,"cache":{"write":0,"read":0}},"cost":0}}';

const TOOL_USE_APPLY_PATCH =
  '{"type":"tool_use","timestamp":1783674218176,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"type":"tool","tool":"apply_patch","callID":"call_TaP4GTLCaONkczhRsXftEYti","state":{"status":"completed","input":{"patchText":"*** Begin Patch\\n*** Update File: README.md\\n@@\\n # Spike Repo\\n+\\n+hello from opencode spike\\n*** End Patch"},"output":"Success. Updated the following files:\\nM README.md","metadata":{"diff":"Index: /private/tmp/opencode-spike/README.md\\n===================================================================\\n--- /private/tmp/opencode-spike/README.md\\n+++ /private/tmp/opencode-spike/README.md\\n@@ -1,1 +1,3 @@\\n # Spike Repo\\n+\\n+hello from opencode spike\\n","files":[{"filePath":"/private/tmp/opencode-spike/README.md","relativePath":"README.md","type":"update","patch":"...","additions":2,"deletions":0}]},"title":"Success. Updated the following files:\\nM README.md","time":{"start":1783674218162,"end":1783674218173}}}}';

const TEXT_ADDED =
  '{"type":"text","timestamp":1783674220302,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b44acd1001WtuKT1vhb4QQZY","messageID":"msg_f4b44a723001TUjLLMFE0dqYiN","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"text","text":"Added `hello from opencode spike` to `README.md`.","time":{"start":1783674219729,"end":1783674220299}}}';

const STEP_FINISH_STOP =
  '{"type":"step_finish","timestamp":1783674220354,"sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","part":{"id":"prt_f4b44af40001fikoJmjQF1A9hr","reason":"stop","snapshot":"aba409ecb3f8c8aee23014e7b13bc31a86a867b9","messageID":"msg_f4b44a723001TUjLLMFE0dqYiN","sessionID":"ses_0b4bb7fa6ffet9zjs1NzqJsZKQ","type":"step-finish","tokens":{"total":6573,"input":412,"output":17,"reasoning":0,"cache":{"write":0,"read":6144}},"cost":0}}';

describe('parseAgentOutput (opencode)', () => {
  it('classifies step_start as a non-final status event', () => {
    const result = parseAgentOutput(STEP_START, 'opencode');
    assert.equal(result.type, 'status');
    assert.notEqual(result.isFinal, true);
  });

  it('classifies text events with the correct content', () => {
    const inspect = parseAgentOutput(TEXT_INSPECT, 'opencode');
    assert.equal(inspect.type, 'text');
    assert.equal(
      inspect.content,
      "I'll inspect the README's current structure, then append the requested line with minimal formatting impact."
    );

    const added = parseAgentOutput(TEXT_ADDED, 'opencode');
    assert.equal(added.type, 'text');
    assert.equal(added.content, 'Added `hello from opencode spike` to `README.md`.');
  });

  it('classifies tool_use events as status with a non-empty human-readable label', () => {
    const read = parseAgentOutput(TOOL_USE_READ, 'opencode');
    assert.equal(read.type, 'status');
    assert.equal(typeof read.content, 'string');
    assert.notEqual(read.content, '');

    const applyPatch = parseAgentOutput(TOOL_USE_APPLY_PATCH, 'opencode');
    assert.equal(applyPatch.type, 'status');
    assert.equal(typeof applyPatch.content, 'string');
    assert.notEqual(applyPatch.content, '');
  });

  it('treats step_finish with reason "tool-calls" as a non-final checkpoint', () => {
    const result = parseAgentOutput(STEP_FINISH_TOOL_CALLS, 'opencode');
    assert.notEqual(result.type, 'result');
    assert.notEqual(result.isFinal, true);
  });

  it('treats step_finish with reason "stop" as the final result', () => {
    const result = parseAgentOutput(STEP_FINISH_STOP, 'opencode');
    assert.equal(result.type, 'result');
    assert.equal(result.isFinal, true);
  });

  it('falls back to unknown for malformed JSON', () => {
    const result = parseAgentOutput('not json', 'opencode');
    assert.equal(result.type, 'unknown');
  });

  it('falls back to unknown for an empty line', () => {
    const result = parseAgentOutput('   ', 'opencode');
    assert.equal(result.type, 'unknown');
  });
});

describe('usesJsonOutput', () => {
  it('returns true for opencode', () => {
    assert.equal(usesJsonOutput('opencode'), true);
  });

  it('still returns true for claude (regression)', () => {
    assert.equal(usesJsonOutput('claude'), true);
  });

  it('still returns false for copilot (regression)', () => {
    assert.equal(usesJsonOutput('copilot'), false);
  });
});
