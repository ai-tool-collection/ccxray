#!/usr/bin/env bash
# 差異檢查：同一測試在舊碼必須 FAIL、新碼必須 PASS。
# 用法: diff-check.sh <base-ref> <test-file...> -- <test-cmd...>
# 例:   diff-check.sh main test/escape.test.js -- node --test test/escape.test.js
# Exit: 0 = old FAIL / new PASS  1 = 新碼失敗  2 = 舊碼也 PASS(測試分辨不出新舊)
set -euo pipefail

base="$1"; shift
tests=()
while [[ "$1" != "--" ]]; do tests+=("$1"); shift; done
shift
cmd=("$@")

root=$(git rev-parse --show-toplevel)
wt=$(mktemp -d)/before
git -C "$root" worktree add --force --detach "$wt" "$base" >/dev/null 2>&1
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT

# 新測試複製進舊碼；deps 用 symlink 共享，避免舊碼因缺 node_modules 假失敗
for t in "${tests[@]}"; do
  mkdir -p "$wt/$(dirname "$t")"
  cp "$root/$t" "$wt/$t"
done
[[ -d "$root/node_modules" && ! -e "$wt/node_modules" ]] && ln -s "$root/node_modules" "$wt/node_modules"

echo "== NEW code: expect PASS =="
if ! (cd "$root" && "${cmd[@]}"); then
  echo "❌ 新碼失敗 — 先讓它綠再來證明差異"; exit 1
fi

echo "== OLD code ($base): expect FAIL =="
if (cd "$wt" && "${cmd[@]}"); then
  echo "⚠️  舊碼也 PASS — 這個測試分辨不出新舊，證明不了「更好」"; exit 2
fi

echo "✅ old FAIL / new PASS — 差異檢查成立"
