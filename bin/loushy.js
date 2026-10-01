#!/usr/bin/env node
'use strict';

const path = require('node:path');

const USAGE = [
  'Usage:',
  '  loushy init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force]',
  '  loushy dev <spec.yaml|spec.json|agent-dir|agent.ts> [--port N] [--host H]',
  '  loushy chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>]',
  '  loushy acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]',
  '  loushy build --target=<name> --agent=<path> [--out=<dir>]',
  '  loushy studio [--port N] [--host H] [--prod|--dev]',
  '  loushy mcp <agent.yaml|json> [--http --port N --host H]',
  '  loushy doctor [agent.yaml|json] [--json]',
  '  loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]',
].join('\n');

// Flag parsing for every command lives in src/cli/args.ts (node:util parseArgs, strict);
// each command's `run*` resolves with its exit code.
async function runDev(rest) {
  const { runDev: run } = require(path.join(__dirname, '..', 'dist', 'cli', 'dev.js'));
  process.exitCode = await run(rest);
}

// A terminal REPL for an agent (LOU-D33); see src/cli/chat.ts. Returns the exit code.
async function runChatCommand(rest) {
  const { runChat } = require(path.join(__dirname, '..', 'dist', 'cli', 'chat.js'));
  process.exitCode = await runChat(rest);
}

// Serves an agent over the Agent Client Protocol on stdio (LOU-Z6); see src/cli/acp.ts.
async function runAcpCommand(rest) {
  const { runAcp } = require(path.join(__dirname, '..', 'dist', 'cli', 'acp.js'));
  process.exitCode = await runAcp(rest);
}

async function runBuildCommand(rest) {
  const { runBuild } = require(path.join(__dirname, '..', 'dist', 'cli', 'build.js'));
  process.exitCode = await runBuild(rest);
}

// Default 'auto': prod (single built server+UI) when apps/agent-forge has
// been built (`npm run build:studio`), dev (Vite + tsx, two processes)
// otherwise. --prod/--dev force one or the other - see src/cli/studio.ts.
async function runStudioCommand(rest) {
  const { runStudio } = require(path.join(__dirname, '..', 'dist', 'cli', 'studio.js'));
  process.exitCode = await runStudio(rest);
}

// Scaffolds a new project (LOU-D3); see src/cli/init.ts. Also what `npm create loushy-agent` runs.
async function runInitCommand(rest) {
  const { runInit } = require(path.join(__dirname, '..', 'dist', 'cli', 'init.js'));
  process.exitCode = await runInit(rest);
}

async function runDoctorCommand(rest) {
  const { runDoctorCommand: run } = require(path.join(__dirname, '..', 'dist', 'cli', 'doctor.js'));
  process.exitCode = await run(rest);
}

// Serves an agent spec over MCP (stdio by default). The server keeps the
// process alive; see src/cli/mcp.ts. Only the exit code is set on failure.
async function runMcp(rest) {
  const { runMcp: start } = require(path.join(__dirname, '..', 'dist', 'cli', 'mcp.js'));
  process.exitCode = await start(rest);
}

// Runs eval files under the project's vitest and reports the results; the
// exit code is the verdict (see src/cli/eval.ts).
async function runEvalCommand(rest) {
  const { runEval } = require(path.join(__dirname, '..', 'dist', 'cli', 'eval.js'));
  process.exitCode = await runEval(rest);
}

const COMMANDS = new Map([
  ['init', runInitCommand],
  ['dev', runDev],
  ['chat', runChatCommand],
  ['acp', runAcpCommand],
  ['build', runBuildCommand],
  ['studio', runStudioCommand],
  ['mcp', runMcp],
  ['doctor', runDoctorCommand],
  ['eval', runEvalCommand],
]);

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  const run = COMMANDS.get(command);
  if (!run) {
    console.error(`loushy: unknown command '${command || ''}'.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  return run(rest);
}

main();
