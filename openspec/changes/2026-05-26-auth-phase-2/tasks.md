## 1. Unix socket hub IPC (commit 2.1)

### Pre-mortem mitigations (from 2026-05-26 review)
- Framing: server + client 都用 line buffer（buffer until `\n`），不假設一次 `data` = 一個 message
- `ensureHubDir`: hub startup 時 `chmodSync(HUB_DIR, 0o700)` 強制修正既有目錄權限
- Stale cleanup: lockfile pid dead + socket exists → 直接 unlink；lockfile absent + socket exists → 直接 unlink
- Lockfile timing: `writeHubLock` 在 socket listen 成功之後才寫
- Windows: hub mode entry 加 `win32` guard → force standalone（不能只跳 socket）
- 410 body: 含 migration hint `{"error":"gone","message":"Upgrade ccxray to use socket-based hub IPC"}`
- Signature: grep 所有 registerClient/unregisterClient caller，逐個確認傳 lock object

### Tasks
- [x] 1.1 Add `SOCK_PATH` constant to hub.js (`path.join(HUB_DIR, 'hub.sock')`)
- [x] 1.2 Implement `cleanupStaleSocket()`: pid cross-check + connect probe + unlink
- [x] 1.3 Implement `createHubSocket()`: `net.createServer` + line-buffered newline-JSON framing
- [x] 1.4 Socket chmod `0600` after `listen()` completes; `chmodSync(HUB_DIR, 0o700)` on hub startup
- [x] 1.5 Add `sockPath` to `hub.json` lockfile (written after BOTH http + socket listen succeed)
- [x] 1.6 Implement socket command handlers: `register`, `unregister`, `health`, `bootstrap-token`, `status`
- [x] 1.7 Implement `hubSocketRequest(sockPath, msg)`: line-buffered client, 3s timeout
- [x] 1.8 Rewrite `registerClient(lockInfo, pid, cwd)` — lockInfo object w/ sockPath → socket; number → HTTP fallback
- [x] 1.9 Rewrite `unregisterClient(lockInfo, pid)` — same pattern
- [x] 1.10 Rewrite `discoverHub` health check: socket connect probe when `lock.sockPath` present
- [x] 1.11 Rewrite `ccxray open` bootstrap-token request to use socket
- [x] 1.12 Rewrite `ccxray status` to use socket for hub status query
- [x] 1.13 HTTP `/_api/hub/register`, `/_api/hub/unregister`, `/_api/hub/bootstrap-token`, `/_api/hub/status` → 410 Gone (with migration hint body)
- [x] 1.14 HTTP `/_api/health` remains alive (dashboard + orphan probe need it)
- [x] 1.15 Graceful shutdown: close socket server + explicit `unlinkSync` fallback
- [x] 1.16 Crash recovery: `cleanupStaleSocket()` called before `createHubSocket()`
- [x] 1.17 Windows guard: hub mode on `win32` → reject with message, force standalone
- [x] 1.18 Update all `registerClient`/`unregisterClient` callers in index.js (incl. `startHubMonitor` recovery callback)
- [x] 1.19 TDD: socket lifecycle (create, connect, stale cleanup, chmod verification)
- [x] 1.20 TDD: line-buffered framing (partial reads, multi-message in one chunk)
- [x] 1.21 TDD: all 5 commands via socket round-trip
- [x] 1.22 TDD: 410 responses on deprecated HTTP hub routes
- [x] 1.23 TDD: hubSocketRequest timeout on dead socket
- [x] 1.24 TDD: registerClient/unregisterClient signature — first arg must be object
- [x] 1.25 Integration: existing hub tests (`test/hub*.test.js`) adapted
- [x] 1.26 Smoke test: isolated CCXRAY_HOME, forkHub + waitForHubReady + socket connect + register 2 clients

## 2. `ccxray secret upstream` CLI command (commit 2.1 附帶)

- [x] 2.0 Add `secret upstream` subcommand to CLI section in `server/index.js` (~10 LOC wrapping `getUpstreamToken()`)
- [x] 2.0.1 TDD: `ccxray secret upstream` prints base64url token to stdout and exits 0

## 3. Upstream enforcement (commit 2.2, semver-major → 2.0.0)

### Pre-implementation review (2026-05-27)
- 3.1 (`_matchesLegacyToken` extract): downgraded to optional cleanup — `verifyUpstream` will be rewritten to not use `authMiddleware` at all, so dedup is moot for 2.2
- `verifyUpstream` must NOT `if (!AUTH_TOKEN) return true` — ephemeral mode still requires `X-Ccxray-Auth` validation via local-secret-derived K_upstream
- `classifyUpstreamAuth` in ws-proxy.js only checks header *presence*, not value. Phase 2.2 must verify the HMAC value (via `compareSecret`) or a forged header bypasses enforcement
- `isAuthorized` in ws-proxy.js needs access to `getSecrets()` from auth.js — new cross-module dependency

### Tasks
- [ ] 3.1 ~~Extract `_matchesLegacyToken(req)` shared helper~~ → deferred (optional cleanup, not blocking)
- [ ] 3.2 Extract `_verifyUpstreamCredential(headers)` → `'ok'|'chatgpt-oauth'|'reject'` pure function in auth.js (shared by HTTP verifyUpstream + WS isAuthorized)
- [ ] 3.3 `verifyUpstream`: rewrite using `_verifyUpstreamCredential` — HMAC-verify `X-Ccxray-Auth`, ChatGPT-OAuth carve-out, reject all other (no `authMiddleware` fallback)
- [ ] 3.4 `verifyUpstream`: works in ephemeral mode (no AUTH_TOKEN) — K_upstream derived from local-secret
- [ ] 3.5 `isAuthorized` (ws-proxy.js): rewrite using `_verifyUpstreamCredential` — same logic, different response path (`writeSocketResponse` instead of `res.writeHead`)
- [ ] 3.6 Remove warn-only path: `classifyUpstreamAuth` `'warn'` log in ws-proxy.js L334-336 → delete (reject handled by `isAuthorized` now)
- [ ] 3.7 `classifyUpstreamAuth` role change: demote to log-classification-only (not used in auth decisions); update callers
- [ ] 3.8 Remove deprecation-header code from `verifyUpstream` (`setDeprecation` calls, `whichLegacyMechanism` on upstream path)
- [ ] 3.9 `package.json` version bump to 2.0.0
- [ ] 3.10 CHANGELOG entry: breaking change + migration guide (reference `ccxray secret upstream`)
- [ ] 3.11 TDD: AUTH_TOKEN set + valid X-Ccxray-Auth → accepted
- [ ] 3.12 TDD: AUTH_TOKEN set + no X-Ccxray-Auth → 401
- [ ] 3.13 TDD: AUTH_TOKEN set + forged X-Ccxray-Auth (wrong value) → 401
- [ ] 3.14 TDD: ChatGPT-OAuth path (chatgpt-account-id + JWT, no X-Ccxray-Auth) → accepted
- [ ] 3.15 TDD: WS upgrade without auth → rejected (not just warned)
- [ ] 3.16 TDD: WS upgrade with valid X-Ccxray-Auth → accepted
- [ ] 3.17 TDD: WS upgrade with forged X-Ccxray-Auth → rejected
- [ ] 3.18 TDD: ephemeral mode (no AUTH_TOKEN) + valid X-Ccxray-Auth → accepted
- [ ] 3.19 TDD: ephemeral mode + no X-Ccxray-Auth → 401
- [ ] 3.20 Smoke test: real proxy + launched claude/codex, verify API calls succeed

## 4. Dashboard enforcement + ephemeral mode (commit 2.3, version 2.1.0)

- [ ] 4.1 `verifyDashboard`: reject if no valid cookie and no valid X-Ccxray-Auth
- [ ] 4.2 Keep `Authorization: Bearer <AUTH_TOKEN>` acceptance on dashboard (permanent per spec)
- [ ] 4.3 Ephemeral mode default: when AUTH_TOKEN unset, auth still required (via local-secret)
- [ ] 4.4 `CCXRAY_LOOPBACK_NO_AUTH=1` env: bypass all auth checks for loopback requests
- [ ] 4.5 Startup banner when CCXRAY_LOOPBACK_NO_AUTH=1 is active (loud warning)
- [ ] 4.5a `/_auth/bootstrap-token` HTTP endpoint → require auth (codex R3 P1 deferred from 2.1)
- [ ] 4.6 `package.json` version bump to 2.1.0
- [ ] 4.7 TDD: dashboard without cookie → 401
- [ ] 4.8 TDD: dashboard with cookie → 200
- [ ] 4.9 TDD: CCXRAY_LOOPBACK_NO_AUTH=1 → loopback bypass works
- [ ] 4.10 TDD: non-loopback request with CCXRAY_LOOPBACK_NO_AUTH → still rejected
- [ ] 4.11 Smoke test: fresh CCXRAY_HOME, no AUTH_TOKEN → dashboard requires ccxray open

## 5. PR + review

- [ ] 5.1 Open PR (feat/auth-phase-2 → main)
- [ ] 5.2 Codex review gate
- [ ] 5.3 Merge after APPROVE
- [ ] 5.4 Note Windows limitation in PR description (hub mode requires Unix socket; Windows falls back to standalone)
