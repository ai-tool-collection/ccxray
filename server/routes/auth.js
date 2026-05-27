'use strict';

// Auth domain routes.
//
// POST /_auth/redeem           → consume one-time bootstrap token, mint cookie.
// GET  /_auth/status           → server-side session probe.
// POST /_auth/bootstrap-token  → mint a one-time token (loopback only).
//
// /_auth/redeem runs BEFORE verifyDashboard (it creates the cookie).
// /_auth/status is exempt from authentication (probes session state).
// /_auth/bootstrap-token is loopback-restricted (same as the old
// /_api/hub/bootstrap-token, moved here so it works in both hub and
// standalone mode — the /_api/hub/* namespace now returns 410).

const auth = require('../auth');

function handleAuthRoutes(req, res) {
  const pathname = req.url.split('?')[0];

  if (req.method === 'POST' && pathname === '/_auth/redeem') {
    auth.redeemBootstrap(req, res);
    return true;
  }

  if (req.method === 'GET' && pathname === '/_auth/status') {
    auth.authStatus(req, res);
    return true;
  }

  if (req.method === 'POST' && pathname === '/_auth/bootstrap-token') {
    const addr = req.socket?.remoteAddress || '';
    const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'loopback_only' }));
      return true;
    }
    const token = auth.mintBootstrapToken();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token }));
    return true;
  }

  return false;
}

module.exports = { handleAuthRoutes };
