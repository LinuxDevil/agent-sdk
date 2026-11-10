#!/usr/bin/env bash
set -euo pipefail

gh repo edit LinuxDevil/agent-sdk \
  --description "TypeScript AI agent SDK: offline CI evals, durable runs, human approvals, MCP. Runs in your own Node process." \
  --homepage "https://lousho.com" \
  --enable-discussions

gh repo edit LinuxDevil/agent-sdk \
  --add-topic agent-framework --add-topic durable-execution \
  --add-topic human-in-the-loop --add-topic llm-evals \
  --add-topic vercel-ai-sdk --add-topic opentelemetry \
  --add-topic self-hosted --add-topic tool-calling --add-topic ai-sdk
