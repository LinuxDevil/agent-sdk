#!/bin/bash
# usage: mergepr.sh <pr-number> <branch> <vitest paths...>   (sync with main, verify, squash-merge, return to the state branch)
S="/c/Users/recti/AppData/Local/Temp/claude/E--agent-sdk/0d06bab1-f0e9-415d-bab2-8bca2d62419d/scratchpad"
pr="$1"; b="$2"; shift 2
cd /e/agent-sdk/.claude/worktrees/loop-orch || exit 1
bash "$S/syncverify-win.sh" "$b" "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^warning" | tail -14 > "$S/sv.out"; cat "$S/sv.out"
H=$(grep -oE "^HEAD [0-9a-f]+" "$S/sv.out" | cut -d' ' -f2)
if [ -n "$H" ]; then gh pr merge "$pr" --repo LinuxDevil/agent-sdk --squash --match-head-commit "$H" 2>&1 | tail -1; else echo "NOT MERGED"; fi
git fetch origin main -q; echo "main: $(git log origin/main --oneline -1)"
[ -n "$H" ] && git checkout -q loush/blissful-volta-i76xiy
