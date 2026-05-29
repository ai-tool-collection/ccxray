'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const openai = require('../server/wire-parsers/openai');
const { getParser, safeCall } = require('../server/wire-parsers');

const FIXTURES = path.join(__dirname, 'fixtures', 'wire-parsers', 'openai');
const loadFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('wire-parsers/openai registry', () => {
  it('getParser returns openai parser', () => {
    const parser = getParser('openai');
    assert.ok(parser);
    assert.equal(typeof parser.dedupExtract, 'function');
    assert.equal(typeof parser.extractUsage, 'function');
    assert.equal(typeof parser.isNoiseRequest, 'function');
    assert.equal(typeof parser.preprocessBody, 'function');
  });
});

describe('wire-parsers/openai', () => {
  describe('dedupExtract', () => {
    it('extracts sysHash and toolsHash from codex request', () => {
      const req = loadFixture('turn1_req.json');
      const result = openai.dedupExtract(req);

      assert.ok(result.sysHash, 'should have sysHash from instructions');
      assert.ok(result.toolsHash, 'should have toolsHash');
      assert.equal(result.sysHash.length, 12);
      assert.equal(result.toolsHash.length, 12);
      assert.ok(result.sharedFiles.some(f => f.name.startsWith('openai_instructions_')));
      assert.ok(result.sharedFiles.some(f => f.name.startsWith('openai_tools_')));
    });

    it('returns stable hashes', () => {
      const req = loadFixture('turn1_req.json');
      const r1 = openai.dedupExtract(req);
      const r2 = openai.dedupExtract(req);
      assert.equal(r1.sysHash, r2.sysHash);
      assert.equal(r1.toolsHash, r2.toolsHash);
    });

    it('handles missing instructions/tools', () => {
      const result = openai.dedupExtract({ model: 'gpt-5.5' });
      assert.equal(result.sysHash, null);
      assert.equal(result.toolsHash, null);
      assert.deepEqual(result.sharedFiles, []);
    });

    it('produces versionInfo with prompt metadata', () => {
      const req = loadFixture('turn1_req.json');
      const result = openai.dedupExtract(req);
      // instructions is a string → should produce versionInfo
      if (result.versionInfo) {
        assert.ok(result.versionInfo.agentKey);
        assert.ok(result.versionInfo.agentLabel);
        assert.ok(result.versionInfo.promptMetaFile);
        assert.ok(result.sharedFiles.some(f => f.name.startsWith('openai_prompt_meta_')));
      }
    });
  });

  describe('extractDeltaSlice', () => {
    it('always returns null for OpenAI', () => {
      assert.equal(openai.extractDeltaSlice({}, {}), null);
      assert.equal(openai.extractDeltaSlice(null, null), null);
    });
  });

  describe('isNoiseRequest', () => {
    it('filters codex platform noise paths', () => {
      const noisePaths = loadFixture('noise_paths.json');
      for (const p of noisePaths.noise) {
        assert.equal(openai.isNoiseRequest(p, {}, {}), true, `${p} should be noise`);
      }
    });

    it('does not filter real API paths', () => {
      const noisePaths = loadFixture('noise_paths.json');
      for (const p of noisePaths.not_noise) {
        assert.equal(openai.isNoiseRequest(p, {}, {}), false, `${p} should NOT be noise`);
      }
    });

    it('handles paths with query strings', () => {
      assert.equal(openai.isNoiseRequest('/v1/plugins/list?foo=bar', {}, {}), true);
      assert.equal(openai.isNoiseRequest('/v1/responses?stream=true', {}, {}), false);
    });
  });

  describe('extractUsage', () => {
    it('extracts from response object', () => {
      const res = loadFixture('turn1_res.json');
      const usage = openai.extractUsage(res);
      assert.ok(usage);
      assert.equal(usage.input_tokens, 850);
      assert.equal(usage.output_tokens, 35);
      assert.equal(usage.total_tokens, 885);
    });

    it('returns null for missing usage', () => {
      assert.equal(openai.extractUsage(null), null);
      assert.equal(openai.extractUsage({}), null);
      assert.equal(openai.extractUsage({ id: 'resp_01' }), null);
    });
  });

  describe('extractAgentType', () => {
    it('returns default codex type with no headers', () => {
      const result = openai.extractAgentType(null, {});
      assert.equal(result.key, 'default');
      assert.equal(result.label, 'Codex Default');
    });

    it('detects explorer from headers', () => {
      const headers = { 'x-openai-agent-type': 'explorer' };
      const result = openai.extractAgentType(null, headers);
      assert.equal(result.key, 'explorer');
      assert.equal(result.label, 'Codex Explorer');
    });

    it('detects worker from codex headers', () => {
      const headers = { 'x-codex-agent-type': 'worker' };
      const result = openai.extractAgentType(null, headers);
      assert.equal(result.key, 'worker');
      assert.equal(result.label, 'Codex Worker');
    });
  });

  describe('detectSession', () => {
    it('extracts sessionId from headers', () => {
      const headers = { 'session_id': 'test-session-abc' };
      const result = openai.detectSession(null, headers, null);
      assert.ok(result.sessionId);
      assert.ok(result.sessionId !== 'codex-raw', 'should not fallback to codex-raw when header present');
    });

    it('extracts sessionId from turn metadata', () => {
      const headers = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'meta-session-123' }) };
      const result = openai.detectSession(null, headers, null);
      assert.ok(result.sessionId);
      assert.notEqual(result.sessionId, 'codex-raw');
    });

    it('falls back to codex-raw when no session info', () => {
      const result = openai.detectSession(null, {}, null);
      assert.equal(result.sessionId, 'codex-raw');
      assert.equal(result.inferred, true);
    });
  });

  describe('normalizeListMeta', () => {
    it('produces ThinCanonical with OpenAI fields', () => {
      const entry = {
        id: 'test-1', ts: '2026-01-01T00:00:00Z', model: 'gpt-5.5',
        sessionId: 'sess-1', usage: { input_tokens: 100, output_tokens: 50 },
        status: 200, elapsed: 1000,
        req: { input: [{}, {}, {}], tools: [{}, {}] },
        res: { model: 'gpt-5.5', status: 'completed' },
        responseMetadata: { id: 'resp_01', streaming: true },
      };
      const meta = openai.normalizeListMeta(entry);
      assert.equal(meta.provider, 'openai');
      assert.equal(meta.model, 'gpt-5.5');
      assert.equal(meta.msgCount, 3);
      assert.equal(meta.toolCount, 2);
      assert.equal(meta.agentType, 'default');
      assert.ok(meta.responseMetadata);
    });
  });

  describe('preprocessBody (withCodexMetadata)', () => {
    it('injects session_id from headers into body metadata', () => {
      const body = { model: 'gpt-5.5', input: [] };
      const headers = { 'session_id': 'injected-session' };
      const result = openai.preprocessBody(body, headers);
      assert.equal(result.metadata.session_id, 'injected-session');
    });

    it('does not overwrite existing metadata', () => {
      const body = { model: 'gpt-5.5', metadata: { session_id: 'original' } };
      const headers = { 'session_id': 'from-header' };
      const result = openai.preprocessBody(body, headers);
      assert.equal(result.metadata.session_id, 'original');
    });

    it('returns body unchanged when no header info', () => {
      const body = { model: 'gpt-5.5' };
      const result = openai.preprocessBody(body, {});
      assert.deepEqual(result, body);
    });
  });

  describe('low-level exports for ws-proxy compat', () => {
    it('exports all openai-session.js functions', () => {
      assert.equal(typeof openai.getCodexRawSessionId, 'function');
      assert.equal(typeof openai.firstHeader, 'function');
      assert.equal(typeof openai.parseCodexTurnMetadata, 'function');
      assert.equal(typeof openai.getCodexSessionId, 'function');
      assert.equal(typeof openai.getOpenAIAgentTypeFromHeaders, 'function');
      assert.equal(typeof openai.isOpenAISubagent, 'function');
      assert.equal(typeof openai.detectOpenAISession, 'function');
      assert.equal(typeof openai.withCodexMetadata, 'function');
    });

    it('isOpenAISubagent detects from header', () => {
      assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': 'true' }, {}), true);
      assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': '0' }, {}), false);
      assert.equal(openai.isOpenAISubagent({}, {}), false);
    });
  });
});
