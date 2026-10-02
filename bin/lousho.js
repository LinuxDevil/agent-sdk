#!/usr/bin/env node
'use strict';

const path = require('node:path');

const USAGE = [
  'Usage:',
  '  lousho init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force]',
  '  lousho dev <spec.yaml|spec.json|agent-dir|agent.ts> [--port N] [--host H]',
  '  lousho chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>]',
  '  lousho acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]',
  '  lousho add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--allow <list>] [--overwrite] [--dry-run] | --list',
  '  lousho build --target=<name> --agent=<path> [--out=<dir>]',
  '  lousho studio [--port N] [--host H] [--prod|--dev]',
  '  lousho mcp <agent.yaml|json> [--http --port N --host H]',
  '  lousho doctor [agent.yaml|json] [--json]',
  '  lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]',
  '  lousho traces [traceId|prefix] [--dir D] [--limit N] [--json] [--content]',
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

// Installs a tool, skill, channel, schedule or memory slot from a JSON registry (LOU-D50); see src/cli/add.ts.
async function runAddCommand(rest) {
  const { runAdd } = require(path.join(__dirname, '..', 'dist', 'cli', 'add.js'));
  process.exitCode = await runAdd(rest);
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

// Scaffolds a new project (LOU-D3); see src/cli/init.ts. Also what `npm create lousho-agent` runs.
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

// Lists the runs fileTraceExporter() saved, or prints one as a span tree (M5a); see src/cli/traces.ts.
async function runTracesCommand(rest) {
  const { runTraces } = require(path.join(__dirname, '..', 'dist', 'cli', 'traces.js'));
  process.exitCode = await runTraces(rest);
}

function runHelp() {
  console.log(USAGE);
}

const COMMANDS = new Map([
  ['init', runInitCommand],
  ['dev', runDev],
  ['chat', runChatCommand],
  ['acp', runAcpCommand],
  ['add', runAddCommand],
  ['build', runBuildCommand],
  ['studio', runStudioCommand],
  ['mcp', runMcp],
  ['doctor', runDoctorCommand],
  ['eval', runEvalCommand],
  ['traces', runTracesCommand],
  // `lousho --help` / `-h` / `help` print the usage and succeed (a bare `lousho` is still an error).
  ['--help', runHelp],
  ['-h', runHelp],
  ['help', runHelp],
]);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS.get(command);
  if (!run) {
    console.error(`lousho: unknown command '${command || ''}'.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  return run(rest);
}

main();
