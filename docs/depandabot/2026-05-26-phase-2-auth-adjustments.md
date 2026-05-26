# depandabot audit — Phase 2 Auth Adjustments

## §1 Current State

1. **Phase 1 complete on `feat/auth-phase-1`** (commits `cbd083e`→`803d91a`, 589 tests green). Launcher injects `X-Ccxray-Auth`, WS gate classifies + warns, internal headers stripped before upstream. Pushed, not yet merged to main. (`server/providers.js:15-79`, `server/ws-proxy.js:489-520`)

2. **`verifyUpstream` exists in warn-only mode** (`server/auth.js:364-371`). It calls legacy `authMiddleware` under the hood and adds deprecation headers. Flipping to enforce = changing the fallback from `authMiddleware(req, res)` to a 401 rejection when `X-Ccxray-Auth` is absent.

3. **Hub IPC is 100% HTTP-over-TCP** (`server/hub.js`, 533 LOC). Routes: `/_api/hub/register`, `/_api/hub/unregister`, `/_api/hub/bootstrap-token`, `/_api/hub/status`, `/_api/health`. Client discovery reads `hub.json` for `{port, pid}` and makes HTTP calls. No Unix socket code exists yet.

4. **The spec explicitly supports "optional remote deployment"** behind a TLS terminator (Tailscale Serve, Caddy, nginx). The `CCXRAY_PUBLIC_ORIGINS` env var is designed for this. (`reason/260525-0055-ccxray-auth-design/task.md:13`, `candidate-A.md:370`)

5. **`_isLoopbackPeer(req)` already exists** in `server/hub.js:370-373` — checks `req.socket.remoteAddress` only. Used to gate `/_api/hub/bootstrap-token`.

## §2 Intended Goal

Should we proceed with the three Phase 2 adjustments I proposed:
(a) adding dual-direction loopback check (`localAddress` + `remoteAddress`) to `isLoopbackChatGPTCodex`,
(b) splitting 2.3 into sub-commits 2.3a/2.3b/2.3c,
(c) stating that the verifyUpstream flip is "just a flag"?

## §3 Current Plan

1. **2.1**: Flip `verifyUpstream` from warn→reject for requests without `X-Ccxray-Auth`. Add `isLoopbackChatGPTCodex(req)` helper checking `(a) req.socket.remoteAddress is loopback, (b) req.socket.localAddress is loopback, (c) Authorization is JWT-shaped, (d) chatgpt-account-id present`. The dual-loopback check prevents the reverse-proxy bypass.
2. **2.2**: Dashboard enforcement + ephemeral mode default. Straightforward.
3. **2.3a**: Create `hub.sock` Unix socket listener + framed IPC protocol (register/unregister/health/bootstrap-token) running parallel to existing HTTP.
4. **2.3b**: Client code prefers socket over HTTP when `hub.json` reports `sockPath`.
5. **2.3c**: HTTP `/_hub/*` routes return 410 Gone.

## §4 Missing Directional Confirmations

1. **[assumption]** `req.socket.localAddress` reliably reflects the actual bind address even when Node's HTTP server listens on `0.0.0.0`. (If it reflects the wildcard, the check is useless.)
2. **[risk]** The dual-loopback check (`localAddress` + `remoteAddress`) is the **exact same pattern** that OpenClaw (GHSA-xc7w-v5x6-cc87) found to be bypassable behind a reverse proxy. When a TLS terminator connects to ccxray over loopback, BOTH `localAddress` and `remoteAddress` are `127.0.0.1` — the attacker's traffic arrives looking fully loopback.
3. **[unknown]** Whether splitting 2.3 into 3 sub-commits is necessary vs the existing hub.js complexity. The file is 533 LOC — is it really that coupled?
4. **[assumption]** The verifyUpstream flip is "just a flag change" — but the ChatGPT-OAuth carve-out adds a new code path that needs its own tests and can introduce regressions.
5. **[risk]** `isLoopbackChatGPTCodex` creates a permanent authentication exemption that no amount of header checking can secure against a same-host reverse proxy. The spec explicitly documents remote deployment as supported.

## §5 Evidence & Arguments

1. **[OpenClaw GHSA-xc7w-v5x6-cc87](https://github.com/openclaw/openclaw/security/advisories/GHSA-xc7w-v5x6-cc87)** — Real-world CVE where loopback `remoteAddress` trust was bypassed by a same-host reverse proxy (Tailscale Serve, nginx). The fix was to **remove loopback-based auth bypass entirely** and always require the shared secret. → §4.2, §4.5

2. **[Node.js net documentation](https://nodejs.org/api/net.html)** — Confirms `socket.localAddress` reflects the specific interface the connection arrived on (not the wildcard). When server listens on `0.0.0.0` and client connects to `127.0.0.1`, localAddress is `127.0.0.1`. → §4.1

3. **[Express behind proxies](https://expressjs.com/en/guide/behind-proxies/)** — Documents that behind a reverse proxy, `req.socket.remoteAddress` shows the proxy's address (loopback for same-host proxies). This is the architectural reason loopback checks fail as security gates when proxied. → §4.2

4. **[Unix Domain Sockets in Node (Krun.Pro, Apr 2026)](https://medium.com/@krun_dev/unix-domain-sockets-in-node-749b3b7319e5)** — Confirms that UDS with filesystem permissions (`0600`) is the standard Node.js approach for same-machine IPC access control. No need for complex peer-UID detection. → §3.3-§3.5

5. **[Dissent: errata §1.3 already acknowledges the residual risk]** — The errata explicitly states the ChatGPT-OAuth carve-out has residual "cost amplification / log pollution" risk from other-UID local attackers, and calls the mitigation primitive "bind ccxray to a Unix socket." This means the spec designers already accepted that loopback-check is imperfect — but they accepted it as a Phase 1 tradeoff, not a permanent architecture. The dual-loopback "improvement" I proposed doesn't actually improve the security property; it just adds code. → §4.5, §3.1

## §6 Second Opinion

### Round 1 — Reviewer verdict: OBJECT

| ID | Severity | Category | Summary |
|----|----------|----------|---------|
| O1 | high | conceptual | Dual-loopback check is security theater; OpenClaw CVE is direct evidence. Behind a same-host reverse proxy both addresses are 127.0.0.1. Either require secret on every request or use Unix sockets. |
| O2 | medium | conceptual | "Just a flag" understates the ChatGPT-OAuth carve-out work — a permanent exemption with 4 conjunctive conditions needs its own test matrix. |
| O3 | low | implementation | Splitting 2.3 into 3 sub-commits for 533 LOC is unnecessary ceremony. |

### Claude's response:

- **O1 (conceptual): ACCEPT → REFRAME.** The dual-loopback check I proposed adds zero real security. The OpenClaw CVE proves the pattern is broken. The errata already identified the real fix (Unix socket). My proposal was adding code without adding defense.

- **O2 (conceptual): ACCEPT → REFRAME.** The ChatGPT-OAuth carve-out is not a flag flip — it's a new authentication exemption that needs comprehensive testing. Calling it "just a flag" would lead to under-scoping.

- **O3 (implementation): ACCEPT → AMEND.** 2.3 will be a single commit.

### Terminal state

Two conceptual objections accepted → loop terminates immediately.

**REFRAME**

### What needs to change before Phase 2 proceeds:

1. **Drop the dual-loopback proposal entirely.** `isLoopbackChatGPTCodex` should NOT use `localAddress`/`remoteAddress` as security gates. The ChatGPT-OAuth carve-out in 2.1 must be redesigned:
   - Option A: Accept the ChatGPT-OAuth path is unauthenticated-by-design until Unix socket binding (2.3) closes the multi-UID hole. Keep `classifyUpstreamAuth` returning `chatgpt-oauth` and exempt it from 401, but document it as an accepted residual risk, not a security check.
   - Option B: Reorder Phase 2 so 2.3 (Unix socket) lands BEFORE 2.1 (enforcement). Once ccxray binds to a Unix socket, there is no multi-UID attack surface and the ChatGPT-OAuth carve-out doesn't need IP checks at all.

2. **Scope the ChatGPT-OAuth carve-out as a real feature with its own test plan**, not as a footnote on the verifyUpstream flip. Write the test matrix before writing the code.

3. **2.3 is a single commit**, not three.
