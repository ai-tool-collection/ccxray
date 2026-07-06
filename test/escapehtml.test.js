'use strict';

// #150: escapeHtml must escape " and ' to prevent attribute-injection XSS.
// Old implementation only escaped & < >. These tests fail on old code, pass on fixed code.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadClient() {
  const publicDir = path.join(__dirname, '..', 'public');
  const el = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, insertBefore() {},
    querySelector: () => el(), querySelectorAll: () => [], remove() {},
  });
  const context = {
    console, window: {},
    document: { getElementById: () => el(), createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el() },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    navigator: {}, location: { search: '', hash: '' }, history: { replaceState() {} },
    URLSearchParams, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`
    function updateSysPromptBadge() {} function startQuotaTicker() {}
    function EventSource() { this.onmessage = null; } function setInterval() { return 0; }
    function clearInterval() {} window.ccxraySettings = { visibleProviders: [] };
    function fetch() { return Promise.resolve({ ok: false, json() { return Promise.resolve({}); } }); }
  `, context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'miller-columns.js'), 'utf8'), context);
  return context;
}

describe('#150 escapeHtml quote escaping', () => {
  const ctx = loadClient();

  it('exposes escapeHtml', () => assert.equal(typeof ctx.escapeHtml, 'function'));

  // All five special chars in one shot — the key assertion that flips old(FAIL)->new(PASS)
  it('escapes & < > " \' all together', () => {
    assert.equal(ctx.escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
  });

  // Attribute-breakout XSS vector: raw " must not survive
  it('attribute-breakout vector: no raw double-quote in output', () => {
    const result = ctx.escapeHtml('" onmouseover="alert(1)');
    assert.ok(!result.includes('"'), `raw " present in: ${result}`);
    assert.ok(result.includes('&quot;'), `&quot; missing in: ${result}`);
  });

  // Single-quote breakout
  it('single-quote vector: no raw single-quote in output', () => {
    const result = ctx.escapeHtml("' onmouseover='alert(1)");
    assert.ok(!result.includes("'"), `raw ' present in: ${result}`);
    assert.ok(result.includes('&#39;'), `&#39; missing in: ${result}`);
  });

  // Normal string passes through untouched
  it('normal string with no special chars is unchanged', () => {
    assert.equal(ctx.escapeHtml('hello world'), 'hello world');
  });

  // Non-string branch still JSON.stringifies without throwing
  it('non-string input JSON.stringifies', () => {
    const result = ctx.escapeHtml({ x: 1 });
    assert.ok(result.includes('&quot;x&quot;'), `expected escaped JSON keys in: ${result}`);
  });
});
