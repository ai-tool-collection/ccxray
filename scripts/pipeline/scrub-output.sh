#!/usr/bin/env bash
# 發 GitHub comment / PR body 前的 scrubber。只允許 bounded excerpt / hash /
# exit code / metric 表；攔截疑似完整 request/response/log dump、home 路徑、密鑰。
# 本機 log 可能含 prompt、路徑、token——這道閘在「發出去之前」以 script 執行。
#
# 用法（作為 pipe 閘）:
#   printf '%s' "$draft" | scrub-output.sh | gh issue comment N --body-file -
#   scrub-output.sh --input draft.md
#
# 行為: clean → 原文輸出到 stdout、exit 0；命中 → 違規印到 stderr、
#        **不輸出原文**、exit 1（pipe 到 gh 時 body 為空 → 貼不出去）。
#
# 可調 env: SCRUB_MAX_FENCE_LINES（預設 15，超過視為 log/dump）
# Exit: 0 = clean  1 = 命中違規（不放行）  3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

max_fence="${SCRUB_MAX_FENCE_LINES:-15}"
input=""
case "${1:-}" in
  --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名" ;;
  "" ) ;;
  -* ) pipeline_die "未知選項: $1" ;;
  * ) pipeline_die "未知參數: $1（用 stdin 或 --input <file>）" ;;
esac

if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  text="$(cat "$input")"
else
  text="$(cat)"
fi

violations=()

# R1 過長 fenced 區塊（log / request dump 訊號）
maxlen="$(awk '
  /^[[:space:]]*```/ { if (inf) { if (cnt>mx) mx=cnt; inf=0 } else { inf=1; cnt=0 }; next }
  inf { cnt++ }
  END { print mx+0 }
' <<<"$text")"
if [[ "$maxlen" -gt "$max_fence" ]]; then
  violations+=("R1 過長 fenced 區塊（${maxlen} 行 > ${max_fence}）：改貼 bounded excerpt / hash / exit code")
fi

# R2 home 路徑洩漏（含使用者名）
if grep -nE '/(Users|home)/[^/[:space:]]+/' <<<"$text" >/dev/null; then
  lines="$(grep -nE '/(Users|home)/[^/[:space:]]+/' <<<"$text" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
  violations+=("R2 檔案系統路徑含使用者名（行 ${lines}）：改用 repo 相對路徑")
fi

# R3 密鑰／token 形狀
if grep -nEi '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|x-api-key|authorization:[[:space:]]*[A-Za-z0-9])' <<<"$text" >/dev/null; then
  lines="$(grep -nEi '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|x-api-key|authorization:[[:space:]]*[A-Za-z0-9])' <<<"$text" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
  violations+=("R3 疑似密鑰/授權標頭（行 ${lines}）：一律不得貼")
fi

# R4 完整 request/response JSON（Anthropic/OpenAI 訊息結構訊號）
if grep -nE '"(messages|input|tools|system)"[[:space:]]*:[[:space:]]*\[' <<<"$text" >/dev/null \
   && grep -nE '"(role|content|tool_use|tool_result)"' <<<"$text" >/dev/null; then
  violations+=("R4 疑似完整 request/response JSON（messages/role/content 結構）：改貼 hash + 摘要欄位")
fi

if [[ ${#violations[@]} -gt 0 ]]; then
  { echo "✗ scrub-output 攔截 ${#violations[@]} 項，未放行:"; printf '  - %s\n' "${violations[@]}"; } >&2
  exit 1
fi

# clean：pass-through
printf '%s\n' "$text"
exit 0
