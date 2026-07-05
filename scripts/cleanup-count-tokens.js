#!/usr/bin/env node
'use strict';

// Remove historical count_tokens entries from index.ndjson (#146).
//
// Before the isNoiseRequest fix, POST /v1/messages/count_tokens calls were
// recorded as fake single-turn subagent entries and rendered as extra
// swimlanes. This script identifies them precisely — the response body of a
// count_tokens call is exactly {"input_tokens": N}, a shape no /v1/messages
// response can produce — and drops their lines from index.ndjson.
//
// Log files ({id}_req.json / {id}_res.json) are left on disk; restore reads
// only the index, so orphaned files are harmless.
//
// Usage:
//   node scripts/cleanup-count-tokens.js            # dry run (default)
//   node scripts/cleanup-count-tokens.js --apply    # rewrite index (with backup)
//   CCXRAY_HOME=/tmp/copy node scripts/cleanup-count-tokens.js
//
// --apply refuses to run while a hub is alive on this home (it appends to
// index.ndjson; a concurrent rewrite would lose entries). Stop the hub first,
// or pass --force if you know the lockfile is stale.

const fs = require('fs');
const os = require('os');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const HOME = process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
const LOGS = path.join(HOME, 'logs');
const INDEX = path.join(LOGS, 'index.ndjson');

function hubAlive() {
  try {
    const hub = JSON.parse(fs.readFileSync(path.join(HOME, 'hub.json'), 'utf8'));
    if (!hub.pid) return false;
    process.kill(hub.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isCountTokensRes(id) {
  let raw;
  try { raw = fs.readFileSync(path.join(LOGS, id + '_res.json'), 'utf8'); } catch { return false; }
  let res;
  try { res = JSON.parse(raw); } catch { return false; }
  if (!res || typeof res !== 'object' || Array.isArray(res)) return false;
  const keys = Object.keys(res);
  return keys.length === 1 && keys[0] === 'input_tokens' && typeof res.input_tokens === 'number';
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('index not found: ' + INDEX);
    process.exit(1);
  }

  const lines = fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean);
  const keep = [];
  const removed = [];

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { keep.push(line); continue; }
    // Cheap prefilter: count_tokens entries never have usage and are never SSE.
    const candidate = e && e.id && e.usage == null && !e.isSSE;
    if (candidate && isCountTokensRes(e.id)) {
      removed.push(e);
    } else {
      keep.push(line);
    }
  }

  console.log('index lines : ' + lines.length);
  console.log('count_tokens: ' + removed.length);
  for (const e of removed) {
    console.log('  ' + e.id + '  session=' + (e.sessionId || '-') + '  model=' + (e.model || '-'));
  }

  if (!removed.length) { console.log('nothing to clean.'); return; }

  if (!APPLY) {
    console.log('\ndry run — pass --apply to rewrite ' + INDEX);
    return;
  }

  if (hubAlive() && !FORCE) {
    console.error('\nrefusing --apply: a hub is running on this home and appends to the');
    console.error('index; rewriting now would lose its entries. Stop the hub first');
    console.error('(let all ccxray clients exit) or pass --force if the lockfile is stale.');
    process.exit(1);
  }

  const backup = INDEX + '.bak-' + Date.now();
  fs.copyFileSync(INDEX, backup);
  fs.writeFileSync(INDEX, keep.join('\n') + '\n');
  console.log('\nremoved ' + removed.length + ' entries; backup at ' + backup);
}

main();
