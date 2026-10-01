#!/bin/bash
# usage: syncverify.sh <branch> <vitest paths...>
set -u
S=/tmp/claude-0/-home-user-agent-sdk/15860ad4-fff3-53a9-a88b-1d410d4e9ab7/scratchpad
cd /home/user/agent-sdk
b="$1"; shift
git fetch origin main "$b" --quiet || exit 1
git checkout -q -B "$b" "origin/$b" || exit 1
git merge --no-edit origin/main >/dev/null 2>&1
conf=$(git diff --name-only --diff-filter=U)
code=$(echo "$conf" | grep -vE "CHANGELOG.md|\.md$|llms(-full)?\.txt" || true)
if [ -n "$code" ]; then echo "CODE CONFLICTS: $(echo $code)"; exit 2; fi
docs=$(echo "$conf" | grep -E "CHANGELOG.md|\.md$" || true)
if [ -n "$docs" ]; then python3 $S/keepboth.py $docs; git add $docs; fi
if echo "$conf" | grep -q llms; then git checkout --theirs llms.txt llms-full.txt 2>/dev/null; git add llms.txt llms-full.txt; fi
if [ -n "$docs" ] && grep -lqs "^<<<<<<<" $docs; then echo "MARKERS LEFT in docs"; exit 5; fi
if [ -n "$conf" ]; then
  npm run -s docs:llms >/dev/null 2>&1; git add llms.txt llms-full.txt
  git commit -q --no-edit && echo "merge committed (resolved: $(echo $conf))"
fi
if npm run -s docs:llms:check >/dev/null 2>&1; then echo "llms fresh"; else
  npm run -s docs:llms >/dev/null 2>&1; git add llms.txt llms-full.txt
  git commit -q -m "chore: regenerate llms.txt after merging main

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016bY29ibQgv3MDdjAbUT4YR"; echo "llms regenerated"; fi
if ! git diff --quiet origin/main -- package.json; then npm ci --no-audit --no-fund >/dev/null 2>&1 && echo "deps synced"; fi
npx tsc --noEmit && echo "tsc ok" || { echo "TSC FAILED"; exit 3; }
out=$(npx vitest run "$@" 2>&1)
echo "$out" | grep -E "Test Files|Tests |FAIL" | grep -v importGraph
if echo "$out" | grep -E "^ FAIL" | grep -qv importGraph; then echo "TESTS FAILED, not pushing"; exit 4; fi
git push -q -u origin "$b" && echo "HEAD $(git rev-parse HEAD)"
