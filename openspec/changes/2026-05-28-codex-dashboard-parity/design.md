## Context

`server/openai-session.js` already exists as scaffolding from 2.1 era — has session id extraction (`getCodexSessionId`), turn-metadata parsing (`x-codex-turn-metadata`), and agent-type detection. But empirically it falls through to `'codex-raw'` for real codex traffic (2026-05-28 dogfood at `~/.ccxray/logs/2026-05-28T13-18-29-669_*.json`). The infrastructure is partially there; the wire mapping is wrong.

Dashboard renderer (`public/messages.js`, `public/entry-rendering.js`) is built around Anthropic message shape — `system + messages[] + tools[]` with `content` blocks. Codex's request body (OpenAI Responses API) is structurally different.

## Goals / Non-Goals

**Goals:**
- `ccxray codex` sessions render with a real session name (not `Codex Raw`), correct model, input/output token counts, and visible message/turn content.
- MCP RPC traffic from codex's startup (heptabase auth probe, MCP_DOCKER missing, pencil missing, codex_apps handshaking) does not pollute the turn list.
- Parity with `ccxray claude` for the "observe what the agent is doing" use case.

**Non-Goals:**
- Rebuilding the dashboard UI for codex specifically. Reuse the existing Miller-column layout.
- Supporting OpenAI Chat Completions API (codex uses Responses; Chat Completions is a separate provider).
- Handling non-streaming OpenAI responses (codex streams).

## Open Design Questions

The 0.x investigation phase resolves these before any commit lands:

### Q1: Where does codex actually emit its session id over the wire?

`getCodexSessionId` checks four sources:
1. `session_id` HTTP header
2. `x-openai-session-id` HTTP header
3. `x-codex-turn-metadata` header → `session_id` field
4. `body.metadata.session_id`

None hit during dogfood. Hypotheses:
- (a) Codex 0.133 emits session id only in response (`response.created` event's `session_id`), never in request.
- (b) Codex emits it as a yet-unobserved header (`x-codex-session`?).
- (c) Codex emits it embedded somewhere in the request body that doesn't match the current four checks.

**Determined by:** dump `~/.ccxray/logs/2026-05-28T13-18-29-669_req.json` and `_res.json`; if response carries it, design extracts it from response and writes it back into the entry. If neither does, accept that codex sessions can't be grouped and surface a different label (timestamp-based?).

### Q2: Render `input` field — extend or fork?

OpenAI Responses `input` shapes:
- Bare string: `{ "input": "say hi" }`
- Array: `{ "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "..." }] }, ...] }`

Two paths:
- **Extend Anthropic renderer**: normalize OpenAI shape into Anthropic-ish `messages[].content[].text` blocks before rendering. Less code, but blurs the model boundary.
- **Fork a parallel renderer**: explicit OpenAI path, separate file. More code, clearer separation.

Lean toward **normalize-in-store**: convert OpenAI shape to the dashboard's internal entry shape at proxy ingestion time (`server/index.js`), so the dashboard sees uniform data. Single rendering path. Pre-existing `withCodexMetadata` already does similar normalization for metadata; extend pattern.

### Q3: MCP noise filter — drop or display?

The `!http` markers on turns #2/#3/#5/#6 in the 2026-05-28 screenshot are codex's MCP startup RPCs. They:
- Originate from codex itself (its MCP clients).
- Return 401 / connect-failure / etc.
- Are not LLM API calls.

Options:
- **Drop entirely**: `skipEntry: true` at proxy level if URL pattern matches MCP-RPC (analogous to `isCodexPlatformNoisePath`). User never sees them.
- **Visually segregate**: keep in store but mark with a noise badge; collapsed by default.

Lean toward **drop entirely** following the `isCodexPlatformNoisePath` precedent — if a request isn't a real LLM turn, don't dirty the timeline. Add a debug counter for visibility (`stats.mcpNoiseDropped`) for the maintainer.

### Q4: Cohabitation with `ccxray claude` entries

The dashboard already serves multi-project / multi-session views. Codex entries land in the same `~/.ccxray/logs/` directory as Claude entries. The current rendering assumes Anthropic shape; mixing in OpenAI entries with a different parser must not break Claude rendering.

**Design constraint:** the OpenAI normalization must produce entries with the same internal shape ccxray uses for Anthropic. Renderer doesn't branch on provider; it sees uniform entries. Provider tag (`upstream.provider === 'openai'`) is metadata only.

## Risks / Trade-offs

- **Response-side session id discovery**: if codex emits session id only in response, we have a chicken-and-egg for the request entry (request log written before response arrives). Workaround: write entry with raw bucket, patch session id on response-arrival.
- **MCP noise pattern brittleness**: hard-coding MCP RPC URL patterns risks missing future codex MCP transports. Mitigation: include a debug header probe (`if response includes JSON-RPC envelope → mark as MCP noise`).
- **`input` field normalization fidelity**: lossy conversion to Anthropic shape could hide codex-only structure (tool calls, function call outputs). Acceptable for v1; iterate later.

## Migration Plan

Sequencing inside this change:
1. 0.x — investigation (logs dump, structure mapping, MCP pattern survey). No code changes.
2. 1.x — session detection wire fix. Tests with captured fixtures.
3. 2.x — input field normalization + dashboard render. Tests.
4. 3.x — MCP noise filter. Tests.
5. CHANGELOG entry for whichever release this ships in (likely 1.11.0).

No version bump required — this is feature work targeting a future minor; not a breaking change. Will not affect `ccxray claude` rendering.
