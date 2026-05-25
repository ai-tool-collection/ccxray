# Errata — review findings against candidate-AB.md

**Reviewer:** Codex CLI v0.133.0-alpha.1 (gpt-5.5), independent pass on this PR.
**Date:** 2026-05-25.

This file records concrete corrections to `candidate-AB.md` that surfaced during external review and empirical verification. The original `candidate-AB.md` is preserved as the historical record of the reason loop's winning synthesis; the deviations below are what the implementation will actually ship.

---

## 1. Blocking corrections

### 1.1 HttpOnly cookie + JS `document.cookie` check are mutually exclusive

`candidate-AB.md` §2.3 Flow B (around L132) and §3.2 (around L261) describe:

- `Set-Cookie: ccxray_s=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
- Inline bootstrap script: `else if (!document.cookie.includes('ccxray_s=')) { ... }`

These are incompatible. `HttpOnly` cookies are intentionally invisible to JavaScript; `document.cookie` will never contain `ccxray_s=`, so the "no session" branch fires regardless of whether a valid cookie exists.

**Implementation deviation.** Replace the `document.cookie.includes(...)` probe with a server-side auth-status endpoint:

```js
const status = await fetch('/_auth/status', { credentials: 'same-origin' });
if (status.status === 401) document.body.textContent = 'No session. Run `ccxray open`.';
```

The cookie remains `HttpOnly` (XSS-in-conversation defense preserved). Cost: one extra GET on cold load, no server-side state change. The new endpoint costs ~10 LOC and lives in `server/routes/auth.js`.

Affected commits: **1.3** (bootstrap flow), **3.1** (final cleanup).

### 1.2 `net.Socket._handle.getpeereid` is not a public Node API

`candidate-AB.md` §3.7 (around L394) claims Node ≥ 18 on Linux/macOS exposes `socket._handle.getpeereid`. Verified locally on Node v22.22.2/darwin — the method does not exist on `pipe_wrap.Pipe.prototype` nor on the `net` public API. There is no public Node interface to read `SO_PEERCRED`/`getpeereid(2)` without a native addon.

**Implementation deviation.** Defend peer identity at the **filesystem layer**, not the Node API:

- `~/.ccxray/` mode `0700` (already in plan).
- `~/.ccxray/hub.sock` mode `0600`.
- Other UIDs receive `EACCES` from `connect(2)` at the kernel; the connection never reaches Node code.

The peer-UID claim downgrades from "primary gate" to "belt-and-suspenders we cannot ship without a native addon (out of scope per zero-new-deps constraint)." The threat model is preserved because filesystem permissions are the actual access control on local Unix sockets — peer-credential checks would only catch a same-UID attacker, which is outside this design's scope.

Affected commit: **2.3** (Unix socket hub IPC).

### 1.3 Codex CLI key name is `http_headers`, not `request_headers`

`candidate-AB.md` §3.5 (around L366) writes:

> `-c request_headers='X-Ccxray-Auth=<K_upstream>'` via the codex per-request-header config. Verified to propagate to the WebSocket upgrade HTTP request.

Empirical verification against Codex v0.133.0-alpha.1:

```
$ codex exec --strict-config -c 'request_headers={X-Ccxray-Auth="test"}' "x"
Error loading config.toml: unknown configuration field `request_headers` in -c/--config override
```

Codex does support header injection, but through `model_providers.<name>.http_headers` (plus `env_http_headers` for env-derived headers) and a top-level `model_provider = "<name>"` selecting which provider applies. Verified by spy-server test — `X-Ccxray-Auth: test-value-123` did appear on the outbound HTTP request.

**Implementation deviation.** ccxray's Codex launcher (Phase 1.4) should construct overrides like:

```js
codex \
  -c 'model_providers.ccxray={name="ccxray", base_url="http://localhost:5577/v1", wire_api="responses", http_headers={"X-Ccxray-Auth"="<K_upstream>"}}' \
  -c 'model_provider="ccxray"' \
  ...args
```

Open question (resolve before Commit 1.4):

- Forcing `model_provider="ccxray"` switches Codex to API-key mode, which **bypasses ChatGPT OAuth login**. Users on `chatgpt_base_url` will lose their OAuth session. Need to investigate whether builtin providers (`openai`, `chatgpt`) accept a partial `http_headers` override without losing their other fields. If they do not, we either (a) replicate the full provider config for each, or (b) require `OPENAI_API_KEY` and document that ccxray on ChatGPT auth needs an additional setup step. The current ccxray launcher in `server/providers.js` already does `-c chatgpt_base_url=...` alongside `openai_base_url=...`; the header-injection version must preserve both paths.

Affected commits: **1.4** (warn-only launcher injection), **2.1** (mandatory enforcement).

---

## 2. Non-blocking corrections

### 2.1 Threat-table residual risks overstated

`candidate-AB.md` §4 (around L429–L434) marks the residual risk for threats 1, 2, and 6 as "None." That phrasing is stronger than the architecture warrants: "no residual risk if Host allowlist, CORS denial, and header injection are implemented as specified" is more accurate. The mitigations are structural and high-quality, but calling them "None" reads as a guarantee, not a defense.

**Implementation deviation.** None at the code level. README + commit messages use the more careful phrasing.

### 2.2 Cookie name inconsistency between `overview.md` and `candidate-AB.md`

- `overview.md` L19: `ccxray_session=<payload>.<HMAC(K_session, payload)>`
- `candidate-AB.md` L231: `ccxray_s = base64url(payload) "." base64url(hmac)`

**Implementation deviation.** Pick **`ccxray_s`** (shorter, lower per-request header overhead; matches the more detailed spec). Update `overview.md` to match — single-line fix.

### 2.3 Phase 1 "no breakage" claim relies on launcher injection working

If Phase 1.4 launcher injection fails (e.g. user's Codex version doesn't take `model_providers.X.http_headers`), Phase 1 verifyUpstream still accepts legacy bearer/no-credential so spawned CLIs remain unbroken. The "no breakage" property holds during Phase 1 specifically because enforcement is deferred to Phase 2. This is correct in the design but worth restating in commit messages.

**Implementation deviation.** None.

---

## 3. Out-of-scope finding worth filing separately

During the empirical Codex test, spawning Codex with `model_provider="ccxray"` and a `base_url` pointing at a localhost spy server caused Codex to attach the user's **ChatGPT OAuth JWT** (full bearer + `chatgpt-account-id`) to the outbound request, despite the provider config not naming `chatgpt`.

This is a credential-leak surface in Codex itself, not in ccxray. It is unrelated to this migration but should be filed upstream and is a reminder that ccxray's own logging must always redact `Authorization` and `chatgpt-account-id` headers (already in plan).

---

## 4. What changes in the implementation plan

| Commit | Original plan | Revised plan |
|---|---|---|
| 1.3 | Inline `document.cookie.includes('ccxray_s=')` probe | `GET /_auth/status` probe (+10 LOC, new endpoint in `server/routes/auth.js`) |
| 1.4 | `-c request_headers='X-Ccxray-Auth=…'` for Codex | `-c 'model_providers.ccxray={…, http_headers={…}}'` + `-c 'model_provider="ccxray"'`; **plus a spike before Commit 1.4 to resolve the ChatGPT-OAuth-bypass question above** |
| 2.3 | peer-UID via `socket._handle.getpeereid` | Filesystem mode `0600` socket + `0700` parent dir as the real gate; no Node-API peer-credential check |
| Docs | Threat table claims "None" residuals | Use "low residual risk if X is implemented as specified" |
| Docs | `ccxray_session` (in `overview.md`) | Standardize on `ccxray_s` |

No commit is added or removed. The total surface remains 8 commits across Phases 1–3.
