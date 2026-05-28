## 0. Investigation (no commits — produces decision input for 1–4)

- [ ] 0.1 Dump the dogfood entry already on disk: `~/.ccxray/logs/2026-05-28T13-18-29-669_req.json` + `_res.json`. Identify: where does the session id (`019e6d05-02ad-7d83-afa0-6c480945a1be` per codex banner) appear? Request headers? Response events? Neither? → resolves design.md Q1.
- [ ] 0.2 Run a fresh `ccxray --port 5578 codex` session; tail `~/.ccxray/logs/` for the matching `_req.json` and `_res.json`. Confirm the OpenAI Responses request body shape (`input` as string vs. array) and the streamed response event structure (`response.created`, `response.output_item.added`, `response.completed`, etc.).
- [ ] 0.3 Catalog all MCP-related entries from the dogfood session (the `!http` turns). Find the common URL pattern / header signature that distinguishes MCP RPC from real LLM turns → input to task 3.1.

## 1. Session detection (commit 1.1)

- [ ] 1.1 Extend `detectOpenAISession` / `getCodexSessionId` per Q1 outcome. If session id only in response: add a response-side patcher that updates the entry's `sessionId` when the streaming response yields it.
- [ ] 1.2 Replace `Codex Raw` user-facing label with a meaningful default (e.g., timestamp-based or first-user-message prefix) when no session id is available, reserving `codex-raw` purely as the internal bucket identifier.
- [ ] 1.3 TDD: unit test against the captured fixtures from 0.1/0.2 — given the real wire shape, `detectOpenAISession` returns the correct session id.

## 2. Body shape + model + tokens (commit 2.1)

- [ ] 2.1 Normalize `parsedBody.input` (OpenAI Responses) into the dashboard's internal `messages[]` shape at proxy ingestion. Handle both string and array-of-input-items inputs. `withCodexMetadata` is the natural extension point.
- [ ] 2.2 Verify `parsedBody.model` flows through to the entry and the dashboard reads it on the codex path. If it doesn't, fix the read site.
- [ ] 2.3 Add OpenAI Responses streaming-usage extractor: pick up `usage.input_tokens` / `usage.output_tokens` from the final response event and write to `entry.usage`. (Cost-worker already understands those field names — only the input-side write is missing.)
- [ ] 2.4 TDD: dashboard displays correct model + token counts + visible user/assistant text for a captured codex session.

## 3. MCP noise filter (commit 3.1)

- [ ] 3.1 Classify codex's MCP RPC traffic. Per 0.3, define an `isCodexMcpNoise(req, body)` analogous to `isCodexPlatformNoisePath`. Hand it `skipEntry: true` in `server/index.js`.
- [ ] 3.2 Maintain a counter (`store.mcpNoiseDropped` or similar) for maintainer visibility, surfaced in `ccxray status`.
- [ ] 3.3 TDD: synthetic MCP RPC requests don't appear in the dashboard's turn list; counter increments.

## 4. End-to-end verification (commit 4.1)

- [ ] 4.1 Replace the broken 2026-05-28 dogfood: run `ccxray --port 5578 codex exec "say hi"` against the fixed code; capture screenshot. Dashboard must show session name (not `Codex Raw`), model (`gpt-5.5` or whatever), input/output tokens, visible user/assistant content.
- [ ] 4.2 Smoke: run `ccxray --port 5578 codex` interactively for ≥5 minutes of real use; MCP noise stays out of turn list.

## 5. CHANGELOG + release

- [ ] 5.1 Add entry to `## 1.11.0` (or next minor) — "Codex dashboard parity: codex sessions now render full session/model/tokens/messages; MCP RPC noise filtered".
- [ ] 5.2 Mention in README that `ccxray codex` is now a first-class observation target.
