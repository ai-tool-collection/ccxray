'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const anthropic = require('../server/wire-parsers/anthropic');
const { getParser, safeCall, SAFE_DEFAULTS } = require('../server/wire-parsers');

const FIXTURES = path.join(__dirname, 'fixtures', 'wire-parsers', 'anthropic');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('wire-parsers/index', () => {
  it('getParser returns anthropic parser', () => {
    const parser = getParser('anthropic');
    assert.ok(parser);
    assert.equal(typeof parser.dedupExtract, 'function');
    assert.equal(typeof parser.extractUsage, 'function');
  });

  it('getParser returns null for unknown provider', () => {
    assert.equal(getParser('gemini'), null);
  });

  it('safeCall returns fallback on error', () => {
    const badParser = { boom() { throw new Error('kaboom'); } };
    const result = safeCall(badParser, 'boom', [], 'fallback-value');
    assert.equal(result, 'fallback-value');
  });

  it('safeCall returns fallback when method missing', () => {
    const result = safeCall({}, 'nonexistent', [], 'fb');
    assert.equal(result, 'fb');
  });

  it('safeCall uses SAFE_DEFAULTS when no explicit fallback', () => {
    const badParser = { extractUsage() { throw new Error('fail'); } };
    const result = safeCall(badParser, 'extractUsage', [null]);
    assert.equal(result, SAFE_DEFAULTS.extractUsage);
  });
});

describe('wire-parsers/anthropic', () => {
  describe('dedupExtract', () => {
    it('extracts sysHash and toolsHash from request body', () => {
      const req = loadFixture('turn1_req.json');
      const result = anthropic.dedupExtract(req);

      assert.ok(result.sysHash, 'should have sysHash');
      assert.ok(result.toolsHash, 'should have toolsHash');
      assert.equal(result.sysHash.length, 12);
      assert.equal(result.toolsHash.length, 12);
      assert.ok(result.sharedFiles.length >= 2, 'should have at least sys + tools shared files');
      assert.ok(result.sharedFiles.some(f => f.name.startsWith('sys_')));
      assert.ok(result.sharedFiles.some(f => f.name.startsWith('tools_')));
    });

    it('returns stable hashes for same input', () => {
      const req = loadFixture('turn1_req.json');
      const r1 = anthropic.dedupExtract(req);
      const r2 = anthropic.dedupExtract(req);
      assert.equal(r1.sysHash, r2.sysHash);
      assert.equal(r1.toolsHash, r2.toolsHash);
    });

    it('handles missing system/tools gracefully', () => {
      const result = anthropic.dedupExtract({ model: 'test', messages: [] });
      assert.equal(result.sysHash, null);
      assert.equal(result.toolsHash, null);
      assert.deepEqual(result.sharedFiles, []);
    });

    it('computes coreHash when B2 is long enough', () => {
      const req = loadFixture('turn1_req.json');
      // Our fixture B2 is short — coreHash should be null
      const result = anthropic.dedupExtract(req);
      assert.equal(result.coreHash, null, 'short B2 should not produce coreHash');

      // Longer B2
      const longReq = JSON.parse(JSON.stringify(req));
      longReq.system[2].text = 'A'.repeat(600);
      const longResult = anthropic.dedupExtract(longReq);
      assert.ok(longResult.coreHash, 'long B2 should produce coreHash');
      assert.equal(longResult.coreHash.length, 12);
    });
  });

  describe('extractDeltaSlice', () => {
    it('returns full write when no prevState', () => {
      const req = loadFixture('turn1_req.json');
      const result = anthropic.extractDeltaSlice(null, { id: 't1', parsedBody: req, sysHash: 'abc', toolsHash: 'def' });
      assert.ok(result.stripped);
      assert.ok(!result.stripped.prevId, 'first turn should not have prevId');
      assert.ok(result.stripped.messages);
      assert.deepEqual(result.trackingState, { id: 't1', messages: req.messages, deltaCount: 0 });
    });

    it('produces delta when messages share prefix', () => {
      const turn1 = loadFixture('turn1_req.json');
      const turn2 = loadFixture('turn2_req.json');
      const prevState = { id: 't1', messages: turn1.messages, deltaCount: 0 };
      const result = anthropic.extractDeltaSlice(prevState, { id: 't2', parsedBody: turn2, sysHash: 'abc', toolsHash: 'def' });

      assert.ok(result.stripped);
      if (turn2.messages.length > turn1.messages.length) {
        assert.equal(result.stripped.prevId, 't1');
        assert.ok(result.stripped.msgOffset >= 2, 'should share at least 2 messages');
        assert.ok(result.stripped.messages.length < turn2.messages.length, 'delta should have fewer messages');
        assert.ok(result.trackingState.deltaCount > 0);
      }
    });

    it('forces full write when snapshot interval reached', () => {
      const req = loadFixture('turn1_req.json');
      const prevState = { id: 't0', messages: req.messages, deltaCount: 5 };
      const result = anthropic.extractDeltaSlice(prevState, { id: 't1', parsedBody: req, sysHash: 'a', toolsHash: 'b' }, { snapshotInterval: 5 });
      assert.ok(!result.stripped.prevId, 'should force full when snapshot interval reached');
      assert.equal(result.trackingState.deltaCount, 0);
    });
  });

  describe('isNoiseRequest', () => {
    it('always returns false for Anthropic', () => {
      assert.equal(anthropic.isNoiseRequest('/v1/messages', {}, {}), false);
      assert.equal(anthropic.isNoiseRequest('/v1/plugins/list', {}, {}), false);
    });
  });

  describe('extractUsage', () => {
    it('extracts usage from SSE events', () => {
      const events = loadFixture('turn1_res.json');
      const usage = anthropic.extractUsage(events);
      assert.ok(usage);
      assert.equal(usage.input_tokens, 1200);
      assert.equal(usage.output_tokens, 42);
      assert.equal(usage.cache_creation_input_tokens, 500);
      assert.equal(usage.cache_read_input_tokens, 200);
    });

    it('returns null for non-array input', () => {
      assert.equal(anthropic.extractUsage(null), null);
      assert.equal(anthropic.extractUsage('string'), null);
      assert.equal(anthropic.extractUsage({}), null);
    });

    it('returns zeros when usage fields missing', () => {
      const events = [{ type: 'message_start', message: { usage: {} } }];
      const usage = anthropic.extractUsage(events);
      assert.equal(usage.input_tokens, 0);
      assert.equal(usage.output_tokens, 0);
    });
  });

  describe('extractAgentType', () => {
    it('identifies orchestrator from B1', () => {
      const sys = [
        { text: 'config' },
        { text: 'You are Claude Code, Anthropic\'s official CLI.' },
      ];
      const result = anthropic.extractAgentType(sys);
      assert.equal(result.key, 'orchestrator');
    });

    it('identifies known agent from B2 prefix', () => {
      const sys = [
        { text: 'config' },
        { text: 'branding' },
        { text: 'You are a file search specialist for locating code.' },
      ];
      const result = anthropic.extractAgentType(sys);
      assert.equal(result.key, 'explore');
    });

    it('returns unknown for non-array', () => {
      const result = anthropic.extractAgentType(null);
      assert.equal(result.key, 'unknown');
    });
  });

  describe('normalizeListMeta', () => {
    it('produces ThinCanonical from entry object', () => {
      const entry = {
        id: 'test-1', ts: '2026-01-01T00:00:00Z', model: 'claude-sonnet-4-20250514',
        sessionId: 'sess-1', msgCount: 3, toolCount: 2,
        usage: { input_tokens: 100, output_tokens: 50 }, cost: { cost: 0.001 },
        agentType: 'orchestrator', agentLabel: 'Orchestrator',
        isSubagent: false, stopReason: 'end_turn', status: 200, elapsed: 1500,
      };
      const meta = anthropic.normalizeListMeta(entry);
      assert.equal(meta.provider, 'anthropic');
      assert.equal(meta.model, 'claude-sonnet-4-20250514');
      assert.equal(meta.sessionId, 'sess-1');
      assert.equal(meta.msgCount, 3);
      assert.equal(meta.agentType, 'orchestrator');
    });

    it('infers msgCount from req when entry field missing', () => {
      const entry = { id: 't', ts: 'x', req: { messages: [{}, {}, {}] }, status: 200, elapsed: 0 };
      const meta = anthropic.normalizeListMeta(entry);
      assert.equal(meta.msgCount, 3);
    });
  });

  describe('detectSession', () => {
    it('is a function that delegates to store', () => {
      assert.equal(typeof anthropic.detectSession, 'function');
      // Full integration of detectSession requires store state;
      // tested via integration tests in Phase 6
    });
  });
});
