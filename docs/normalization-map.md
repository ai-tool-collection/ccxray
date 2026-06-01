# ccxray Normalization Map

> How ccxray maps wire protocol fields to its internal model.
> Read [Wire Protocol Reference](wire-protocol-reference.md) first for what each agent sends on the wire.
> This document covers what ccxray **does** with those fields.

**Version baseline**: ccxray 1.10.x · 2026-06-01

---

## Dispatch Architecture

ccxray uses a two-layer dispatch: `WIRE_PARSERS` (server) and `RENDERERS` (client).

```
Wire traffic → server/config.js getUpstreamForRequestAndHeaders()
             → upstream.provider ("anthropic" | "openai")
             → server/wire-parsers/{provider}.js    ← server-side normalization
             → public/renderers/{provider}.js        ← client-side event rendering
```

| Layer | Registry | Source | Dispatch key |
|-------|----------|--------|-------------|
| Server: `WIRE_PARSERS` | `server/wire-parsers/index.js` | `{ anthropic, openai }` | `upstream.provider` |
| Client: `RENDERERS` | `public/renderers/index.js` | `{ anthropic, openai, fallback }` | `entry.provider` |

Each `WIRE_PARSERS` module exports the same interface:

| Method | Purpose |
|--------|---------|
| `isNoiseRequest(url, headers, body)` | Filter startup/platform noise |
| `normalizeListMeta(entry)` | Raw stored entry → thin canonical for index |
| `extractUsage(resData)` | Response data → `{input_tokens, output_tokens}` |
| `extractAgentType(systemBlob, headers)` | → `{key, label}` for agent classification |
| `detectSession(req, headers, body)` | → `{sessionId, isNewSession, inferred}` |
| `preprocessBody(body, headers)` | Inject header-derived metadata into body before storage |

---

## 1. Session Detection

### Claude Code (Anthropic)

```
body.metadata.session_id → store.detectSession(body)
```

Single source. `wire-parsers/anthropic.js:detectSession` delegates directly to `store.detectSession`.

### Codex (OpenAI)

Priority chain (`wire-parsers/openai.js:getCodexSessionId`):

```
1. header "session_id" or "x-openai-session-id"
2. header "x-codex-turn-metadata" → JSON parse → .session_id
3. body.metadata.session_id
4. fallback → "codex-raw" (synthetic bucket for non-session HTTP requests)
```

`preprocessBody` (`withCodexMetadata`) merges header-derived `session_id` and `agent_type` into `body.metadata` so downstream code can treat both providers uniformly.

### Subagent detection

| Provider | Method | Source |
|----------|--------|--------|
| Anthropic | Heuristic | Absence of `cwd` in system prompt (`forward.js:309`) |
| OpenAI | Explicit | Header `x-openai-subagent` / `x-openai-agent-type` / body `metadata.is_subagent` |
| OpenAI | Agent types | `explorer` → subagent, `worker` → subagent, `default` → main |

---

## 2. Working Directory (CWD)

### Claude Code

Extracted from system prompt content via regex in `store.extractCwd(parsedBody)`.

### Codex

Extracted from `x-codex-turn-metadata` header → `workspaces` object (`ws-proxy.js:getWorkspaceCwd`).

Fallback chain:

```
1. workspaces.cwd (string)
2. workspaces.current (string)
3. First string value in workspaces
4. First nested object with .cwd field
5. First key starting with "/" ← Codex actual format (key IS the path)
```

Step 5 is the workaround for Codex's `{ "/path/to/project": { metadata } }` format where the key itself is the cwd.

---

## 3. Tool Call Extraction

### Claude Code

`helpers.js:extractToolCalls(messages)` — scans `messages[].content[]` for `type:"tool_use"` blocks, counts by `name`.

### Codex

`helpers.js:extractOpenAIToolCalls(responseEvents)` — scans WS response events for `response.output_item.done` and `response.output_item.added` with `item.type:"function_call"`.

Dedup: by `item.call_id` or `item.id` to avoid double-counting `.added` + `.done` for the same call.

Server-side alias map (`helpers.js:OPENAI_TOOL_ALIASES`):

```js
{ exec_command: 'Bash', shell: 'Bash', read_mcp_resource: 'Read', apply_patch: 'Edit' }
```

Client-side mirror (`messages.js:CODEX_TOOL_ALIASES`) — same map, used for timeline rendering and tool preview.

Guard: meta-tools (`tool_search`, `web_search`, `image_generation`) have no `.name` field — both extraction functions check `rawName` before accessing.

---

## 4. Tool Call Display (Client)

`public/messages.js:buildMergedSteps(messages, resEvents, provider)` builds the unified timeline:

| Phase | Input | Action |
|-------|-------|--------|
| Detect OpenAI | `messages[0].type === "message"` | → `normalizeOpenAIInput(messages)` converts to Anthropic shape |
| Phase 1a | User messages | Build `tool_use_id → tool_result` map |
| Phase 2 | All messages | Emit `human`, `assistant-text`, `tool-group` steps |
| Phase 3 | `resEvents` | Dispatch to `RENDERERS[provider].processEvent()` for current-turn events |

`normalizeOpenAIInput` conversion:

| OpenAI input item | → Anthropic message |
|-------------------|---------------------|
| `{type:"message", role:"developer"}` | Skipped |
| `{type:"message", role:"user"\|"assistant"}` | `{role, content:[{type:"text", text}]}` |
| `{type:"function_call_output", call_id, output}` | `{role:"user", content:[{type:"tool_result", tool_use_id:call_id, content:output}]}` |

---

## 5. Cost Calculation

`pricing.js:calculateCost(usage, model)` — identical call for both providers.

| Provider | Usage source | Fields used |
|----------|-------------|-------------|
| Anthropic | `message_start.message.usage` + `message_delta.usage` merged | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| OpenAI (HTTP) | `response.usage` from SSE events or response body | `input_tokens` (or `prompt_tokens`), `output_tokens` (or `completion_tokens`) |
| OpenAI (WS) | `ctx.lastUsage` captured before `WS_SKIP_EVENTS` filter | Same as HTTP |

`wire-parsers/openai.js:extractUsage` normalizes `prompt_tokens` → `input_tokens` and `completion_tokens` → `output_tokens`.

OpenAI has no `cache_creation_input_tokens` equivalent. `cache_read_input_tokens` maps to `usage.input_tokens_details.cached_tokens`.

---

## 6. Response Event Storage

### Claude Code (HTTP SSE)

SSE text is parsed into event array and stored as `_res.json`. Each event is a `{event, data}` pair.

### Codex (WebSocket)

`ws-proxy.js:WS_SKIP_EVENTS` filters large envelope events from storage:

| Event | Stored? | Reason |
|-------|---------|--------|
| `response.created` | No | ~35KB, redundant with `.completed` |
| `response.in_progress` | No | ~35KB, status-only |
| `response.completed` | **Yes** | Contains usage, needed for timeline |
| `response.done` | **Yes** | Alias for `.completed` |
| `codex.rate_limits` | No | Non-standard metadata |
| All others | **Yes** | Tool calls, text deltas, content parts |

Usage/model are extracted from envelope events **before** the skip filter (`ws-proxy.js:488-489`), so skipping doesn't lose cost data.

### Restore-time normalization

`restore.js:loadEntryReqRes` + `forward.js:normalizeOpenAIResponseSummary`:
- OpenAI entries: `_res.json` (event array) → extract `response` object → populate `model`, `usage`, `stopReason`, `title`
- Anthropic entries: delta chain reconstruction (`prevId` → `msgOffset` splicing)

---

## 7. First-Turn Input Backfill

Codex first WS turn has `input=[]`. `ws-proxy.js:backfillFirstTurnInput`:

```
Turn 2 recorded with input.length > 0
  → find previous entry in same session with _loaded=false
  → read previous entry's _req.json from disk
  → check if input is empty
  → extract current input[0..firstAssistantIndex] (= Turn 1's context)
  → write back to previous entry's _req.json
```

Limitation: only fires after Turn 2 is recorded. Single-turn sessions or viewing Turn 1 before Turn 2 completes show no user input.

---

## 8. Startup Noise Filtering

`wire-parsers/openai.js:isNoiseRequest` matches Codex 0.133+ platform pings:

```
/v1/plugins/*
/v1/ps/plugins/*
/v1/connectors/*
/v1/api/codex/apps/*
/v1/api/codex/usage/*
```

These are forwarded upstream with `skipEntry: true` — the response reaches Codex but no dashboard entry is created.

`/v1/codex/analytics-events/events` (telemetry) is intentionally **not** filtered — future use for turn metadata extraction.

Anthropic: `isNoiseRequest` always returns `false` (no known startup noise).
