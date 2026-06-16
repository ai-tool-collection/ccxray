'use strict';

// `ccxray rebuild-index` — rebuild index.ndjson from surviving log files.
//
// The dashboard restores history ONLY from index.ndjson (server/restore.js). If
// that file is lost or truncated, history disappears even when the underlying
// _req/_res log files are still on disk. This command replays the SAME canonical
// projection the live pipeline uses (getParser(provider).buildEntryFields →
// buildIndexLine, see server/forward.js ~716-743) over the surviving files, so a
// rebuilt line is shape-identical to a live one and can never drift from the
// production field layout (that drift was the old recovery script's core bug).
//
// Hard guarantees (issue #48,做法 1):
//   • merge-only — only ADD lines for ids that have a _req.json on disk but are
//     missing from the index (the "orphan set"). Existing lines, including the
//     ~85% whose _req/_res were pruned (LOG_RETENTION_DAYS) while the index kept
//     the line forever, are copied through verbatim. The index never shrinks and
//     a present line is never overwritten.
//   • never degrade — a delta turn whose ancestor _req.json was pruned cannot be
//     fully reconstructed; we SKIP it and count it unrecoverable rather than emit
//     a truncated line. Rebuild must never produce a worse line than doing nothing.
//   • atomic — write a temp file, then fs.rename() onto index.ndjson.
//   • hub-safe — refuse to run while a live hub may be appending concurrently.
//
// Recovers offline: model/usage/cost/maxContext/toolCalls (canonical), cwd (from
// the rehydrated system prompt — shared sys_*.json files are never pruned),
// title, thinkingDuration, stopReason, and session attribution. Honestly null
// for runtime-only fields it cannot know (elapsed, receivedAt, coreHash).

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const hub = require('./hub');
const helpers = require('./helpers');
const { getParser } = require('./wire-parsers');
const { buildIndexLine } = require('./entry');

// "2026-05-01T11-47-17-808" → "11:47:17". The id IS a Taipei-local timestamp, so
// ts (the live pipeline's wall-clock time-of-day) is exact, not a guess.
function tsFromId(id) {
  const m = id.match(/^\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : '';
}

// Reconstruct the full as-sent request body for one id from disk — the offline
// twin of loadEntryReqRes (server/restore.js). Returns { provider, parsedBody }
// or null when the delta chain is broken (an ancestor _req.json is missing), so
// the caller can skip rather than emit a degraded line. `cache` memoizes across
// the run (one anchor is the ancestor of many deltas); `seen` guards prevId cycles.
async function reconstructReq(id, storage, cache, seen = new Set()) {
  if (cache.has(id)) return cache.get(id);

  let stripped;
  try {
    stripped = JSON.parse(await storage.read(id, '_req.json'));
  } catch {
    cache.set(id, null); // missing source = broken link in any chain through it
    return null;
  }

  // OpenAI/Codex: the stored _req.json is the full body (no delta, no shared
  // sys/tools split) — same discriminator loadEntryReqRes uses.
  if (stripped.provider === 'openai' || Array.isArray(stripped.input)) {
    const result = { provider: 'openai', parsedBody: stripped };
    cache.set(id, result);
    return result;
  }

  // Anthropic: rehydrate system/tools from content-addressed shared files (never
  // pruned, so always available when the hash is present).
  const system = stripped.sysHash
    ? await readSharedJson(storage, `sys_${stripped.sysHash}.json`)
    : null;
  const tools = stripped.toolsHash
    ? await readSharedJson(storage, `tools_${stripped.toolsHash}.json`)
    : null;

  // Delta turn: splice prevMessages[0..msgOffset] + delta messages. If the
  // ancestor can't be reconstructed (pruned anywhere up the chain), the whole
  // turn is unrecoverable.
  let messages = Array.isArray(stripped.messages) ? stripped.messages : [];
  if (stripped.prevId != null && stripped.msgOffset != null) {
    if (seen.has(id)) { cache.set(id, null); return null; } // cycle guard
    seen.add(id);
    const prev = await reconstructReq(stripped.prevId, storage, cache, seen);
    if (!prev || !Array.isArray(prev.parsedBody?.messages)) {
      cache.set(id, null);
      return null;
    }
    messages = [...prev.parsedBody.messages.slice(0, stripped.msgOffset), ...messages];
  }

  const parsedBody = { ...stripped, system, tools, messages };
  delete parsedBody.sysHash;
  delete parsedBody.toolsHash;
  delete parsedBody.prevId;
  delete parsedBody.msgOffset;

  const result = { provider: 'anthropic', parsedBody };
  cache.set(id, result);
  return result;
}

async function readSharedJson(storage, filename) {
  try { return JSON.parse(await storage.readShared(filename)); } catch { return null; }
}

// Parsed _res.json (captured SSE event array), or null if absent. usage / cost /
// maxContext are derived from these by the canonical buildEntryFields.
async function readResEvents(storage, id) {
  try {
    const parsed = JSON.parse(await storage.read(id, '_res.json'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Anthropic stop_reason lives in the message_delta event. buildEntryFields takes
// it via ctx.stopReason with NO event fallback (the live pipeline extracts it in
// forward.js and passes it in), so we must supply it or the column comes back
// blank — a silent degradation of every recovered line.
function stopReasonFromEvents(events) {
  if (!Array.isArray(events)) return '';
  const delta = events.find(e => e && e.type === 'message_delta');
  return delta?.delta?.stop_reason || '';
}

// Replay the live title logic (forward.js:705-711) over the data we have offline.
// Title is the dashboard's turn label; both prototypes left it null.
function recoverTitle(provider, parsedBody, events, isSubagent) {
  if (provider !== 'anthropic') return null; // openai: best-effort, don't fabricate
  if (isSubagent) return helpers.extractFirstUserText(parsedBody) || null;
  return helpers.extractResponseTitle(Array.isArray(events) ? events : [])
    || helpers.extractLastUserText(parsedBody)
    || helpers.extractToolResultSummary(parsedBody)
    || null;
}

// Largest timeline entry with id strictly before `id` (sorted ascending). Used to
// attribute an inferred/subagent turn to the session that was active when it ran.
function nearestPrecedingSession(timeline, id) {
  let lo = 0, hi = timeline.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].id < id) { ans = timeline[mid].sid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function liveHubBlocking() {
  const lock = hub.readHubLock();
  return lock && lock.pid && hub.isPidAlive(lock.pid) ? lock : null;
}

async function rebuildIndex({ apply = false, storage = config.storage, log = console.log } = {}) {
  // ── Hub safety: refuse to race a live hub's appends. ──
  const blockingHub = liveHubBlocking();
  if (blockingHub) {
    log(`\x1b[31mA ccxray hub is running (pid ${blockingHub.pid}). Stop it first.\x1b[0m`);
    log('  Run `ccxray status` to inspect, stop all `ccxray claude` clients, then retry.');
    return { refused: true };
  }

  await storage.init();

  // ── 1. Existing index → merge base + explicit-session timeline + cwd hints. ──
  const existingContent = await storage.readIndex();
  const existingIds = new Set();
  const explicitTimeline = []; // [{ id, sid }] — explicit, non-inferred sessions
  const sessionCwd = new Map(); // sid → cwd, for backfilling inferred turns
  for (const line of (existingContent || '').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; } // one bad line must not abort
    if (!m || !m.id) continue;
    existingIds.add(m.id);
    if (m.sessionId && !m.sessionInferred && m.sessionId !== 'direct-api') {
      explicitTimeline.push({ id: m.id, sid: m.sessionId });
      if (m.cwd && !sessionCwd.has(m.sessionId)) sessionCwd.set(m.sessionId, m.cwd);
    }
  }

  // ── 2. Orphan set: ids with a _req.json on disk but no index line. ──
  let files;
  try { files = await storage.list(); } catch { files = []; }
  const orphanIds = files
    .filter(f => f.endsWith('_req.json') && !f.endsWith('_req.received.json'))
    .map(f => f.slice(0, -'_req.json'.length))
    .filter(id => !existingIds.has(id))
    .sort();

  // ── 3. Pass 1: reconstruct every orphan body; extend the explicit timeline. ──
  const cache = new Map();
  const recon = []; // { id, provider, parsedBody, explicitSid }
  let unrecoverable = 0;
  for (const id of orphanIds) {
    let r;
    try { r = await reconstructReq(id, storage, cache); } catch { r = null; }
    if (!r) { unrecoverable++; continue; }
    const explicitSid = r.parsedBody?.metadata?.session_id || null;
    recon.push({ id, provider: r.provider, parsedBody: r.parsedBody, explicitSid });
    if (explicitSid) {
      explicitTimeline.push({ id, sid: explicitSid });
      if (r.provider === 'anthropic' && !sessionCwd.has(explicitSid)) {
        const cwd = store.extractCwd(r.parsedBody);
        if (cwd) sessionCwd.set(explicitSid, cwd);
      }
    }
  }
  explicitTimeline.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── 4. Pass 2: project each orphan through the canonical pipeline. ──
  const recovered = [];
  for (const { id, provider, parsedBody, explicitSid } of recon) {
    const events = await readResEvents(storage, id);

    // Session attribution. Explicit metadata.session_id is authoritative (every
    // delta and main-session turn carries it). Otherwise the turn is a subagent /
    // inferred turn whose parent is a runtime-temporal property we can't read off
    // its own file — attribute it to the session active just before it by id
    // timestamp. Deterministic, unlike store.detectSession's inflight/30s-window
    // inference which is meaningless offline.
    // ponytail: nearest-preceding-by-timestamp approximates live parent inference;
    // if it proves wrong in practice, fall back to null + sessionInferred.
    let sessionId, sessionInferred;
    if (explicitSid) {
      sessionId = explicitSid;
      sessionInferred = false;
    } else {
      sessionId = nearestPrecedingSession(explicitTimeline, id) || 'direct-api';
      sessionInferred = true;
    }

    const isSubagent = provider === 'anthropic' ? store.isAnthropicSubagent(parsedBody) : false;
    let cwd = null;
    if (provider === 'anthropic') {
      cwd = store.extractCwd(parsedBody) || sessionCwd.get(sessionId) || null;
    }
    const stopReason = provider === 'anthropic' ? stopReasonFromEvents(events) : '';
    const title = recoverTitle(provider, parsedBody, events, isSubagent);
    const thinkingDuration = (provider === 'anthropic' && Array.isArray(events))
      ? helpers.computeThinkingDuration(events)
      : null;

    const fields = getParser(provider).buildEntryFields({
      provider,
      transport: 'sse',
      parsedBody,
      events,
      sessionId,
      sessionInferred,
      cwd,
      isSubagent,
      sysHash: null,
      toolsHash: null,
      coreHash: null,
      stopReason,
      title,
      thinkingDuration,
      thinkingStripped: undefined,
    });

    const entry = {
      id,
      ts: tsFromId(id),
      // isSSE: we captured an SSE _res.json (anthropic) or it's openai (streaming).
      isSSE: Array.isArray(events) || provider === 'openai',
      // status: a captured response implies success; otherwise honestly unknown.
      status: Array.isArray(events) ? 200 : null,
      receivedAt: null,
      elapsed: null,
      ...fields,
    };
    recovered.push(buildIndexLine(entry));
  }

  // ── 5. Report. ──
  const M = orphanIds.length;
  const N = recovered.length;
  log(`recovered ${N} / ${M} turns; ${unrecoverable} unrecoverable (source pruned)`);
  log(`  index: ${existingIds.size} existing lines${N ? ` + ${N} recovered` : ''}`);

  if (N === 0) {
    log(apply ? '  nothing to add — index left unchanged.' : '  dry run — nothing to add.');
    return { refused: false, recovered: 0, total: M, unrecoverable, applied: false };
  }
  if (!apply) {
    log(`  dry run — pass --apply to write ${storage.location || 'index.ndjson'}.`);
    return { refused: false, recovered: N, total: M, unrecoverable, applied: false };
  }

  // ── 6. Atomic merge-write (local filesystem only). ──
  if (!storage.supportsDelta || !storage.location) {
    log('  --apply needs the local filesystem backend; aborting without writing.');
    return { refused: false, recovered: N, total: M, unrecoverable, applied: false };
  }
  const indexPath = path.join(storage.location, 'index.ndjson');
  const tmpPath = `${indexPath}.rebuild-${process.pid}.tmp`;
  const base = existingContent && !existingContent.endsWith('\n')
    ? existingContent + '\n'
    : (existingContent || '');
  fs.writeFileSync(tmpPath, base + recovered.join('\n') + '\n');
  fs.renameSync(tmpPath, indexPath);
  log(`  wrote ${indexPath} (${existingIds.size + N} lines). Restart the dashboard to see recovered turns.`);
  return { refused: false, recovered: N, total: M, unrecoverable, applied: true };
}

module.exports = { rebuildIndex, reconstructReq, tsFromId, nearestPrecedingSession, stopReasonFromEvents };
