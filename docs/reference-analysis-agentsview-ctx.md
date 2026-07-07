# Reference 分析：agentsview + ctx 借鑑報告

> 分析日期：2026-07-07
> 證據基準（本文所有 file:line 以此為準，上游會漂移）：
> - `reference/agentsview` @ `172e97d6`（MIT License，Go + Svelte 5 + SQLite）
> - `reference/ctx` @ `4710263`（Apache-2.0，Rust workspace + SQLite）
>
> 方法：5 個調查 subagent（後端管線／UI 產品／Insights 引擎／ctx 架構／ctx 整合）+ 本機建置實測（agentsview 對真實 `~/.claude/projects` 跑 6,326 個 Claude session + 785 個 Codex session）+ browser-harness 逐頁截圖 + Nielsen heuristic 檢核 + expert-panel（Christensen/Rumelt/Tufte/Cagan）綜整。
>
> 截圖為 dogfood 原圖（含真實 session 標題/成本），依 repo 慣例置於 `docs/src/reference-analysis/`（gitignored）。**公開發布前必須以本機 PIL 遮罩處理，不可經 imagegen。**

---

## 1. 三產品定位：資料流位置圖

```
                    Claude Code / Codex / (50+ agents)
                                │
              ┌─────────────────┼──────────────────────┐
              │ HTTP/SSE/WS     │ 落盤                  │
              ▼                 ▼                       │
   ┌────────────────┐   ┌──────────────────┐            │
   │     ccxray      │   │ provider history │            │
   │  (wire proxy)   │   │ files            │            │
   │                 │   │ ~/.claude/ 等    │            │
   │ 獨占資料:        │   └───────┬──────────┘            │
   │ ·每turn完整      │           │ 讀檔+索引              │
   │  system prompt  │     ┌─────┴──────┐                │
   │ ·cache tokens   │     ▼            ▼                │
   │ ·compaction前   │ ┌─────────┐ ┌─────────┐           │
   │  狀態(delta鏈)  │ │agentsview│ │   ctx   │           │
   │ ·intercept原始  │ │post-hoc │ │ agent   │◄──agent 查詢
   │  payload        │ │稽核分析  │ │記憶檢索  │  (CLI/MCP)
   │ ·subagent wire  │ └─────────┘ └────▲────┘
   └───────┬─────────┘                  │
           │   建議路徑: exporter        │
           └────────────────────────────┘
              (stdin/stdout JSONL plugin,
               ctx docs/history-source-plugins.md:1-17)

  Job to be done:
    ccxray     = 「看清 agent 現在在 wire 上做什麼」(live forensics)
    agentsview = 「事後盤點/稽核我所有 agent 的歷史」(post-hoc audit)
    ctx        = 「讓現在的 agent 記得過去的決策與失敗」(agent memory)
```

**核心結論（expert panel 一致）**：資料重疊讓三者看似競品，實際上 job 不同。ccxray 的 wire 資料是另外兩者拿不到的（見 §7 對照表），最高槓桿是**成為他們的上游**（exporter），而非在對方深耕的領域重建。

---

## 2. agentsview 架構

### 2.1 整體資料管線

```
  50+ agent 目錄 (~/.claude, ~/.codex, s3://...)
        │
        ▼ Discover()                    ┌──────────────────────────┐
  ┌───────────────┐  fsnotify watch     │ Provider interface        │
  │ AgentDef      │  + 15min 定期兜底    │ (parser/provider.go:74-94)│
  │ registry      │───────────────┐     │  Discover / WatchPlan     │
  │ (types.go:    │               │     │  SourcesForChangedPath    │
  │  63-89)       │               ▼     │  Fingerprint / Parse      │
  └───────────────┘   classifyProvider  │  ParseIncremental         │
   宣告式欄位:          ChangedPath      └──────────────────────────┘
   路徑/watch策略/     (engine.go:615-736)
   IDPrefix/能力旗標          │
                             ▼
              ┌──────────────────────────┐
              │ SourceFingerprint         │  size+mtimeNS+inode+device
              │ (provider.go:273-280)     │  +hash → 改名/輪替不重解析
              └────────────┬─────────────┘
                           ▼
              worker pool ≤8 goroutine (engine.go:3176-3220)
              增量解析: Offset+LastEntryUUID, DAG fork 偵測
              → IncrementalNeedsFullParse (provider.go:352-389)
                           │
                           ▼ 每 100 筆 flush 一次交易 (engine.go:25-28)
              ┌──────────────────────────┐
              │ SQLite (WAL)              │ sessions/messages/tool_calls/
              │ writer=1 conn, reader pool│ usage_events/FTS5(porter)
              │ atomic.Pointer 熱切換     │ dataVersion=59 → 全量 resync
              │ (db.go:359-379,2179-2196) │ + 孤兒 session 保留 + 原子 swap
              └────────────┬─────────────┘
                    ┌──────┴──────┐
                    ▼             ▼
              HTTP API + SSE   CLI (daemon warm → HTTP 委派,
              (Svelte 5 SPA     否則直開 SQLite + write lock)
               embed 進 binary) (daemon_runtime.go:68,148)
```

### 2.2 對 ccxray 最重要的三個抽象決策

1. **Provider 擁有「來源身份」全部權威，引擎只認 `SourceRef`/`Fingerprint`**（provider.go:159-199）。`Key`（provider 內穩定）、`FingerprintKey`（持久化查詢鍵）、`DisplayPath`（可為虛擬路徑 `<db>#<sessionID>`）三種身份分離。→ ccxray 的 wire-parsers 目前抽象「訊息格式」，尚未抽象「來源身份」，這是 #158-161 深化與 restore/多來源合併會撞到的牆。
2. **能力宣告 + 型別化不支援錯誤**：`UsageCapabilities.NoPerMessageTokenData`（types.go:91-94）等旗標讓 UI/統計層不用 `if agent === 'codex'` 散彈 guard；可選能力用哨兵錯誤 `ErrUnsupportedProviderFeature` + `errors.Is`（provider.go:17-35），不支援是型別化事實而非 nil check。→ 直接對治 ccxray 的 codex `t.name` guard 教訓。
3. **dataVersion（parser 語意版本）與 schema version 分離**（db.go:2179-2196）：parser 行為改版 → bump dataVersion → 建新 DB 全量 resync → copy 孤兒 → 原子 swap。→ ccxray 的派生索引（index.ndjson、versionIndex、session 推斷）就是「parser 輸出」，目前無重算機制；一個整數欄位可買到，與 parked 的 index-rebuild-resilience 分支互補。

### 2.3 其他值得記錄的工程實踐（證據）

| 實踐 | 位置 | ccxray 對應 |
|---|---|---|
| parsediff：新舊 parser 對真實檔案全量 diff 的回歸工具 | `internal/sync/parsediff*.go`（~160KB） | 對 `~/.ccxray/logs` 存量幾乎免費可做；強化 verification-principles 的 fail-on-old 證據 |
| FTS bulk 更新前先 DROP after-delete trigger 再重建 | db.go:327-338 | 若未來做索引可抄 |
| embedded pricing snapshot（build 時產出 gzip LiteLLM 快照 24.7KB 進 binary） | `internal/pricing/fallback.go:19-27` | 取代 `server/pricing.js` 手寫 fallback rates；release script 加一步 |
| shutdown drain 行為鎖進測試 | `internal/server/shutdown_test.go:18-35` | `gracefulExit` + WS drain 曾有 0-byte log 前科，該補同型測試 |
| S3 sidecar metadata 折疊進主檔 freshness 身份 | s3source.go:242-283 | 未來做多機聚合讀取時回來抄 |
| watch 資源耗盡 → 該子樹降級 polling | watcher.go:85+ | 目前不需要（wire 攔截不 watch） |

---

## 3. agentsview Insights（建議引擎）——重點深挖

### 3.1 分層架構

```
                 sync 時（每次 session 寫入）
  messages ──► computeSignalsFromMessages()  ◄── 純函式, 無 DB 存取
               (internal/sync/signal_compute.go)
                    │ 預存為 sessions 表欄位
                    ▼
  ┌─────────────────────────────────────────────────┐
  │ sessions 表: short_prompt_count / unstructured   │
  │ _start / missing_success_criteria / duplicate    │
  │ _prompt / tool_failure / retries / edit_churn /  │
  │ compaction / pressure / health_score / grade ... │
  └───────────────────┬─────────────────────────────┘
                      │ 查詢時聚合（例外: frustration_marker
                      │ 每次即時掃 messages, analytics.go:4163-4198）
                      ▼
  ┌──────────────────────────────┐   ┌────────────────────────────┐
  │ 確定性建議卡（無需 LLM）        │   │ LLM 生成層（可選）           │
  │ frontend qualityPatterns.ts   │   │ spawn 本機 claude -p        │
  │ :136-156                      │   │ --output-format json        │
  │ 4 patterns → 前 4 張卡         │   │ --no-session-persistence    │
  │ severity: <18% watch          │   │ --tools "" (generate.go:    │
  │  ≥18% warning ≥35% critical   │   │ 221-306)。只餵聚合統計,      │
  │ (:454-468)                    │   │ 不餵 transcript。SSE 串流,   │
  │ 文案=「N 會話中 M 個觸發」      │   │ 結果存 insights 表           │
  └──────────────────────────────┘   └────────────────────────────┘
```

設計評語：**確定性規則優先、LLM 只做可選加值**——零配置可用、sync 時預算好查詢零開銷、LLM 只收聚合數字隱私風險低、每張卡附觸發數可追溯。UI 明文標註「上方的確定性面板無需 LLM 配置即可使用」。

### 3.2 訊號規則明細（`internal/signals/`，移植時的規格書）

| 訊號 | 規則 | 閾值 | 位置 |
|---|---|---|---|
| 短任務開場 | 第一個非控制詞提示 < 30 字元；或距上個 assistant 回應 > 30 分鐘後的 < 30 字元提示 | 30 字元 / 30 分鐘 | heuristics.go:197-218 |
| 結構不清需求 | 僅 code task；首提示同時無 file 路徑、無 constraint 詞（must/never/only…14 詞）、無 spec 結構 | 布林 | heuristics.go:379-411 |
| 缺乏成功條件 | 僅 code task；全部提示無 success/acceptance/expected/done when… | 布林 | heuristics.go:414-427 |
| 缺少驗證路徑 | 僅 code task；全部提示無 test/verify/check/reproduce/run | 布林 | heuristics.go:429-443 |
| 重複提示詞 | Jaccard ≥ 0.85 且 normalized ≥ 20 字元、≥ 4 tokens | 0.85 | heuristics.go:458-480 |
| 受挫標記 | regex `!{3,}|\?{3,}|wtf|doesn't work|still broken…` 或全大寫比例 ≥ 0.40（查詢時即時算） | 0.40 | heuristics.go:46-104 |
| 壓縮偵測 | 相鄰 assistant context tokens 下降 > 30% | 30% | context.go:171-187 |
| 任務中途壓縮 | 壓縮前 10 個工具與後 5 個工具有 ≥ 2 個共同名稱 | 2 | context.go:39-71 |
| 上下文壓力高 | peak context / model window > 0.9 | 0.9 | context.go:161 |
| 工具失敗信號 | Bash 輸出含 command not found/Permission denied/traceback/stack…；Edit/Write 含 FAILED；EventStatus errored/cancelled | — | toolhealth.go:58-137 |
| 重試 | 同工具同 InputJSON 連續 ≥ 3 次 | 3 | toolhealth.go:160-183 |
| 編輯返工 | 同檔案在 ordinal 跨度 < 10 內被 Edit/Write ≥ 3 次 | 10/3 | toolhealth.go:188-211 |
| 失控工具循環 | 同 signature 連續 ≥5 且 ≥3 失敗；或 12 次視窗內失敗 ≥6 | — | heuristics.go:537-631 |
| 結果分類 | ended_with=user + ≥10 訊息 → abandoned；final_failure_streak ≥3 → errored；10 分鐘內活動 → recent | — | outcome.go:40-96 |

**Health score（score.go）**：100 起算減 penalty——errored -30、abandoned -15、tool failure 每個 -3（cap -30）、retry 每個 -5（cap -25）、edit churn 每個 -4（cap -20）、mid-task compaction 每次 -8（cap -18）、pressure -10…；A ≥90 / B 75 / C 60 / D 40 / F <40（:209-221）。**實測我的語料：A 佔 3143/3427（92%）——分數分布極度右偏，總分無鑑別度**（見 §6 截圖），這是不移植 A–F 總分的直接證據。

### 3.3 移植判斷（wire 資料的優劣勢）

ccxray 算得**更準**：mid-task compaction（有 compact boundary event，勝過 30% token-drop 啟發式）、context pressure（每 turn cache/context token 直接可得）、tool failure/retry/edit churn（每 turn 完整 messages array + tool input JSON）、outcome（SSE 最後 event role）。
ccxray 算**不了/成本高**：全部 prompt 文字類啟發式（short prompt/unstructured/frustration）——需要批量掃 message text 的持久層，且 agentsview 的規則全是**英文導向**（constraint 詞表、frustration regex），對中文使用語料直接失效，移植必須重寫規則 + 重校準閾值。

---

## 4. agentsview UI/UX（截圖）

前端：Svelte 5 runes + 手繪 inline SVG（無圖表框架，證明 vanilla 路線可行）、SSE 全域 stream（60s 自癒 + circuit breaker）、skinny index 先載 + 可見列 hydrate（concurrency 6）、9 route 手工 SPA、i18n 全覆蓋。

### 4.1 分析首頁
![home](src/reference-analysis/01-home.png)
GitHub 式活動 heatmap（可切維度、click-to-filter）、時×日 heatmap、熱門會話排行。**教訓**：初次 sync 時 KPI 顯示 0 而非 skeleton——佔位值長得像真資料（heuristic 檢核 Major）。

### 4.2 Usage 頁
![usage](src/reference-analysis/11-usage.png)
成本疊加柱狀（groupBy 項目/模型/Agent）、成本歸因樹、cache 效率、treemap、兩時段對比。同畫面 KPI $0.00 與下方真實成本並存 = 同步中資料矛盾（Major）。

### 4.3 Insights 頁（建議功能）
![insights](src/reference-analysis/14-insights.png)
![insights-bottom](src/reference-analysis/16-insights-bottom.png)
確定性建議卡（每張標「基於規則」+「3427 會話中 156 個觸發」）；四訊號面板 + per-agent 對比 + 直方圖；底部 LLM 生成器（模板 + 生成器選擇 + 可選焦點）。**證據掛在建議上是全場最佳實踐**；A 級 92% 的分數通膨是反面教材。

### 4.4 Session 詳情 + Vital Signs（#91 最直接參考）
![vitals](src/reference-analysis/22-session-vitals.png)
![vitals-zoom](src/reference-analysis/23-vitals-zoom.png)
右欄三層遞進：①摘要（工具調用 55、耗時 36m26s、最慢 Task·20m8s 橘標、SUB-AGENTS 7）→ ②分類耗時條 + per-category timeline lanes（「點擊高亮顯示／點擊標記滾動」inline 揭露）→ ③時序 calls 清單，**並行呼叫括號成組**（「並行·3 次調用 32.1s」下掛三個 Bash）。另有 5 態 session status（working/waiting/idle/stale/**unclean**=crash mid-tool-call）、A–F badge、subagent inline 展開（`SubagentInline.svelte`）、Focused transcript mode、4 種 layout 切換（`l` 鍵）。

### 4.5 Cmd+K 搜尋
![cmdk](src/reference-analysis/24-cmdk.png)
<3 字元顯示最近 sessions；≥3 走 FTS5（300ms debounce + abort）；結果**按 session 分組**防長 session 霸榜；相關性/最近切換；命中詞高亮。

### 4.6 趨勢頁（詞頻時序）
![trends](src/reference-analysis/13-trends.png)
對自己語料畫任意詞項的出現頻率時序（支援 `a | b` variants、按訊息量歸一）——「我這季在做什麼」的獨特視角。

---

## 5. ctx 架構

### 5.1 Workspace 與資料流

```
  7 crates (Cargo.toml workspace, rusqlite bundled):
  ctx-cli / ctx-history-core(型別) / ctx-history-capture(解析)
  ctx-history-store(SQLite+FTS) / ctx-history-search(排名)
  ctx-protocol(合約) / ctx-sdk

  provider history 檔 (46 providers, PROVIDER_SPECS 宣告矩陣,
  capture/provider_sources/specs.rs)
        │  raw_retention: PathReference ← 不複製原始資料, 只存指標+preview
        ▼
  3 類 adapter: json / jsonl_tree / sqlite (provider/adapter_impls/)
        │  增量: catalog mtime+size+SHA256 prefix 三重驗證
        │  (cli/commands/import/catalog.rs:193)
        │  檔頭 hash 不符(被改寫) → 整檔重匯, 否則只解析 tail
        ▼
  ┌────────────────────────────────────────────────┐
  │ SQLite schema (store/schema/ddl.rs)             │
  │ capture_sources → sessions (parent/root id,     │
  │   agent_type) → session_edges (6 種關係)         │
  │ events: 11 類 event_type, seq UNIQUE 全域排序    │
  │ files_touched (change_kind), artifacts          │
  │ 每表: visibility/sync_state/fidelity/confidence  │
  │  (五級 explicit→unknown, 推論品質進 schema)       │
  │ FTS5 ×3 (session/event/artifact), 預設 unicode61 │
  └───────────────────┬────────────────────────────┘
                      ▼
  自訂 weighted ranking (search/ranking.rs:392+):
    title 8.0 > primary_user 5.0 > 失敗 command 4.0
    > tool 3.5 > 成功 command/tag/file 3.0 > 其他 2.0
    ★ 失敗紀錄權重 > 成功 ── debug 場景失敗軌跡更有資訊量
                      ▼
  輸出漏斗: search(ranked snippet+citation)
          → show(--window ≤50, MAX_EVENT_WINDOW main.rs:723)
          → locate(回原檔) → sql(read-only 逃生艙)
```

### 5.2 Agent-facing 輸出設計（ccxray 未來 API 的規格參考）

- **`citations`**（ctx_event_id/session_id/source_path/cursor）+ **`why_matched`**（命中原因）+ **`suggested_next_commands`**（直接可執行的下一步，agent 不用幻覺 CLI 語法）——search_render.rs
- 文字模式 UUID 截 8 字元省 token；`--json` 給 script；**SKILL.md 明文警告 agent 讀取場景別用 --json**（JSON 更肥）
- window 硬上限 50 防 agent 拉爆 context
- `ctx sql` 多層防禦：`stmt.readonly()`（raw_sql.rs:119）、單語句 tail 偵測（:335）、progress_handler(1000) timeout（:145）、max_rows 100/值 512B、**stable views**（`ctx_sessions` 等 6 個）作為對外 SQL 合約——底層 schema 升級不 break agent 寫好的查詢
- 自我排除：Codex 環境偵測 `CODEX_THREAD_ID`，搜尋自動排除當前 session tree（docs/search.md:107-110）——「用自己問自己」的污染問題，ccxray 做 agent API 時同樣要處理（session_id 已在 request header）

### 5.3 整合生態

- **history-source-plugin = stdin/stdout JSONL**（docs/history-source-plugins.md:1-17）：任何語言的子行程輸出 JSONL 即可成為 ctx 資料來源。**這是 ccxray exporter 的接口。**
- contracts/agent-history-v1：「intentionally product-shaped rather than a mirror of ctx storage internals」（README.md:1）；nullable + `additionalProperties: true`、required 欄位只在 contract id 變更時動、錯誤 shape = code(enum)+message+retryable+cause（schema.json:265-288）；determinism 只承諾「same DB + same query = same ranked order」（docs/product-contract.md:49-57）——與 ccxray 既有「contract 承諾 shape 而非 value」偏好同路，可直接對表。
- 7 語言 SDK 全是 subprocess thin client（CLI 即 API），未發佈 registry；hosted backend 預留欄位回 `not_supported`（商業化訊號）。
- 隱私立場：**刻意不做自動 redaction**（「false sense of security 比沒有更危險」，docs/storage.md:225-229）；analytics 只收 bucketed counts 不收內容，`CTX_ANALYTICS_OFF=1` 可關。
- 測試：40+ provider 真實格式 fixture + canonical 輸出 fixture 雙側對照、proptest 抗惡意輸入、migration v1–v42。

---

## 6. UX Heuristic 檢核結果（兩邊都 CONDITIONAL PASS）

| | agentsview | ccxray |
|---|---|---|
| 最大問題 | [Major] 同步中 KPI 顯示 $0.00/0 與同屏真實資料矛盾（0 被當 loading 佔位） | [Major] 高負載下 Usage 頁**白屏 ~12 秒**無任何指示（見下圖，#122 現場實錄） |
| 次要 | 洞察頁認知負荷高、可點擊直方圖 affordance 弱；A 級通膨 | System Prompt 頁 loading 只有純文字、欄框消失（違反自家 Layout Stability 原則）；快捷鍵 hint line 不同頁不一致 |
| 強項 | 證據掛建議上、快捷鍵全面自我揭露、Vital Signs 三層遞進 | live 維度無可替代（streaming 指示/Context HUD/quota ticker）、System Prompt diff 獨有 |

ccxray 高負載白屏證據（左：點開 Usage 當下；右：~12 秒後）：
![cx-usage-blank](src/reference-analysis/cx-03-usage.png)
![cx-usage-loaded](src/reference-analysis/cx-03b-usage-wait.png)

對照用主畫面與 System Prompt 頁：
![cx-timeline](src/reference-analysis/cx-01-timeline.png)
![cx-sysprompt](src/reference-analysis/cx-04b-sysprompt-wait.png)

---

## 7. 資料互補性對照（exporter 價值論證）

| 資訊 | provider history 檔（agentsview/ctx 可得） | ccxray wire log |
|---|---|---|
| 每 turn 完整 system prompt | 不完整/常只有末版 | ✅（全量或 delta 鏈） |
| compaction 前的訊息 | ❌（已被覆蓋） | ✅（delta chain 可重建） |
| cache_creation / cache_read tokens | ❌ | ✅ |
| HTTP response headers / SSE 細節 | ❌ | ✅ |
| model 切換（subagent 降級模型） | 部分 | ✅ |
| intercept 前原始 payload | ❌ | ✅ |
| 50+ agent 覆蓋 | ✅ | ❌（只有走 proxy 的） |
| 跨 session 檢索/FTS | ✅ | ❌ |
| files_touched 維度 | ✅（ctx） | ❌（資料在 tool_use 裡但未提升為實體） |

---

## 8. Expert Panel 結論與落地順序

**定位**：live wire forensics 深化 + 成為 post-hoc/記憶工具的上游。不跟進 post-hoc 分析堆疊。

**未解張力（使用者決策點）**：ccxray 是「個人工具做到極致」還是「往產品/社群成長」？前者 → 下表 1-3 優先；後者 → 4 與 agent-facing 契約前提。

### 前 5 落地順序（含下一步細節）

| # | 項目 | 下一步（具體） | 驗證方式 | 對應 |
|---|---|---|---|---|
| 1 | Dashboard 可用性底線 | 全站 skeleton：Usage/System Prompt 頁保留欄框 + 骨架（禁純白屏、禁 0 佔位）；配合 perf 修復 | 高負載重現（proxy 長 session 進行中開 Usage 頁）：白屏時間 before/after 中位數 | #122 #167 #166 |
| 2 | 來源身份 + dataVersion + capability | wire-parser 介面加 `capabilities` 物件與型別化 NotSupported；index.ndjson 加 `dataVersion` 欄，啟動不符 → 重建派生資料 | 契約測試鎖 capability key 集合；bump dataVersion 觸發重建的整合測試 | #158-161、index-rebuild-resilience |
| 3 | #91 收割 Vital Signs | 對照 `SessionVitals.svelte`：分類耗時條 + 並行括號成組 + 最慢呼叫標示 + click-to-scroll；推斷型顯示一律附「N 中 M」證據數 | ux-heuristic-analysis gate + 既有 #91 prototype 流程 | #91 #112 #115-117 |
| 4 | ctx exporter POC | 寫 `bin/ctx-export`（或獨立小腳本）：讀 `~/.ccxray/logs` → 依 docs/history-source-plugins.md 輸出 JSONL（含 wire 獨有欄位：system prompt hash、cache tokens、compaction 標記）；本機 `ctx setup` 註冊 | dogfood 一週：實際 agent session 中 `ctx search` 能否召回 wire 獨有資訊；不能 → 停損 | 新 issue |
| 5 | Mini insights（確定性、wire 優勢訊號） | 只做 5 個：mid-task compaction（用 compact boundary event）、tool failure、edit churn（tool input 的 file_path）、context pressure、outcome。純函式 + 「N 中 M」呈現；**不做 A–F 總分**（§3.2 通膨證據）；閾值用自己語料重校準（中文 prompt 使 agentsview 英文規則失效） | 先 dogfood：兩週內是否至少一次據訊號改變行為；否 → 不擴大 | 新 issue（可併 #64） |

**便宜隨手做**：embedded pricing snapshot、快捷鍵揭露一致化、shutdown drain 回歸測試、wire-parser canonical 輸出 fixture（parsediff 簡化版）。

**陷阱（明確不做）**：SQLite/FTS 堆疊、PG 多機 sync、desktop app、LLM insights 生成、i18n、fork/resume、pinned/trash、自建 MCP server（先走 ctx 生態驗證需求）。共同理由：稀釋 live-first 定位／超出單人維護量／對方已做得夠好。

**Missing Chair（Graham）**：「別重構了，這週末先把 exporter 跑起來」——對 exporter 急迫性成立（已入前 5），但「只衝新東西」在本 repo 已被假 COMPLETE 事件證偽，不採全盤。

---

## 9. 注意事項（移植前必讀）

1. **授權**：agentsview = MIT、ctx = Apache-2.0。概念/schema 設計移植無虞；**逐行抄碼需保留版權聲明**（Apache-2.0 另需 NOTICE 傳遞）。建議一律「讀懂後重寫」，本文件的 file:line 是規格引用非複製來源。
2. **版本漂移**：所有 file:line 釘在 `172e97d6` / `4710263`。上游活躍開發中，引用前先 `git -C reference/<repo> log --oneline -1` 確認；若更新 reference，本文件需重驗（比照 wire-protocol-reference 的 confidence tag 制度）。
3. **截圖隱私**：`docs/src/reference-analysis/` 內全部是含真實資料的 dogfood 原圖（gitignored）。要放進公開 docs：本機 PIL 裁切/遮罩，絕不經 imagegen。
4. **數字的懷疑**：ctx 的「50x token 節省」（917 vs 45,734）是 cherry-picked 極端案例，數量級真實但引用要標註。agentsview 的 health score 在真實語料上 A 佔 92%——任何移植的評分制都要先看分布再定閾值。
5. **語言偏差**：agentsview 全部 prompt 啟發式（constraint 詞表、frustration regex、spec 結構偵測）是英文導向；本機語料大量中文，直接移植 = 系統性 false negative。訊號移植必須配中文規則與本地語料重校準。
6. **維護量預算**：每借一項都是永久維護面（單人專案）。前 5 之外的任何候選，先過「兩週 dogfood 有無行為改變」的 value gate 再排期。
7. **實作衛生**：改 server 時 hub 正在監測本 session（先建新檔再碰 index.js）；smoke 一律隔離 `CCXRAY_HOME` + 獨立 port；效能主張附 before/after 中位數；bug 類改動附 fail-on-old/pass-on-new 證據。
8. **本機殘留**：分析用 agentsview 可能仍在 `:8899`（`pkill agentsview` 關閉）；隔離資料 `/tmp/agentsview-xray`（~1.2GB 可刪）。

## 附錄：截圖索引

| 檔案 | 內容 |
|---|---|
| 01-home.png | agentsview 分析首頁（heatmap/熱門會話） |
| 11-usage.png | Usage 成本頁（含同步中 KPI 矛盾證據） |
| 13-trends.png | 詞頻時序趨勢頁 |
| 14 / 16-insights*.png | Insights 建議卡 + 訊號面板 + LLM 生成區 |
| 22 / 23-vitals*.png | Session 詳情 + Vital Signs 側欄（#91 參考） |
| 24-cmdk.png | Cmd+K FTS 搜尋 |
| cx-01-timeline.png | ccxray 主 dashboard（live） |
| cx-03-usage.png / cx-03b-usage-wait.png | 高負載白屏 → 12 秒後載入（#122 證據） |
| cx-04b-sysprompt-wait.png | System Prompt 三欄 diff 檢視 |
