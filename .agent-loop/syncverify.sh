#!/bin/bash
# usage: syncverify-win.sh <branch> <vitest paths...>
# Runs in the orchestrator worktree on a detached HEAD (the branch itself is checked out in the subagent's worktree).
set -u
S="/c/Users/recti/AppData/Local/Temp/claude/E--agent-sdk/0d06bab1-f0e9-415d-bab2-8bca2d62419d/scratchpad"
cd /e/agent-sdk/.claude/worktrees/loop-orch || exit 1
b="$1"; shift
git fetch origin main "$b" --quiet || exit 1
git checkout -q --detach "origin/$b" || exit 1
git merge --no-edit origin/main >/dev/null 2>&1
conf=$(git diff --name-only --diff-filter=U)
code=$(echo "$conf" | grep -vE "CHANGELOG.md|\.md$|llms(-full)?\.txt" || true)
if [ -n "$code" ]; then echo "CODE CONFLICTS: $(echo $code)"; exit 2; fi
docs=$(echo "$conf" | grep -E "CHANGELOG.md|\.md$" || true)
if [ -n "$docs" ]; then python "$S/keepboth-win.py" $docs; git add $docs; fi
if echo "$conf" | grep -q llms; then git checkout --theirs llms.txt llms-full.txt 2>/dev/null; git add llms.txt llms-full.txt; fi
if [ -n "$docs" ] && grep -lqs "^<<<<<<<" $docs; then echo "MARKERS LEFT in docs"; exit 5; fi
if [ -n "$conf" ]; then
  npm run -s docs:llms >/dev/null 2>&1; git add llms.txt llms-full.txt
  git commit -q --no-edit && echo "merge committed (resolved: $(echo $conf))"
fi
if npm run -s docs:llms:check >/dev/null 2>&1; then echo "llms fresh"; else
  npm run -s docs:llms >/dev/null 2>&1; git add llms.txt llms-full.txt
  git commit -q -m "chore: regenerate llms.txt after merging main

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"; echo "llms regenerated"; fi
if ! git diff --quiet ORIG_HEAD_DEPS -- package.json package-lock.json 2>/dev/null; then npm ci --no-audit --no-fund >/dev/null 2>&1 && echo "deps synced"; fi
git tag -f ORIG_HEAD_DEPS HEAD >/dev/null 2>&1
npx tsc --noEmit && echo "tsc ok" || { echo "TSC FAILED"; exit 3; }
out=$(npx vitest run "$@" 2>&1)
echo "$out" | grep -E "Test Files|Tests |FAIL" | grep -v importGraph
if echo "$out" | grep -E "^ FAIL" | grep -qv importGraph; then echo "TESTS FAILED, not pushing"; exit 4; fi
if ! echo "$out" | grep -qE "Test Files .*passed"; then echo "NO TEST SUMMARY (vitest did not finish?), not pushing"; echo "$out" | tail -15; exit 4; fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "DIRTY TREE after verify:"; git status --short --untracked-files=no | head; exit 6; fi
git push -q origin "HEAD:$b" && echo "HEAD $(git rev-parse HEAD)"
