#!/bin/bash
# usage: health.sh <label>   full verification list on the orchestrator worktree's current tree
S="/c/Users/recti/AppData/Local/Temp/claude/E--agent-sdk/0d06bab1-f0e9-415d-bab2-8bca2d62419d/scratchpad"
cd /e/agent-sdk/.claude/worktrees/loop-orch || exit 1
L="$S/health-$1"; mkdir -p "$L"; strip() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }
echo "tree $(git log --oneline -1)" > "$L/summary.txt"
npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "tsc exit $?" >> "$L/summary.txt"
npm run lint > "$L/lint.log" 2>&1; echo "lint exit $? $(grep -E 'problems' "$L/lint.log" | tail -1)" >> "$L/summary.txt"
npm run build > "$L/build.log" 2>&1; echo "build exit $?" >> "$L/summary.txt"
npm run build --workspace=packages/create-loushy-agent > "$L/build2.log" 2>&1; echo "build-cla exit $?" >> "$L/summary.txt"
npm run test:types > "$L/types.log" 2>&1; echo "test:types exit $?" >> "$L/summary.txt"
npm run docs:verify-snippets -- --skip-build > "$L/snip.log" 2>&1; echo "snippets exit $? $(grep -oE 'all [0-9]+ snippet' "$L/snip.log" | tail -1)" >> "$L/summary.txt"
npm run docs:llms:check > "$L/llms.log" 2>&1; echo "llms exit $?" >> "$L/summary.txt"
npm run test:coverage > "$L/cov.log" 2>&1; c=$?
if [ $c -ne 0 ]; then echo "coverage first run exit $c: $(strip "$L/cov.log" | grep -E '^ +FAIL ' | head -5)" >> "$L/summary.txt"; npm run test:coverage > "$L/cov.log" 2>&1; c=$?; fi
echo "coverage exit $c $(strip "$L/cov.log" | grep -E 'Tests ' | tail -1)" >> "$L/summary.txt"
strip "$L/cov.log" | grep -E '^ +FAIL ' | head -8 >> "$L/summary.txt"
npm run fallow > "$L/fallow.log" 2>&1; echo "fallow exit $? $(tail -1 "$L/fallow.log")" >> "$L/summary.txt"
for t in typecheck typecheck:server; do npm run $t --workspace apps/agent-forge > "$L/forge-$t.log" 2>&1; echo "forge $t exit $?" >> "$L/summary.txt"; done
npm run test --workspace apps/agent-forge -- --run > "$L/forge-test.log" 2>&1; echo "forge test exit $?" >> "$L/summary.txt"
npm run test:server --workspace apps/agent-forge > "$L/forge-test-server.log" 2>&1; echo "forge test:server exit $?" >> "$L/summary.txt"
git checkout -q -- . 2>/dev/null
cat "$L/summary.txt"
