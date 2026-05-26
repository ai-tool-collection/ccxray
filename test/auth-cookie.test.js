'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const auth = require('../server/auth');

function freshKey() {
  return crypto.randomBytes(32);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

describe('signCookie + verifyCookie roundtrip', () => {
  it('signs and verifies a well-formed payload', () => {
    const key = freshKey();
    const payload = { v: 1, n: 'abc123', exp: nowSec() + 3600 };
    const raw = auth.signCookie(payload, key);
    assert.equal(typeof raw, 'string');
    assert.ok(raw.includes('.'), 'expected payload.hmac format');
    const got = auth.verifyCookie(raw, key);
    assert.deepEqual(got, payload);
  });

  it('survives non-ASCII fields in the payload', () => {
    const key = freshKey();
    const payload = { v: 1, n: '隨機', exp: nowSec() + 60 };
    const raw = auth.signCookie(payload, key);
    assert.deepEqual(auth.verifyCookie(raw, key), payload);
  });
});

describe('verifyCookie — rejection cases', () => {
  it('returns null when the HMAC is tampered', () => {
    const key = freshKey();
    const raw = auth.signCookie({ v: 1, n: 'a', exp: nowSec() + 60 }, key);
    const tampered = raw.slice(0, -1) + (raw.slice(-1) === 'A' ? 'B' : 'A');
    assert.equal(auth.verifyCookie(tampered, key), null);
  });

  it('returns null when the payload is tampered', () => {
    const key = freshKey();
    const raw = auth.signCookie({ v: 1, n: 'a', exp: nowSec() + 60 }, key);
    const dot = raw.indexOf('.');
    const payloadB64 = raw.slice(0, dot);
    const hmacB64 = raw.slice(dot + 1);
    // Flip the first character of the base64url payload section
    const flipped = (payloadB64[0] === 'A' ? 'B' : 'A') + payloadB64.slice(1);
    assert.equal(auth.verifyCookie(`${flipped}.${hmacB64}`, key), null);
  });

  it('returns null when expired', () => {
    const key = freshKey();
    const raw = auth.signCookie({ v: 1, n: 'a', exp: nowSec() - 10 }, key);
    assert.equal(auth.verifyCookie(raw, key), null);
  });

  it('returns null for the wrong key', () => {
    const k1 = freshKey();
    const k2 = freshKey();
    const raw = auth.signCookie({ v: 1, n: 'a', exp: nowSec() + 60 }, k1);
    assert.equal(auth.verifyCookie(raw, k2), null);
  });

  it('returns null for a malformed cookie (no dot)', () => {
    assert.equal(auth.verifyCookie('not-a-cookie', freshKey()), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(auth.verifyCookie('', freshKey()), null);
  });

  it('returns null for invalid base64url in payload', () => {
    assert.equal(auth.verifyCookie('!!!.!!!', freshKey()), null);
  });

  it('returns null when payload JSON is malformed', () => {
    const key = freshKey();
    const badPayload = Buffer.from('not json', 'utf8').toString('base64url');
    const hmac = crypto.createHmac('sha256', key)
      .update(Buffer.from('not json', 'utf8')).digest().toString('base64url');
    assert.equal(auth.verifyCookie(`${badPayload}.${hmac}`, key), null);
  });

  it('returns null when payload version is unsupported', () => {
    const key = freshKey();
    const raw = auth.signCookie({ v: 999, n: 'a', exp: nowSec() + 60 }, key);
    assert.equal(auth.verifyCookie(raw, key), null);
  });
});

describe('compareSecret — constant-time correctness', () => {
  it('returns true for identical strings', () => {
    assert.equal(auth.compareSecret('hunter2', 'hunter2'), true);
  });

  it('returns false for different strings of the same length', () => {
    assert.equal(auth.compareSecret('hunter2', 'hunter3'), false);
  });

  it('returns false for different lengths', () => {
    assert.equal(auth.compareSecret('hunter2', 'hunter2-longer'), false);
  });

  it('handles empty inputs without throwing', () => {
    assert.equal(auth.compareSecret('', ''), true);
    assert.equal(auth.compareSecret('', 'x'), false);
    assert.equal(auth.compareSecret('x', ''), false);
  });

  it('handles null/undefined inputs without throwing', () => {
    assert.equal(auth.compareSecret(null, 'x'), false);
    assert.equal(auth.compareSecret('x', null), false);
    assert.equal(auth.compareSecret(undefined, undefined), false);
  });
});
