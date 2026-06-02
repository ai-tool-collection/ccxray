# Codex Parity Gap Ledger — code-grounded

**日期**：2026-06-03
**分支**：`feat/codex-dashboard-foundation`
**目的**：因文件不可信（tasks.md 0 勾、handoff 自相矛盾、2026-05-31 UI audit 過時），用**真實 Codex session smoke + code 盤點**重建可信進度，逐項標 fixed / still-missing / not-goal / infeasible。這是決定 PR scope 與後續 Step 3-5 的證據基礎。

## 方法

1. 隔離 smoke：`CCXRAY_HOME=/tmp/ccxray-ledger-* CCXRAY_LOOPBACK_NO_AUTH=1 node server/index.js --port 5611`（不碰使用者 5577 hub；寫入經 `storage/index.js:58` 走 CCXRAY_HOME，確認隔離）。
2. 真實流量：`codex exec -c openai_base_url=http://localhost:5611/v1 ...`「跑 echo hello-from-codex 並回報」→ session `019e8911`, model gpt-5.5, 含 1 個 exec tool call, 13,201 tokens。
3. 測 live → 重啟同 home 測 **restore** → browser-harness 看 **timeline 渲染**。
4. 不可見項以 code 盤點（前一輪 4+2 subagent）佐證。

## 核心結論

> **2026-05-31 UI audit（91 缺口）已大幅過時。** 那波 77 commits（Phase 8a WS content capture、8c/8d tokens+tool chips、lazy-load fix 等）修掉了大多數 critical 缺口。真實剩餘缺口比 audit 宣稱的小很多。

---

## A. FIXED（audit 宣稱缺、實測已修）

| audit 宣稱 | 實測（live + restore）| 證據 |
|---|---|---|
| restored WS turn 顯示「No messages」(critical #1) | ✅ **timeline 完整渲染**：system instructions → user prompt → `exec_command echo hello-from-codex`(tool step) → 助理輸出 | browser :5611 /?e=…00-00-58-647；`_res.json`=57 events(function_call_arguments/output_text)，`_req.json` 全保留(instructions 21KB + input 3 messages + tools) |
| model 顯示 `?` | ✅ gpt-5.5 | API + header |
| toolCalls 永遠 `{}` | ✅ `{Bash:1}`（11 tools 渲染）| API；exec_command→Bash alias |
| token `? in/? out` | ✅ 16,531 in 等 breakdown | header |
| maxContext null | ✅ 400000（**live 與 restore 都對**）| API 兩次 |
| cost 不算 | ✅ $0.091 | API；pricing.js 有 gpt-5 rates |
| 57 events 不捕獲 / WS 內容遺失 | ✅ req+res 都在磁碟、restore 後完整 | 隔離 home logs |
| restore 掉資料 | ✅ 重啟後 model/tools/maxCtx/cost 全保留 | restart 同 home 再查 |

→ audit 的 11 critical 多數已解。**不要照 audit 重做這些。**

## B. STILL-MISSING（實測仍缺，真 gap）

| # | 缺口 | 證據 | 可行性 | 對應 |
|---|---|---|---|---|
| B1 | **stopReason 缺**（Codex 顯示 `?`，live+restore 都缺）| API stop=? | feasible（從 response.completed/status 取）| 寫入面抽象 A1 |
| B2 | **title 是靜態佔位 "Codex WebSocket session"** | API title | partial（Codex 無 title-gen subagent；可改用 input summary）| — |
| B3 | **N3 啟動雜訊污染**：codex 的 MCP RPC(404)+platform ping 被建成假的「(unknown)」project + 「Codex Raw」session，含 5 個 `!http`/dur:0s 垃圾 turn | dashboard 截圖；codex exec 時 stderr 有 `rmcp::transport::worker ... data did not match any variant`(MCP) | feasible（`isCodexMcpNoise` 比照 `isCodexPlatformNoisePath` 給 skipEntry）| **N3 must-have** |
| B4 | **cache TTL 顯示**：topbar 對 Codex 顯示「API key · TTL 5m (detecting…)」這種 Claude 式倒數 | dashboard 截圖 | 改顯示 observed（見 cache-ttl notes）| N6（park，但顯示面要修）|

## C. 不可見但已知（code 盤點，非本次 smoke 範圍）

| # | 缺口 | 對應 |
|---|---|---|
| C1 | **credential scanning `hasCredential` 是 Anthropic-only**（安全 parity）| **N2 must-have** |
| C2 | session 多 row collapse（Claude 不會，Codex 可能擠一起）— 本次只有單 session 未觸發，待多 session smoke 驗證 | N1 must-have（待驗）|
| C3 | 寫入面抽象債（entry/index builder 手刻 3 份、version 雙軌、死介面）— 非使用者可見，但是 B1 等的根因 | **A1-A3 地基** |

## D. INFEASIBLE / NON-GOAL（不追，已確認）

Chat-Completions API、non-streaming、tiktoken 精確 token、apply_patch diff、thinkingDuration、history thinking 明文(加密)、delta-log(WS)、intercept(WS)。auth(Codex WS X-Ccxray-Auth) 已完成。

---

## 對 Step 3-5 的修正

- **Step 3 (A1-A3)** 仍是地基，且會順手修 B1(stopReason)、統一寫入欄位。**驗收新增**：Codex stopReason live+restore 一致。
- **Step 4 (P1-P5)**：P2/P3 經本次 smoke 確認 **maxContext 其實已對**(400000 live+restore)，P3 可能只剩 SSE-HTTP 路徑的 index null（WS 已對）——縮小範圍。P1 成本頁(歷史掃 ~/.codex/sessions)、P5 rate-limit 仍要做。
- **Step 5 (N 層)**：B3(N3 噪音)升為**高優先**——它是目前 dashboard 最明顯的視覺污染（假 project+session）。N1 待多-session smoke 確認。N2 credential 照舊 must-have。

## 待補驗證（next smoke）
- 多個並行 Codex session → 驗 N1 collapse 是否真的發生。
- SSE-HTTP（非 WS）Codex 路徑的 maxContext index 是否真寫 null（`forward.js:761`）。
