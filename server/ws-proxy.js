'use strict';

const WebSocket = require('ws');
const config = require('./config');
const store = require('./store');
const helpers = require('./helpers');
const { broadcast, broadcastSessionStatus } = require('./sse-broadcast');
const { AUTH_TOKEN } = require('./auth');
const {
  detectOpenAISession,
  getCodexSessionId,
  getOpenAIAgentTypeFromHeaders,
  parseCodexTurnMetadata,
} = require('./openai-session');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const WS_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

const wss = new WebSocket.Server({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.values().next().value || false;
  },
});

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env.CCXRAY_WS_IDLE_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MS = Number.isFinite(DEFAULT_IDLE_TIMEOUT_MS) && DEFAULT_IDLE_TIMEOUT_MS > 0
  ? DEFAULT_IDLE_TIMEOUT_MS
  : 60000;
const OPENAI_WS_PATHS = new Set(['/v1/responses', '/v1/realtime']);

function isUpgradeRequest(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket';
}

function isOpenAIWebSocket(req, upstream) {
  const pathname = (req.url || '').split('?')[0];
  return upstream?.provider === 'openai' && OPENAI_WS_PATHS.has(pathname) && isUpgradeRequest(req);
}

function writeSocketResponse(socket, statusCode, reason) {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n'
  );
  socket.destroy();
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${AUTH_TOKEN}`) return true;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return url.searchParams.get('token') === AUTH_TOKEN;
  } catch {
    return false;
  }
}

function buildWebSocketHeaders(clientHeaders, upstream) {
  const headers = {};
  const connectionTokens = String(clientHeaders.connection || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (WS_HANDSHAKE_HEADERS.has(lower)) continue;
    if (connectionTokens.includes(lower)) continue;
    if (lower === 'host') continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  return headers;
}

function getWebSocketProtocols(clientHeaders) {
  const raw = clientHeaders['sec-websocket-protocol'];
  if (!raw) return undefined;
  return String(raw).split(',').map(v => v.trim()).filter(Boolean);
}

function getWebSocketUrl(upstream, requestUrl) {
  const protocol = upstream.protocol === 'https' ? 'wss' : 'ws';
  const path = config.joinUpstreamPath(upstream, requestUrl);
  return `${protocol}://${upstream.host}:${upstream.port}${path}`;
}

function getWorkspaceCwd(turnMetadata) {
  const workspaces = turnMetadata?.workspaces;
  if (!workspaces || typeof workspaces !== 'object') return null;
  if (typeof workspaces.cwd === 'string') return workspaces.cwd;
  if (typeof workspaces.current === 'string') return workspaces.current;
  const first = Object.values(workspaces).find(v => typeof v === 'string');
  if (first) return first;
  const nested = Object.values(workspaces).find(v => v && typeof v === 'object' && typeof v.cwd === 'string');
  return nested?.cwd || null;
}

function sendOrBuffer(target, queue, data, isBinary) {
  if (target.readyState === WebSocket.OPEN) {
    target.send(data, { binary: isBinary }, () => {});
  } else if (target.readyState === WebSocket.CONNECTING) {
    queue.push({ data, isBinary });
  }
}

function flushQueue(target, queue) {
  while (queue.length && target.readyState === WebSocket.OPEN) {
    const item = queue.shift();
    target.send(item.data, { binary: item.isBinary }, () => {});
  }
}

function frameSize(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

async function recordWebSocketEntry(ctx, result) {
  const elapsed = ((Date.now() - ctx.startTime) / 1000).toFixed(1);
  const reqLog = {
    transport: 'websocket',
    capture: 'transport-only',
    method: ctx.req.method,
    url: ctx.req.url,
    endpoint: ctx.endpoint,
    headers: {
      openaiBeta: ctx.req.headers['openai-beta'] || null,
      sessionId: ctx.sessionId,
      agentType: ctx.agentType,
    },
    metadata: ctx.turnMetadata || null,
  };
  const resLog = {
    transport: 'websocket',
    capture: 'transport-only',
    frameCounts: ctx.frameCounts,
    byteCounts: ctx.byteCounts,
    close: result.close || null,
    error: result.error || null,
  };

  const reqWritePromise = config.storage.write(ctx.id, '_req.json', JSON.stringify(reqLog))
    .catch(e => console.error('Write ws req.json failed:', e.message));
  const resWritePromise = config.storage.write(ctx.id, '_res.json', JSON.stringify(resLog))
    .catch(e => console.error('Write ws res.json failed:', e.message));

  const responseMetadata = {
    transport: 'websocket',
    capture: 'transport-only',
    endpoint: ctx.endpoint,
    frameCounts: ctx.frameCounts,
    byteCounts: ctx.byteCounts,
    close: result.close || null,
    error: result.error || null,
  };
  const entry = {
    id: ctx.id,
    ts: ctx.ts,
    sessionId: ctx.sessionId,
    method: ctx.req.method,
    url: ctx.req.url,
    provider: 'openai',
    agent: 'codex',
    req: reqLog,
    res: resLog,
    elapsed,
    status: result.status,
    isSSE: false,
    tokens: null,
    usage: null,
    cost: null,
    responseMetadata,
    maxContext: null,
    cwd: store.sessionMeta[ctx.sessionId]?.cwd || null,
    receivedAt: ctx.startTime,
    duplicateToolCalls: null,
    model: null,
    msgCount: 0,
    toolCount: 0,
    toolCalls: {},
    isSubagent: ctx.agentType === 'explorer' || ctx.agentType === 'worker',
    sessionInferred: ctx.sessionInferred,
    title: 'Codex WebSocket session',
    stopReason: result.close?.reason || result.error?.message || null,
    toolFail: false,
    sysHash: null,
    toolsHash: null,
    coreHash: null,
    thinkingStripped: undefined,
  };
  entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
  entry.toolSources = helpers.buildToolSources(entry) || undefined;
  entry._writePromise = Promise.all([reqWritePromise, resWritePromise]);
  store.entries.push(entry);
  store.trimEntries();
  broadcast(entry);

  const indexLine = JSON.stringify({
    id: entry.id,
    ts: entry.ts,
    sessionId: entry.sessionId,
    provider: entry.provider,
    agent: entry.agent,
    model: entry.model,
    msgCount: entry.msgCount,
    toolCount: entry.toolCount,
    toolCalls: entry.toolCalls,
    isSubagent: entry.isSubagent,
    sessionInferred: entry.sessionInferred,
    cwd: entry.cwd,
    isSSE: entry.isSSE,
    usage: entry.usage,
    cost: entry.cost,
    maxContext: entry.maxContext,
    responseMetadata,
    stopReason: entry.stopReason,
    title: entry.title,
    thinkingDuration: null,
    toolFail: entry.toolFail,
    elapsed,
    status: entry.status,
    receivedAt: entry.receivedAt,
    sysHash: null,
    toolsHash: null,
    coreHash: null,
    thinkingStripped: entry.thinkingStripped,
    hasCredential: entry.hasCredential,
    toolSources: entry.toolSources,
  });
  config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write ws index failed:', e.message));
  entry.req = null;
  entry.res = null;
  entry._loaded = false;
}

function handleWebSocketUpgrade(req, socket, head) {
  const upstream = config.getUpstreamForRequestAndHeaders(req.url, req.headers);
  if (!isOpenAIWebSocket(req, upstream)) {
    writeSocketResponse(socket, 404, 'Not Found');
    return true;
  }
  if (!isAuthorized(req)) {
    writeSocketResponse(socket, 401, 'Unauthorized');
    return true;
  }

  const id = helpers.timestamp();
  const ts = helpers.taipeiTime();
  const startTime = Date.now();
  const detected = detectOpenAISession(req.headers, null);
  const sessionId = detected.sessionId;
  const turnMetadata = parseCodexTurnMetadata(req.headers);
  const agentType = getOpenAIAgentTypeFromHeaders(req.headers);
  const cwd = getWorkspaceCwd(turnMetadata);
  const endpoint = (req.url || '').split('?')[0];

  if (!store.sessionMeta[sessionId]) store.sessionMeta[sessionId] = {};
  store.sessionMeta[sessionId].provider = 'openai';
  store.sessionMeta[sessionId].lastSeenAt = Date.now();
  if (cwd) store.sessionMeta[sessionId].cwd = cwd;
  if (agentType) store.sessionMeta[sessionId].agentType = agentType;
  store.activeRequests[sessionId] = (store.activeRequests[sessionId] || 0) + 1;
  broadcastSessionStatus(sessionId);
  if (detected.isNewSession) store.printSessionBanner(sessionId);

  wss.handleUpgrade(req, socket, head, clientWs => {
    const upstreamUrl = getWebSocketUrl(upstream, req.url);
    const upstreamWs = new WebSocket(upstreamUrl, getWebSocketProtocols(req.headers), {
      headers: buildWebSocketHeaders(req.headers, upstream),
    });
    const ctx = {
      id,
      ts,
      startTime,
      req,
      sessionId,
      agentType,
      turnMetadata,
      endpoint,
      sessionInferred: detected.inferred || !getCodexSessionId(req.headers, null),
      frameCounts: { clientToUpstream: 0, upstreamToClient: 0 },
      byteCounts: { clientToUpstream: 0, upstreamToClient: 0 },
    };
    const clientQueue = [];
    const upstreamQueue = [];
    let finalized = false;
    let idleTimer = null;

    function refreshIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        closeBoth(1011, 'idle timeout');
        finalize({ status: 504, error: { message: `WebSocket idle timeout after ${IDLE_TIMEOUT_MS}ms` } });
      }, IDLE_TIMEOUT_MS);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    function finalize(result) {
      if (finalized) return;
      finalized = true;
      clearTimeout(idleTimer);
      store.activeRequests[sessionId] = Math.max(0, (store.activeRequests[sessionId] || 1) - 1);
      if (store.sessionMeta[sessionId]) store.sessionMeta[sessionId].lastStopReason = null;
      broadcastSessionStatus(sessionId);
      recordWebSocketEntry(ctx, result).catch(e => console.error('Record ws entry failed:', e.message));
    }

    function closeBoth(code, reason) {
      const closeCode = code || 1000;
      const closeReason = reason || '';
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(closeCode, closeReason);
      }
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        upstreamWs.close(closeCode, closeReason);
      }
    }

    clientWs.on('message', (data, isBinary) => {
      refreshIdleTimer();
      ctx.frameCounts.clientToUpstream += 1;
      ctx.byteCounts.clientToUpstream += frameSize(data);
      sendOrBuffer(upstreamWs, upstreamQueue, data, isBinary);
    });
    upstreamWs.on('message', (data, isBinary) => {
      refreshIdleTimer();
      ctx.frameCounts.upstreamToClient += 1;
      ctx.byteCounts.upstreamToClient += frameSize(data);
      sendOrBuffer(clientWs, clientQueue, data, isBinary);
    });
    clientWs.on('ping', data => {
      refreshIdleTimer();
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping(data, undefined, () => {});
    });
    upstreamWs.on('ping', data => {
      refreshIdleTimer();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping(data, undefined, () => {});
    });
    clientWs.on('pong', data => {
      refreshIdleTimer();
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.pong(data, undefined, () => {});
    });
    upstreamWs.on('pong', data => {
      refreshIdleTimer();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.pong(data, undefined, () => {});
    });
    upstreamWs.on('open', () => {
      refreshIdleTimer();
      flushQueue(upstreamWs, upstreamQueue);
      flushQueue(clientWs, clientQueue);
    });
    upstreamWs.on('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode || 502;
      closeBoth(1011, `upstream ${statusCode}`);
      finalize({ status: statusCode, error: { message: `Upstream WebSocket rejected handshake: ${statusCode}` } });
    });
    clientWs.on('close', (code, reason) => {
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) upstreamWs.close(code, reason);
      finalize({ status: 101, close: { side: 'client', code, reason: reason.toString() } });
    });
    upstreamWs.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) clientWs.close(code, reason);
      finalize({ status: 101, close: { side: 'upstream', code, reason: reason.toString() } });
    });
    clientWs.on('error', err => {
      closeBoth(1011, 'client error');
      finalize({ status: 502, error: { side: 'client', message: err.message } });
    });
    upstreamWs.on('error', err => {
      closeBoth(1011, 'upstream error');
      finalize({ status: 502, error: { side: 'upstream', message: err.message } });
    });
  });
  return true;
}

module.exports = {
  handleWebSocketUpgrade,
  buildWebSocketHeaders,
  isOpenAIWebSocket,
};
