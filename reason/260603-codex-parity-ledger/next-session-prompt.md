# Next-session prompt (paste as first message)

繼續 ccxray Codex parity 工作，分支 `feat/codex-dashboard-foundation`。

進度：Step1 truth-marker ✓、Step2 gap ledger ✓。**Step3 (A1-A3 寫入面抽象) 已完成
brainstorm→spec→pre-mortem→plan，spec/pre-mortem/plan 全部經 codex 審過通過
(plan 審查修正在 commit c63a289)。唯一待拍板 = 執行模式。可直接開工。**

請依序讀（都已 commit）：
1. `docs/superpowers/plans/2026-06-03-a1a3-write-path-abstraction.md` ← 可執行計畫，10 tasks
2. `docs/superpowers/specs/2026-06-03-a1a3-premortem.md` ← 風險 T1-T9 + Go/No-Go
3. `docs/superpowers/specs/2026-06-03-codex-write-path-abstraction-design.md` ← 設計

用 `superpowers:executing-plans`（或 `subagent-driven-development`）逐 task 執行，TDD、每 task 一 commit。

開工前先問使用者一件事：
- 執行模式：subagent-driven（推薦，每 task 開新 subagent + task 間審查）還是 inline？
（plan 已 codex 審過，不需再送審；關鍵 phase 3b①/3b④/完成 gate 可再走 codex 二審。）

硬規則：
- 完成前必跑 plan Task 10：隔離 smoke（獨立 CCXRAY_HOME + 自選 port，**絕不用 :5577**）+ 真實 Codex&Claude 流量 + deep-link `?e=` 導航 + 重啟前後 live↔restore 截圖一致，**雙 provider 都過才算 done**。
- 編輯 `server/` 前重跑 go/no-go：`ps -o command= -p "$(lsof -iTCP:5577 -sTCP:LISTEN -t | head -1)"` 確認非 `--watch`。
- 非 trivial 走 codex review gate；未授權前不要 push / 開 PR。

背景全貌在 memory `project_dashboard_agent_abstraction`（RESUME 段）。後續 Step4 P1-P5、Step5 N 層(N1 session-collapse / N2 credential / N3 MCP-noise) 見 `reason/260603-codex-parity-ledger/ledger.md`。
