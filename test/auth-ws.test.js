'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Unit-test ws-proxy's internal-header stripping. The upstream auth decision
// (verifyUpstreamCredential) is tested in auth-upstream-credential.test.js, and
// the live WS gate in websocket-proxy.test.js.

const wsProxy = require('../server/ws-proxy');

describe('WS header stripping (1.4c)', () => {
  it('buildWebSocketHeaders strips X-Ccxray-Auth and X-Ccxray-Bootstrap from upstream', () => {
    const { buildWebSocketHeaders } = wsProxy;
    const clientHeaders = {
      'x-ccxray-auth': 'secret-token',
      'x-ccxray-bootstrap': 'bootstrap-token',
      'authorization': 'Bearer sk-test',
      'openai-beta': 'responses_websockets=v1',
      'host': 'localhost:5577',
    };
    const upstream = { host: 'api.openai.com', port: 443 };
    const result = buildWebSocketHeaders(clientHeaders, upstream);

    assert.equal(result['x-ccxray-auth'], undefined);
    assert.equal(result['x-ccxray-bootstrap'], undefined);
    assert.equal(result['authorization'], 'Bearer sk-test');
    assert.equal(result['openai-beta'], 'responses_websockets=v1');
    assert.equal(result.host, 'api.openai.com');
  });
});
