#!/usr/bin/env node
'use strict';

const path = require('node:path');

const USAGE = [
  'Usage:',
  '  loushy init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force]',
  '  loushy dev <config.yaml|config.json> [--port N] [--host H]',
  '  loushy build --target=<name> --agent=<path> [--out=<dir>]',
  '  loushy studio [--port N] [--host H] [--prod|--dev]',
  '  loushy mcp <agent.yaml|json> [--http --port N --host H]',
  '  loushy doctor [agent.yaml|json] [--json]',
  '  loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]',
].join('\n');

/**
 * Reads `--<name>=value` / `--<name> value` from `rest`. Returns `fallback`
 * when the flag is absent, otherwise `convert` applied to the (possibly
 * undefined) value.
 */
function readFlag(rest, name, fallback, convert = (value) => value) {
  const flag = rest.find((arg) => arg.startsWith(`--${name}`));
  if (!flag) return fallback;
  return convert(flag.split('=')[1] || rest[rest.indexOf(flag) + 1]);
}

function reportError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
}

async function runDev(rest) {
  const configPath = rest.find((arg) => !arg.startsWith('--'));
  const port = readFlag(rest, 'port', 3737, Number);
  const host = readFlag(rest, 'host', '127.0.0.1');

  if (!configPath) {
    console.error('loushy dev: a config file path is required. Usage: loushy dev <config.yaml|config.json> [--port N] [--host H]');
    process.exitCode = 1;
    return;
  }

  const { startDevServer } = require(path.join(__dirname, '..', 'dist', 'cli', 'dev.js'));

  try {
    const handle = await startDevServer(path.resolve(configPath), port, host);
    console.log(`loushy dev: listening on http://${host}:${handle.port}`);
  } catch (error) {
    reportError(error);
  }
}

async function runBuildCommand(rest) {
  // Flag parsing (--target/--agent/--out) lives in src/cli/build.ts's
  // parseBuildArgs(), which follows the same `--flag=value` / `--flag value`
  // convention as runDev() above.
  const { runBuild } = require(path.join(__dirname, '..', 'dist', 'cli', 'build.js'));
  process.exitCode = await runBuild(rest);
}

// Default 'auto': prod (single built server+UI) when apps/agent-forge has
// been built (`npm run build:studio`), dev (Vite + tsx, two processes)
// otherwise. --prod/--dev force one or the other - see src/cli/studio.ts.
function studioMode(rest) {
  if (rest.includes('--prod')) return 'prod';
  return rest.includes('--dev') ? 'dev' : 'auto';
}

async function runStudio(rest) {
  const apiPort = readFlag(rest, 'port', 4750, Number);
  const apiHost = readFlag(rest, 'host', '127.0.0.1');
  const mode = studioMode(rest);

  const { startStudio } = require(path.join(__dirname, '..', 'dist', 'cli', 'studio.js'));

  try {
    startStudio({ repoRoot: process.cwd(), apiPort, apiHost, mode });
  } catch (error) {
    reportError(error);
  }
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
  ['build', runBuildCommand],
  ['studio', runStudio],
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
