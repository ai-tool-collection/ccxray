# Pre-Mortem — A1-A3 Write-Path Abstraction

**Date**: 2026-06-03
**Status**: Reviewed (grounded in actual code: forward.js 4 sites, sse-broadcast, restore)
**Companion to**: `2026-06-03-codex-write-path-abstraction-design.md`

> Imagine A1-A3 shipped and broke ccxray. Working backward, here's why it would have.

## Risk Summary
- **Tigers**: 9 (5 launch-blocking: T1-T4 + T8; 4 fast-follow/track: T5-T7 + T9)
- **Paper Tigers**: 3
- **Elephants**: 3
- (T8 WS-restore-as-SSE and the T2 credential-timing pitfall added on codex's 2nd review.)

## Grounded finding driving the Tigers

The 4 current index-line writers do **not** all persist the same field set, and the
in-memory `entry` carries fields the index line omits:

- Anthropic entry has `method, url, tokens, duplicateToolCalls` → **not** in its index line.
- `sse-broadcast.summarizeEntry` broadcasts `method, url, tokens, duplicateToolCalls`
  (live) but they're **never persisted** → restored entries already lack them today.
- OpenAI SSE / non-SSE index lines hard-write `cost:null` / `maxContext:null` even when
  the entry has real values (the drift we're fixing).
- `responseMetadata` exists only on OpenAI/WS entries (from
  `normalizeOpenAIResponseSummary`), never on Anthropic.

So a single `buildIndexLine(entry)` = `pick(entry, INDEX_FIELDS)` will **change the
persisted shape per provider** unless `INDEX_FIELDS` is derived as the exact union of
what the 4 writers persist today (plus the deliberate `responseMetadata` addition).
This is the central risk the mitigations target.

## Launch-Blocking Tigers

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| T1 | `INDEX_FIELDS` ≠ union of the 4 current index lines → a field currently persisted gets silently dropped (restore regression) or a per-provider field newly appears | High | High | Derive `INDEX_FIELDS` from the **actual** 4 field sets. Golden-file test per provider with a **4-part rule** (codex, stronger than superset): (1) every **legacy persisted key** is present; (2) **new keys** appear only if in an explicit allowlist — `{OpenAI: responseMetadata, cost, maxContext}` (the deliberate fixes); (3) **excluded keys** absent — `req, res, tokens, duplicateToolCalls, method, url, _*`; (4) legacy key **values** `deepEqual` the old line except the allowlist fixes. (Plain superset is too weak — it would let `tokens` leak into the index.) Phase 3b① swaps the writer **without moving field computation** so the diff is auditable. NOT byte-exact (key order + the OpenAI fixes would false-red). |
| T2 | entry assembly split (caller fields vs `buildEntryFields`) drops/duplicates a field, **or** `hasCredential`/`toolSources` get computed after `req`/`res` are nulled → blank security/tool signals | Med | High | Test: assembled entry's key set ⊇ `INDEX_FIELDS` for every (provider × transport). Caller owns exactly `id,ts,receivedAt,elapsed,isSSE,status,method,url`; parser owns the rest. No-overlap assertion. **Codex pitfall**: `hasCredential`/`toolSources` are computed today on the FULL entry (with `req`/`res`) *before* release — `buildEntryFields` must receive full `req/res/events` in `ctx` and compute them *before* the caller nulls `req/res`. Assert non-blank for a credential-bearing fixture. |
| T3 | Touching `forward.js` Anthropic SSE breaks HUD / intercept-modification **stream** injection (≈493-555) | Med | High | Anthropic SSE migrated **last** (3b④); only post-`clientRes.end()` assembly (≈563+) is moved. Existing intercept/HUD tests must stay green. Browser smoke of a live Claude intercept + HUD turn. |
| T8 | **WS restore mis-classified as SSE** (codex). `restore.js:133` runs `normalizeOpenAIResponseSummary` for OpenAI when `!meta.isSSE`. Harmless today (WS resLog rarely yields `events[i].data.response`), but if 3b makes WS `responseEvents` capture a fuller response envelope, `normalizeOpenAIResponseSummary`'s `Array.isArray(resData)` assumption may treat it as SSE and flip `isSSE`→true, polluting WS restored shape | Med | High | When `responseMetadata.transport === 'websocket'`, normalize must **not** flip `isSSE` to true. Add a WS restore regression: after restore, `isSSE === false` and `responseMetadata.transport === 'websocket'` are preserved. |
| T4 | The real `:5577` monitoring hub hot-reloads from **this working tree** (a `--watch` dev hub), so editing `forward.js` breaks the live session mid-work | ~~Med~~ → **Low (checked 2026-06-03)** | High | **CHECK PASSED**: `:5577` listener (pid 70826) is plain `node server/index.js`, **not** `--watch` → editing `server/` does **not** hot-reload the live hub. Residual: if the hub restarts mid-refactor it loads partial code (low). Still do ALL build+verify on the **isolated smoke server** (separate port + `CCXRAY_HOME`); re-run this check if the hub is restarted. |

## Fast-Follow / Track Tigers

| # | Risk | Impact | Planned Response |
|---|------|--------|-----------------|
| T5 | Test fixtures miss field-drop-prone cases (titleGen title, subagent, thinkingStripped, WS frames) → consistency test passes but real turns lose fields | Med | Extend fixtures to cover: subagent (no cwd), titleGen, thinking present/stripped, OpenAI SSE with usage, WS with tool call. Consistency test runs across all. |
| T6 | OpenAI maxContext now persisted real → interaction with `restore.js:148` re-inference (anthropic-only) | Low | Verify restore doesn't double-handle; OpenAI value is already correct so no re-infer needed. Add OpenAI restore assertion. |
| T7 | browser-harness Miller-column **click** nav was unreliable in the Step-2 smoke (clicks didn't switch project) | Med | Use deep-link `?e=<entryId>&sec=timeline` URLs (proven to work) for verification, not blind clicks. |
| T9 | 3c `registerPromptVersion` move drops `coreHash` from the entry (codex) — `versionIndex` still populated but the turn-card `coreHash` goes blank if registration no longer produces it before entry assembly | Med | `registerPromptVersion(ctx)` must still produce/return `coreHash` **before** entry assembly so `buildEntryFields` includes it. Assert `coreHash` present on an Anthropic entry post-3c. |

## Paper Tigers

- **"responseMetadata in INDEX_FIELDS bloats the index."** Tens of bytes per OpenAI/WS
  entry, and it **fixes** restore detail loss. Becomes real only if it ever holds large
  payloads — it doesn't (it's a thin summary). Manageable.
- **"654+ tests will break en masse."** If 3b① emits byte-identical (or superset) index
  lines, tests don't change. Only becomes real if `INDEX_FIELDS` diverges from current
  output — which T1's golden-file test catches first.
- **"per-parser buildEntryFields duplicates logic."** Intended (codex's call); shared
  helpers extracted **after** the 3 paths stabilize. Not a risk, a sequencing choice.

## Elephants in the Room

- **E1 — `forward.js` is the most dangerous file in the repo** (auth header stripping +
  HUD + intercept + recording), and the session records *itself* through it. The scary
  failure is **silent mis-record** (no crash, wrong data), which unit tests for "it runs"
  won't catch. *Starter:* "do we have a golden-file test that locks the exact index line
  per provider, so a silent field drift fails CI?" → yes, make T1's test that.
- **E2 — we're refactoring code shipped as "COMPLETE" days ago**, interleaved with 77
  unpushed auth+abstraction commits. Risk of compounding on unverified ground. *Mitigation:*
  the Step-2 gap ledger is our verified baseline — trust it, not the old "COMPLETE" docs.
- **E3 — this is "Codex parity" work but it edits the Anthropic path too.** A regression
  could land on Claude users. *Mitigation:* the browser-harness completion gate verifies
  **both** Claude and Codex, live↔restore — not Codex alone.

## Browser-harness completion gate (user-mandated)

Per the user: implementation is not "done" until verified in browser-harness. Protocol:

1. Isolated smoke server (`CCXRAY_HOME=/tmp/... --port <free>`), never `:5577`.
2. Generate **real** traffic both providers: `codex exec -c openai_base_url=…` and a
   Claude turn via `ANTHROPIC_BASE_URL=localhost:<port>` (or seed real logs).
3. Open dashboard via deep-link `?e=<entryId>` (not clicks). Screenshot timeline.
4. **Restart same `CCXRAY_HOME`** → re-open same entries → screenshot.
5. Assert live screenshot == restore screenshot for: context bar (maxContext), cost,
   stopReason, tool chips, timeline steps — for **both** providers.
6. Tear down smoke server; confirm `:5577` untouched.

## Go/No-Go Checklist
- [x] No `--watch` dev hub serving `:5577` from this tree (T4) — checked 2026-06-03, pid 70826 is plain `node server/index.js`
- [ ] `INDEX_FIELDS` golden-file test green: legacy keys exact, new keys allowlisted, excluded keys absent, legacy values deepEqual (T1)
- [ ] Assembled-entry key-set test green + `hasCredential`/`toolSources` computed before req/res release (T2)
- [ ] Intercept/HUD tests green + live Claude intercept smoke (T3)
- [ ] WS restore regression: `isSSE` stays false, `responseMetadata.transport==='websocket'` preserved (T8)
- [ ] `coreHash` present on Anthropic entry after 3c (T9)
- [ ] Fixtures cover subagent/titleGen/thinking/WS (T5)
- [ ] Full `node --test` suite green
- [ ] browser-harness live↔restore gate passed for **both** Codex and Claude
- [ ] Rollback: each phase is its own commit; revert is `git revert <phase commit>`
