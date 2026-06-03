## Why

1.10.0 (`feat/two-domain-auth`) made the upstream auth gate accept the Codex-on-ChatGPT carve-out correctly (codex 2.4 P1 fix). Running `ccxray codex` against the proxy now passes auth end-to-end, codex gets responses, and entries land in `~/.ccxray/logs/`.

But the **dashboard side has never really worked for codex**. Discovered during the 2026-05-28 dogfood of `ccxray --port 5578 codex`:

- Session column shows the literal label "Codex Raw" instead of an actual session name (placeholder for the `codex-raw` fallback bucket).
- Model column shows `?` even though `parsedBody.model === "gpt-5.5"` is in the request.
- Token columns show `? in / ? out` even though OpenAI Responses API returns `usage.input_tokens` / `usage.output_tokens` in the same field names ccxray's cost-worker already reads.
- Timeline detail shows "No messages" because the dashboard renderer reads `body.messages` (Anthropic) and the OpenAI Responses API uses `body.input` (string or array of input items).
- Several turns appear with `!http` markers — these are codex's MCP transport RPC failures (heptabase/MCP_DOCKER/pencil/codex_apps), not real LLM turns. ccxray has no MCP-noise filter (analogous to `isCodexPlatformNoisePath`) so they pollute the turn list.

These gaps are **pre-existing** (not introduced by the 1.10.0 auth work — they would have surfaced any time someone tried `ccxray codex` end-to-end). They were not in scope for the auth migration, but they undermine the value proposition of "`ccxray codex` as a first-class launcher" alongside `ccxray claude`.

## What Changes

Five sub-issues, each likely 0.5–1 day of work. The first task is empirical capture — design follows the wire reality.

1. **Session detection**: `detectOpenAISession` falls to `'codex-raw'` because codex's HTTP requests don't carry the session id ccxray expects (`session_id` header / `x-openai-session-id` / `x-codex-turn-metadata.session_id` / `body.metadata.session_id`). Need to determine the real source and wire it in.
2. **Model extraction**: `parsedBody.model` is captured by the proxy at `server/index.js:338,348,352`, but the dashboard renders `?`. Trace where the entry's model attribute is read and why it drops on the codex path.
3. **Token extraction**: OpenAI Responses streams a final usage event; verify ccxray's SSE parser handles it and writes to `entry.usage.input_tokens`/`output_tokens`.
4. **Message rendering**: extend the renderer (or fork a parallel path) to handle OpenAI Responses' `input` field. Two shapes: bare string, or array of `{ type: "message" | "function_call_output" | ... }` items.
5. **MCP noise filter**: classify and either drop or visually separate MCP transport RPC traffic from real LLM turns. Pattern analogous to `isCodexPlatformNoisePath` but for the codex-side MCP client behavior.

## Capabilities

### Modified Capabilities

- `codex-observation`: end-to-end dashboard fidelity for `ccxray codex` sessions — currently broken, target parity with `ccxray claude`.

## Impact

- `server/openai-session.js`: extend session id extraction beyond current four-header check
- `server/index.js`: possibly per-request body-shape branching for OpenAI Responses
- `server/forward.js`: SSE event parser for OpenAI usage event
- `public/messages.js` / `public/entry-rendering.js`: input-shape rendering
- `server/config.js`: extend `isCodexPlatformNoisePath` or add MCP-noise classifier
- Tests: new fixtures capturing real codex Responses API traffic
