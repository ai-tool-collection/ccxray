'use strict';

const anthropic = require('./anthropic');
// const openai = require('./openai'); // Phase 2

const WIRE_PARSERS = Object.freeze({
  anthropic,
  // openai, // Phase 2
});

const SAFE_DEFAULTS = {
  dedupExtract: { sharedFiles: [] },
  extractDeltaSlice: null,
  isNoiseRequest: false,
  normalizeListMeta: null,
  extractUsage: null,
  extractAgentType: { key: 'unknown', label: 'Unknown Agent' },
  detectSession: { sessionId: null },
};

function getParser(provider) {
  return WIRE_PARSERS[provider] || null;
}

function safeCall(parser, method, args, fallback) {
  if (!parser || typeof parser[method] !== 'function') return fallback;
  try {
    return parser[method](...args);
  } catch (e) {
    const def = fallback !== undefined ? fallback : SAFE_DEFAULTS[method];
    if (process.env.CCXRAY_DEBUG_WIRE_PARSERS) {
      console.error(`[wire-parsers] ${method} failed:`, e.message);
    }
    return def !== undefined ? def : null;
  }
}

module.exports = { WIRE_PARSERS, getParser, safeCall, SAFE_DEFAULTS };
