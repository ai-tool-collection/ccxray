'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const anthropic = require('../server/wire-parsers/anthropic');
const { getParser } = require('../server/wire-parsers');

const FIXTURES = path.join(__dirname, 'fixtures', 'wire-parsers', 'anthropic');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('wire-parsers/index', () => {
  it('getParser returns anthropic parser', () => {
    const parser = getParser('anthropic');
    assert.ok(parser);
    assert.equal(typeof parser.extractUsage, 'function');
  });

  it('getParser returns null for unknown provider', () => {
    assert.equal(getParser('gemini'), null);
  });
});

describe('wire-parsers/anthropic', () => {
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
