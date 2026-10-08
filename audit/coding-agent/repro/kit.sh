#!/usr/bin/env bash
# Install the coding-kit into a fresh copy of fixture-repo/ the way a user would, then load it.
# Run from audit/:  bash coding-agent/repro/kit.sh [--model]
set -u
AUDIT="$(cd "$(dirname "$0")/../.." && pwd)"
# Must live under audit/ so the kit's `import '@lousho/build-ai-agent'` resolves (see FINDINGS).
DIR="$AUDIT/coding-agent/.runs/kit-$(date +%s)"
mkdir -p "$DIR" && cp -r "$AUDIT/coding-agent/fixture-repo/." "$DIR/"
echo "== default registry"; (cd "$AUDIT" && npx lousho add coding-kit --dir "$DIR" --yes --allow exec,fs-write </dev/null); echo "exit=$?"
REG="$(cd "$AUDIT/.." && pwd)/registry/dist/index.json"
echo "== local registry"; (cd "$AUDIT" && npx lousho add coding-kit --registry "$REG" --dir "$DIR" --yes --allow exec,fs-write </dev/null | tail -1); echo "exit=$?"
cd "$AUDIT" && npx tsx coding-agent/repro/kit.ts "$DIR" "$@"
