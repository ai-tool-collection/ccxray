'use strict';

const crypto = require('crypto');
const { extractAgentType, splitB2IntoBlocks } = require('../system-prompt');
const store = require('../store');

// ── dedupExtract ────────────────────────────────────────────
// From index.js:287-301 + 376-404 (Anthropic path)
function dedupExtract(parsedBody) {
  const sharedFiles = [];
  let sysHash = null;
  let toolsHash = null;
  let coreHash = null;
  let versionInfo = null;

  if (parsedBody.system) {
    sysHash = crypto.createHash('sha256').update(JSON.stringify(parsedBody.system)).digest('hex').slice(0, 12);
    sharedFiles.push({ name: `sys_${sysHash}.json`, data: JSON.stringify(parsedBody.system) });
  }
  if (parsedBody.tools) {
    toolsHash = crypto.createHash('sha256').update(JSON.stringify(parsedBody.tools)).digest('hex').slice(0, 12);
    sharedFiles.push({ name: `tools_${toolsHash}.json`, data: JSON.stringify(parsedBody.tools) });
  }

  // coreHash from B2 (system[2]) — for version tracking
  if (Array.isArray(parsedBody.system) && parsedBody.system.length >= 3) {
    const b0 = parsedBody.system[0]?.text || '';
    const b2 = parsedBody.system[2]?.text || '';
    const liveM = b0.match(/cc_version=(\S+?)[; ]/);
    const liveVer = liveM ? liveM[1] : null;
    const { key: agentKey, label: agentLabel } = extractAgentType(parsedBody.system);

    if (b2.length >= 500) {
      const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
      coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
      if (liveVer || agentKey !== 'unknown') {
        versionInfo = {
          agentKey, agentLabel, coreHash, coreText,
          version: liveVer, b2Len: b2.length,
          sharedFile: sysHash ? `sys_${sysHash}.json` : null,
        };
      }
    }
  }

  return { sysHash, toolsHash, coreHash, sharedFiles, versionInfo };
}

// ── extractDeltaSlice ───────────────────────────────────────
// From index.js:324-353 (Anthropic delta-log path)
// prevState: { id, messages, deltaCount } from caller's sessionLastReq Map
// currReq: { id, parsedBody, sysHash, toolsHash }
// Returns: { stripped, trackingState } or null (full write)
function extractDeltaSlice(prevState, currReq, { snapshotInterval = 0 } = {}) {
  const { findSharedPrefix } = require('../delta-helpers');
  const currMessages = Array.isArray(currReq.parsedBody.messages) ? currReq.parsedBody.messages : [];
  const sharedCount = prevState ? findSharedPrefix(prevState.messages, currMessages) : 0;
  const forceFull = !prevState ||
    (snapshotInterval > 0 && (prevState.deltaCount || 0) >= snapshotInterval);

  if (!forceFull && sharedCount >= 2) {
    return {
      stripped: {
        model: currReq.parsedBody.model,
        max_tokens: currReq.parsedBody.max_tokens,
        prevId: prevState.id,
        msgOffset: sharedCount,
        messages: currMessages.slice(sharedCount),
        sysHash: currReq.sysHash,
        toolsHash: currReq.toolsHash,
      },
      trackingState: { id: currReq.id, messages: currMessages, deltaCount: (prevState.deltaCount || 0) + 1 },
    };
  }

  return {
    stripped: {
      model: currReq.parsedBody.model,
      max_tokens: currReq.parsedBody.max_tokens,
      messages: currMessages,
      sysHash: currReq.sysHash,
      toolsHash: currReq.toolsHash,
    },
    trackingState: { id: currReq.id, messages: currMessages, deltaCount: 0 },
  };
}

// ── isNoiseRequest ──────────────────────────────────────────
function isNoiseRequest(_url, _headers, _parsedBody) {
  return false;
}

// ── normalizeListMeta ───────────────────────────────────────
// READ-path only: from raw stored entry → ThinCanonical for list layer
function normalizeListMeta(entry) {
  return {
    id: entry.id,
    ts: entry.ts,
    provider: 'anthropic',
    model: entry.model || entry.req?.model || 'unknown',
    sessionId: entry.sessionId,
    msgCount: entry.msgCount ?? (Array.isArray(entry.req?.messages) ? entry.req.messages.length : 0),
    toolCount: entry.toolCount ?? (Array.isArray(entry.req?.tools) ? entry.req.tools.length : 0),
    usage: entry.usage || null,
    cost: entry.cost || null,
    agentType: entry.agentType || 'unknown',
    agentLabel: entry.agentLabel || 'Unknown',
    isSubagent: entry.isSubagent || false,
    stopReason: entry.stopReason || null,
    status: entry.status,
    elapsed: entry.elapsed,
    coreHash: entry.coreHash || null,
    thinkingDuration: entry.thinkingDuration || null,
    thinkingStripped: entry.thinkingStripped || false,
    hasCredential: entry.hasCredential || false,
  };
}

// ── extractUsage ────────────────────────────────────────────
// From helpers.js:272-292 (Anthropic SSE events → usage)
function extractUsage(resData) {
  if (!Array.isArray(resData)) return null;
  const msgStart = resData.find(e => e.type === 'message_start');
  const msgDelta = resData.find(e => e.type === 'message_delta');
  const u = msgStart?.message?.usage || {};
  const result = {
    input_tokens: u.input_tokens || 0,
    output_tokens: msgDelta?.usage?.output_tokens || u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    result.cache_creation = {
      ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens || 0,
    };
  }
  return result;
}

// ── extractAgentType ────────────────────────────────────────
// From system-prompt.js:51-79 (Anthropic B2 prefix matching)
function extractAgentTypeMethod(systemBlob, _headers) {
  return extractAgentType(systemBlob);
}

// ── detectSession ───────────────────────────────────────────
// Anthropic path: session_id from parsedBody.metadata, delegate to store.detectSession
function detectSession(_req, _headers, parsedBody) {
  return store.detectSession(parsedBody);
}

module.exports = {
  dedupExtract,
  extractDeltaSlice,
  isNoiseRequest,
  normalizeListMeta,
  extractUsage,
  extractAgentType: extractAgentTypeMethod,
  detectSession,
};
