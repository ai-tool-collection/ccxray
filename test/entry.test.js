'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_FIELDS, buildIndexLine } = require('../server/entry');

const EXCLUDED = ['req','res','tokens','duplicateToolCalls','method','url','_loaded','_writePromise','_loadingPromise'];

test('buildIndexLine projects only INDEX_FIELDS, drops excluded + undefined', () => {
  const entry = {
    id: 'X', ts: '00:00:00', sessionId: 's', provider: 'openai', agent: 'codex',
    model: 'gpt-5.5', msgCount: 3, toolCount: 1, toolCalls: { Bash: 1 },
    isSubagent: false, sessionInferred: false, cwd: '/p', isSSE: true,
    usage: { input_tokens: 10 }, cost: { cost: 0.09 }, maxContext: 400000,
    responseMetadata: { transport: 'http' }, stopReason: 'completed', title: 't',
    thinkingDuration: null, toolFail: false, elapsed: '1.0', status: 200,
    receivedAt: 1, sysHash: null, toolsHash: null, coreHash: null,
    thinkingStripped: undefined, hasCredential: undefined, toolSources: undefined,
    // excluded / extra:
    req: { big: 1 }, res: [1,2,3], tokens: { total: 99 }, duplicateToolCalls: null,
    method: 'POST', url: '/v1/responses', _loaded: true, _writePromise: Promise.resolve(),
  };
  const obj = JSON.parse(buildIndexLine(entry));
  for (const k of EXCLUDED) assert.ok(!(k in obj), `excluded key leaked: ${k}`);
  assert.equal(obj.cost.cost, 0.09);
  assert.equal(obj.maxContext, 400000);
  for (const k of Object.keys(obj)) assert.ok(INDEX_FIELDS.includes(k), `non-INDEX key: ${k}`);
});
