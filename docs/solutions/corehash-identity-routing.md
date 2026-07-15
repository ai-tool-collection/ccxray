# coreHash Identity Routing for Teammate Lane Placement

> 診斷完成：2026-07-15。根因確認 + 修法設計 + 獨立審查（codex APPROVE WITH CONCERNS、fable APPROVE WITH CONCERNS 含 3 blocking）。

## 根因

Teammate agents 的 system prompt B2 開頭為 `"You are an interactive agent"`（`server/system-prompt.js:48`），
與 main orchestrator 匹配同一 KNOWN_AGENTS entry → `agentKey='orchestrator'`。

`workflow-timeline.js:429` 和 `entry-rendering.js:432` 用 `WF_MAIN_AGENT_KEYS[agentKey]` 路由，
將所有 `orchestrator`-keyed entries 歸入 main lane。事後靠 temporal overlap post-pass 踢出 teammate turns，
但 parallel lane best-fit（`workflow-timeline.js:546`）的 `lastEnd <= oStart` 判定沒有 jitter tolerance，
8-30ms HTTP pipeline flush jitter 把同一 teammate 的 sequential turns 拆成 #1/#2 兩條 lane。

**已有信號未被使用：** `coreHash`（normalized system prompt hash）在 main 和 teammate 之間完全不同
（main=`85771`、all teammates=`e6aa4`），fork 則正確地與 main 共享 coreHash。

## 證據（session e622e4d2，2026-07-15）

| 角色 | coreHash | model | convIds | entries | agentKey |
|---|---|---|---|---|---|
| Main | 85771 | opus-4-6 | ebffe2 | 146 | orchestrator |
| 6 Teammates | e6aa4 | sonnet-5 | 56a5, 16f4, 68a2, b95f, d343, 8d8b | 132 | orchestrator |
| Title gen | 0c444 | opus-4-6 | 5f59 | 1 | title-generator |

Jitter 量測：
- 56a5（49 turns）：2 對 15ms/30ms overlap → #2 lane 承接 6 turns。msgCount 嚴格遞增 = 同一 sequential conversation。
- 16f4（13 turns）：2 對 8ms/13ms overlap → #2 lane 承接 9 turns。
- ebff forks（28 exiled turns）：10-50s 真實 overlap → 拆分正確（已驗證 request content，兩個 msg[59] 內容不同）。

## 修法選項

### Option A：coreHash + convId early-exit（推薦）

在初始路由加入判斷：`agentKey ∈ WF_MAIN_AGENT_KEYS` 但 `coreHash ≠ main 的 coreHash` 且 `convId ∉ main 的 conv set` → 直接走 sublane。

**三站同步（ADR 0005）：**
1. `workflow-timeline.js:429`（wfInferLanes 批次路由）
2. `workflow-timeline.js:746`（wfAddEntry live 路由）
3. `entry-rendering.js:432`（addEntry isSubagent 計算）

**lane key 使用 identity 路徑**（`agent-orchestrator:<convId>`），不用 `parallel-` 家族。
`parallel-` 進入 best-fit 分支（`wfAddEntry:813-828`），jitter 分裂原樣回歸。

**null policy：** coreHash 或 convId 任一方為 null → 視同 main（fall through 既有路徑）。

**main coreHash 建立方式：** 批次路由中，從最早 receivedAt 的 WF_MAIN_AGENT_KEYS entry 取 coreHash；
live 路由中存入 `wfState.mainCoreHash`。

**`_wfLaneDispName` 擴充：** identity-keyed teammate 不經 `parallel-` 前綴，
需要新的命名邏輯（可沿用 agentLabel + convId 前 4 碼）。

### Option B：純 convId early-exit（不推薦）

只看 convId ≠ main 就路由。問題：
- convId 取決於 `messages[0]` hash，語義上是 conversation content 非 identity
- main 的 convId 建立有 first-turn ordering 風險（completion order ≠ start order）
- ADR 0009 已因 compaction 相關問題否決純 convId 路由

### Option C：純 jitter tolerance（不推薦）

在 best-fit 加 epsilon（e.g. 200ms）。問題：
- Teammate 仍過境 main → provisional window 與 `_recentMainSpans` 污染留存
- 是門檻調參，不是結構性消除
- epsilon 同時弱化 fork 的物理 overlap 不變量

## 為什麼必須 AND convId（不能單靠 coreHash）

coreHash 有中途變動前科：
- commit f951964（#219）：platform normalization 修正 coreHash 假分裂
- commit ff5b376（#218）：autoMemory marker regex 漏抓，可變文字漏進 coreInstructions

加上 convId guard 後四種情境正確：

| 情境 | coreHash | convId | 結果 |
|---|---|---|---|
| Teammate | ≠ main | ∉ main set | → sublane ✓ |
| Fork | = main | ∈ main set | → main → overlap 判斷 ✓ |
| 升級/噪音 | ≠ main | ∈ main set | → 留 main ✓ |
| Compaction | = main | ∈ main set | → 留 main ✓ |

## 範圍限制

- **此修法只救 teammate（不同 coreHash），不救 fork（同 coreHash）。**
  Fork 的 jitter 分裂（若日後出現）應作為獨立議題處理，scope 限縮在 exile best-fit 的 epsilon，不動主 lane serial sweep。
- ADR 0008/0009 需要更新，記錄 coreHash identity 路由與既有物理不變量的關係。
- 建議補 ADR 0010。

## 獨立審查

- **Codex（opus）：APPROVE WITH CONCERNS** — null handling、ADR 同步
- **Fable：APPROVE WITH CONCERNS（3 blocking）** — A: coreHash+convId AND、B: 三站合約、C: lane key 不能走 parallel-
- 兩方共識：不加 jitter tolerance
