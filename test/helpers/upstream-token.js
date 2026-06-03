'use strict';

// Derive the X-Ccxray-Auth header value (base64url of K_upstream) that a ccxray
// server with the given CCXRAY_HOME / AUTH_TOKEN will accept — exactly what
// server/providers.js getUpstreamToken() injects into spawned CLIs. Re-requires
// the real auth module so the derivation can never drift from production.
//
// For ephemeral mode (no authToken) this reads-or-creates <home>/local-secret;
// a child spawned with the same CCXRAY_HOME reads the same secret, so the token
// matches on both sides.
function deriveUpstreamToken({ home, authToken } = {}) {
  const prevHome = process.env.CCXRAY_HOME;
  const prevTok = process.env.AUTH_TOKEN;
  if (home !== undefined) process.env.CCXRAY_HOME = home;
  if (authToken === undefined || authToken === null) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = authToken;

  delete require.cache[require.resolve('../../server/auth')];
  const auth = require('../../server/auth');
  const token = auth.deriveSecrets(auth.getRootSecret()).K_upstream.toString('base64url');

  if (prevHome === undefined) delete process.env.CCXRAY_HOME;
  else process.env.CCXRAY_HOME = prevHome;
  if (prevTok === undefined) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = prevTok;
  delete require.cache[require.resolve('../../server/auth')];

  return token;
}

module.exports = { deriveUpstreamToken };
