# Design: Dashboard Agent Abstraction

## Context

ccxray proxy 支援兩個 upstream provider（Anthropic、OpenAI），對應兩個 agent launcher（Claude Code、Codex）。啟動和路由已有 registry pattern（`UPSTREAMS` in config.js、`AGENT_PROVIDERS` in providers.js），但 **從 wire 到 dashboard 的整條路徑** 仍是 if-else 散落。

現有 provider-specific 邏輯分佈：

| 邏輯 | 散在哪 |
|------|--------|
| session detection | `store.js` (Anthropic) + `openai-session.js` (OpenAI) + `index.js` 切換 |
| dedup/hash | `index.js` L285-322 兩段 if-else |
| delta-log | `index.js` L324-357 Anthropic-only |
| noise filter | `config.js` `isCodexPlatformNoisePath` |
| usage extraction | `helpers.js` `extractUsage` (Anthropic) + `forward.js` inline (OpenAI) |
| agent classification | `system-prompt.js` `extractAgentType` (Anthropic) + `extractPromptAgentType` (OpenAI) |
| detail rendering | `messages.js` Anthropic-only |

## Goals

1. 新增 provider = WIRE_PARSERS + RENDERERS 各加一筆；dedup/delta/version-detection 仍需在 index.js 加對應 provider branch
2. Codex dashboard 五個已知問題（session name, model, tokens, messages, MCP noise）透過 OpenAI registry 實作解決
3. 保持 disk format 向後相容（1.9.x 寫的 log 仍可讀）
4. Proxy forwarding 不因 parser 失敗而中斷

## Non-Goals

- 不做跨 provider 的 canonical wire format（D4 已否決：lossy 假抽象）
- 不做 streaming transport 統一（SSE vs WebSocket lifecycle 差異太大）
- 不處理 session 中途切換 provider（D6：延後）
- 不在此次重構 cost-worker / pricing（provider-agnostic，不需動）

---

## Architecture Decisions

### D1: 4 個獨立 registry

| Registry | 位置 | 狀態 | 職責 |
|----------|------|------|------|
| `UPSTREAMS` | `server/config.js` | 已有 | 路由目標 |
| `AGENT_PROVIDERS` | `server/providers.js` | 已有 | CLI spawn |
| `WIRE_PARSERS` | `server/wire-parsers/` | **新增** | wire → disk + normalize |
| `RENDERERS` | `public/renderers/` | **新增** | detail timeline 渲染 |

### D2: disk 留 provider-native + hash dedup，read 時 normalize

- Disk 每個 provider 保留原始 wire shape
- 大型共享部分按 hash 抽出（`sys_{hash}.json` / `openai_instructions_{hash}.json`）
- Delta-log 跨 turn（Anthropic 已有，OpenAI 不需要）
- Read 時 `WIRE_PARSERS[p].normalizeListMeta()` 產出 thin canonical

### D3: per-provider hash namespace

`sys_` 與 `openai_instructions_` 各自 namespace，不跨 provider 共享。

### D4: thin canonical（list layer）+ per-provider detail（detail layer）

- List layer（Miller columns 列表）：cross-provider thin canonical（ThinCanonical 欄位見下）
- Detail layer（Timeline 右側）：`RENDERERS[provider].renderTimeline(entries, container)`

**ThinCanonical 欄位**（`normalizeListMeta` 回傳值）：

| 欄位 | 型別 | 來源 |
|------|------|------|
| `id` | string | entry id（timestamp-based） |
| `ts` | string | ISO timestamp |
| `sessionId` | string? | per-provider extraction |
| `provider` | string | `'anthropic'` / `'openai'` |
| `model` | string | request body |
| `msgCount` | number | messages/input array length |
| `toolCount` | number | tools array length |
| `toolCalls` | number | response 中 tool_use / function_call 數量 |
| `usage` | object? | `{ input_tokens, output_tokens, cache_*? }` |
| `cost` | object? | `{ cost, rates }` |
| `agentType` | string | `extractAgentType` 結果的 key |
| `agentLabel` | string | `extractAgentType` 結果的 label |
| `isSubagent` | boolean | session detection 結果 |
| `stopReason` | string? | response stop reason |
| `status` | number | HTTP status code |
| `elapsed` | number | request→response ms |

Provider-specific 欄位（附在同一物件，renderer 可讀）：
- Anthropic：`coreHash`, `thinkingDuration`, `thinkingStripped`, `hasCredential`
- OpenAI：`responseMetadata` `{ id, object, model, status, streaming }`

### D5: provider 與 agent 兩條獨立 dispatch axis

| 軸 | 決定者 | 用途 |
|----|--------|------|
| `provider` | `getUpstreamForRequestAndHeaders()` | WIRE_PARSERS / RENDERERS dispatch |
| `agent` | system prompt 分類 | UI label / session 列名稱 |

### D6: session-immutable provider

一個 session 的 provider 由首筆 entry 決定，不可中途切換。

---

## Components

### `WIRE_PARSERS[provider]` — 7 個方法（4 dispatched + 3 inline-only）

Phase 3 實作發現 `dedupExtract` 和 `extractDeltaSlice` 的 side-effect 過多（IO、state mutation、SSE broadcast），dispatch 後 caller 仍需大量 if-else 處理 return value — 屬假抽象。這些方法保留在 parser 檔案供參考和測試，但 index.js 的 hot path 不經 dispatch。

```javascript
WIRE_PARSERS[provider] = {
  // ── Dispatched（index.js / forward.js 透過 getParser() 呼叫）──

  isNoiseRequest(url, headers, parsedBody)
    // → boolean
    // index.js 用 Object.values(WIRE_PARSERS).some() 迭代所有 parser

  preprocessBody(parsedBody, headers)
    // → parsedBody (可能注入 header-derived metadata)
    // Optional method — 只有 openai parser 實作（注入 session_id, agent_type）
    // 呼叫方式: parser?.preprocessBody?.(parsedBody, headers)

  detectSession(req, headers, parsedBody)
    // → { sessionId, isNewSession, inferred? }
    // 內部委託 store.detectSession() 做 subagent inference + temporal heuristic
    // per-provider 差異只在「從哪裡提取 session hints」：
    //   Anthropic: parsedBody.metadata.session_id → store.detectSession()
    //   OpenAI: headers (turn-metadata JSON) → 注入 body → store.detectSession()

  extractUsage(parsedResponse)
    // → { input_tokens, output_tokens, cache_*? } | null
    // Anthropic: 掃 SSE events array 的 message_start + message_delta
    // OpenAI: 從 response object 的 .usage 欄位讀取

  // ── Inline-only（實作在 parser 檔案，但 index.js 不 dispatch）──

  dedupExtract(parsedBody)
    // → { sysHash?, toolsHash?, coreHash?, sharedFiles: [{name, data}], versionInfo? }
    // 不 dispatch 原因：caller 需要 writeSharedIfAbsent IO + registerPromptVersion +
    //   versionIndex mutation + SSE broadcast，return value 需再 if-else 分支處理

  extractDeltaSlice(prevState, currReq, opts)
    // → { stripped, trackingState } | null
    // 不 dispatch 原因：sessionLastReq Map state management 跟 caller 綁死

  // ── Read path ──

  normalizeListMeta(entry)
    // → ThinCanonical
    // 用於 restore.js 從 disk 重建 list metadata

  // ── Classification（未 dispatch，system-prompt.js 直接呼叫）──

  extractAgentType(systemBlob, headers)
    // → { key, label }
}
```

**Dispatch 原則**（Phase 3 retro 得出）：只 dispatch 輸入→輸出乾淨、無 side-effect、caller 不需再 if-else 處理 return value 的方法。有 IO/state mutation/複雜 return value 的留 inline。不用 safeCall — 直接呼叫，let errors surface。

### `RENDERERS[provider]` — 1 個主 function

```javascript
RENDERERS[provider] = {
  renderTimeline(entries, container)
    // 接收 provider-native entries，直接渲染進 container
}
```

加 `RENDERERS.fallback` 顯示 raw JSON + banner。

---

## Data Flow

### Write path

```
Request → index.js
  1. getUpstreamForRequestAndHeaders() → provider
  2. WIRE_PARSERS.some(p.isNoiseRequest()) → skip?          ← dispatched
  3. parser.preprocessBody?.(body, headers)                  ← dispatched (openai only)
  4. inline: hash computation + writeSharedIfAbsent()        ← NOT dispatched (side-effects)
  5. inline: delta-log (Anthropic) / full write (OpenAI)     ← NOT dispatched (state mgmt)
  6. storage.write({id}_req.json)
  7. parser.detectSession(req, headers, body) → sessionId    ← dispatched
```

### Response path

```
Upstream response → forward.js
  Transport: SSE (parseSSEFrame, shared) or WebSocket (ws-proxy.js)
  8. getParser(provider).extractUsage(parsedResponse)        ← dispatched
  9. pricing.calculateCost(model, usage)  // provider-agnostic
  10. storage.write({id}_res.json)
  11. summarizeEntry() → SSE broadcast → dashboard
```

Note: step 11 的 `summarizeEntry()` 直接從 entry object 取欄位，不經 normalizeListMeta。normalizeListMeta 用於 read path（restore.js 從 disk 重建）。

### Read path (detail)

```
Dashboard click → GET /_api/entries/{id}
  Server: loadEntryReqRes() → delta chain + dedup restore
  Response: { provider, req: rawReq, res: rawRes }  // provider-native
  Client: RENDERERS[provider].renderTimeline(data, container)
```

Server 回傳 provider-native data，不做 server-side normalize for detail。理由：D4 要求 detail layer 保持 per-provider fidelity。

---

## Error Handling

### WIRE_PARSERS error handling

Dispatched 方法直接呼叫（`parser.method()` 或 `parser?.method?.()`），不包 safeCall / try-catch fallback。Parser 方法 crash 只影響該筆 entry 的 metadata 品質（usage null、session fallback 等），不阻斷 proxy forwarding — 因為 parser 呼叫都在 entry construction 之前，forward 不依賴 parser 結果。

Phase 3 retro：safeCall + safe defaults 把 bug 變成 silent data corruption（parser 壞了回傳空殼，downstream 拿到錯誤 data 但不 crash）。直接呼叫讓 error 可見、可 debug。

### 舊資料相容

1.9.x 寫的 entry 沒有 `provider` 欄位：
- `restore.js` 載入時 infer：`/v1/messages` → anthropic，`/v1/responses` → openai，其餘 → anthropic
- 不回寫修改舊檔

### RENDERERS fallback

`RENDERERS[provider]` 不存在 → `RENDERERS.fallback.renderTimeline()` 顯示 raw JSON pretty-print + banner。

---

## Risks

| 風險 | 緩解 |
|------|------|
| messages.js 拆分時破壞現有 Anthropic rendering | Anthropic renderer = messages.js 原始碼搬移，不改邏輯，前後 diff 應為純搬移 |
| codex wire shape 可能隨版本變動 | WIRE_PARSERS 的 graceful degrade + fixture 來自真實 wire dump |
| 重構期間 dev hub (port 5577) 被破壞 | 用 `--port 5578` + `CCXRAY_HOME=/tmp/test` 隔離測試 |
| delta-log chain 在重構中斷裂 | delta 邏輯只搬移不改寫，unit test 覆蓋 chain reconstruction |

---

## Migration Plan

重構策略：**extract → wire-up → fix**。先把現有邏輯搬進 registry（extract），再把 index.js 切換到 dispatch（wire-up），最後修 codex 問題（fix）。

### Phase 0: Fixtures

從真實 wire dump 擷取 Anthropic + OpenAI test fixtures。

### Phase 1: WIRE_PARSERS scaffold + Anthropic impl

建 `server/wire-parsers/{index,anthropic}.js`。Anthropic impl = 從現有 `index.js`、`forward.js`、`store.js`、`helpers.js`、`system-prompt.js` 搬移程式碼，不改邏輯。Unit tests。

### Phase 2: OpenAI WIRE_PARSER impl

建 `server/wire-parsers/openai.js`。從 `openai-session.js`、`index.js` OpenAI 分支、`config.js` `isCodexPlatformNoisePath` 搬移。補 codex 五個問題的修正邏輯。Unit tests。

### Phase 3: index.js wire-up

`index.js` / `forward.js` 的乾淨邊界改為 `WIRE_PARSERS[provider].method()` dispatch（noise, preprocess, session, usage）。Dedup/delta/version-detection 留 inline。`openai-session.js` thin 成 re-export from `wire-parsers/openai.js`（ws-proxy.js 仍 import）。`isCodexPlatformNoisePath` 從 config.js 刪除，`extractUsage` 從 helpers.js 刪除。Smoke test per commit。

### Phase 4: RENDERERS scaffold + Anthropic renderer

建 `public/renderers/{index,anthropic,fallback}.js`。Anthropic renderer = `messages.js` 的 detail rendering 邏輯搬移。

### Phase 5: OpenAI renderer + client wire-up

建 `public/renderers/openai.js`。`entry-rendering.js` / `messages.js` 的 detail dispatch 改用 `RENDERERS[provider]`。

### Phase 6: Integration tests + validation

Fixture-driven unit tests for WIRE_PARSERS。Integration test for delta chain。手動 E2E 驗證兩個 provider 的 dashboard 完整體驗。

### Phase 7: Cleanup + release

Archive `openspec/changes/2026-05-28-codex-dashboard-parity/`。CHANGELOG entry。更新 CLAUDE.md Architecture table。

---

## Relationship to 2026-05-28-codex-dashboard-parity

該 scaffold 用「直接補 codex」的 framing，其 tasks（session detection、body shape、MCP noise 等）都對應到此 abstraction 的 WIRE_PARSERS 方法。此 proposal 取代它。完成後 archive 該 scaffold。
