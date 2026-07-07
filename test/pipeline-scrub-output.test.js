'use strict';

// scripts/pipeline/scrub-output.sh — 發 comment 前的閘。
// clean → 原文 passthrough + exit 0；命中 → exit 1 且 stdout 空（pipe 到 gh 貼不出去）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pipeline', 'scrub-output.sh');

function scrub(text, env = {}) {
  return spawnSync(SCRIPT, [], { input: text, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('scrub-output gate', () => {
  it('clean body (metric table + exit code + short excerpt) passes through, exit 0', () => {
    const body = ['結果：exit 0（diff-check）', '', '| metric | before | after |', '|---|---|---|', '| p95 | 12s | 1.2s |'].join('\n');
    const r = scrub(body);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /p95/); // passthrough
  });

  it('short fenced excerpt (<= max) is allowed', () => {
    const r = scrub(['```', 'line1', 'line2', '```'].join('\n'));
    assert.equal(r.status, 0);
  });

  it('oversized fenced block → blocked (exit 1, empty stdout)', () => {
    const big = ['```', ...Array.from({ length: 20 }, (_, i) => `log ${i}`), '```'].join('\n');
    const r = scrub(big);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /R1/);
  });

  it('home path with username → blocked', () => {
    const r = scrub('see /Users/justinlee/.ccxray/logs/x_req.json for detail');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /R2/);
  });

  it('secret/token shapes → blocked', () => {
    const r = scrub('token: sk-abcdefghijklmnopqrstuvwx1234');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /R3/);
  });

  it('authorization header → blocked', () => {
    const r = scrub('authorization: Bearer abcdef0123456789abcdef');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /R3/);
  });

  it('full request JSON (messages/role/content) → blocked', () => {
    const r = scrub('{"messages":[{"role":"user","content":"hi"}],"tools":[]}');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /R4/);
  });

  it('SCRUB_MAX_FENCE_LINES tunable raises the allowance', () => {
    const big = ['```', ...Array.from({ length: 20 }, (_, i) => `log ${i}`), '```'].join('\n');
    const r = scrub(big, { SCRUB_MAX_FENCE_LINES: '50' });
    assert.equal(r.status, 0);
  });

  it('unknown arg → usage error exit 3', () => {
    const r = spawnSync(SCRIPT, ['bogus'], { encoding: 'utf8' });
    assert.equal(r.status, 3);
  });
});
