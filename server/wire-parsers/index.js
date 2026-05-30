'use strict';

const anthropic = require('./anthropic');
const openai = require('./openai');

const WIRE_PARSERS = Object.freeze({
  anthropic,
  openai,
});

function getParser(provider) {
  return WIRE_PARSERS[provider] || null;
}

module.exports = { WIRE_PARSERS, getParser };
