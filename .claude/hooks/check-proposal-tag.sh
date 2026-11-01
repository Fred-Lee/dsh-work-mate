#!/usr/bin/env bash
# WorkMate PreToolUse hook (Claude Code): block `git commit` without a
# [proposal:<id>] marker. Claude Code pipes the tool-call JSON on stdin;
# exit 2 blocks the tool call and feeds stderr back to the model.
# Requires Claude Code >= 1.0.60 (PreToolUse JSON/stdin contract).
set -euo pipefail

input=$(cat)
command=$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;; # not a git commit — allow
esac

case "$command" in
  *"[proposal:"*) exit 0 ;; # marker present — allow
esac

echo "提交信息缺少 [proposal:<id>] 标记（WorkMate 归档编排依赖它关联提交）。" \
     "请在 commit message 中加入提案标记，例如：git commit -m \"feat: ... [proposal:<提案id>]\"" >&2
exit 2
