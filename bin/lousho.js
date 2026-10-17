#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { pathToFileURL } = require('node:url');

const USAGE = [
  'Usage: lousho <command> [options]      (lousho <command> --help for its flags)',
  '',
  'Commands:',
  '  lousho init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force] [--sdk-path <dir|tgz>]',
  '      Scaffold a new agent project (what `npm create lousho-agent` runs).',
  '  lousho dev <spec.yaml|spec.json|agent-dir|agent.ts> [--port N] [--host H] [--allowed-hosts a,b] [--no-schedules] [--traces[=dir]]',
  '      Serve an agent with a local chat UI and HTTP API; reloads on file changes.',
  '  lousho chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>] [--traces[=dir]]',
  '      Chat with an agent in the terminal.',
  '  lousho acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]',
  '      Serve an agent over the Agent Client Protocol on stdio (for editors).',
  '  lousho add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--allow <list>] [--overwrite] [--dry-run] | --list',
  '      Install a tool, skill, channel, schedule or kit from a registry into an agent directory.',
  '  lousho build <agent-dir|spec|agent.ts> --target=<node-server|cloudflare-worker|docker> [--out=<dir>]   (or --agent=<path>)',
  '      Bundle an agent for deployment (default output: .lousho/build/<target>).',
  '  lousho studio [--port N] [--host H] [--prod|--dev]',
  '      Open Agent Forge, the visual agent builder.',
  '  lousho mcp <agent.yaml|json|agent-dir|agent.ts> [--http --port N --host H]',
  '      Serve an agent as an MCP server (stdio by default).',
  '  lousho doctor [agent.yaml|json|agent-dir|agent.ts] [--json] [--ping]',
  '      Check Node, peer dependencies, API keys and (optionally) an agent spec, directory or module.',
  '  lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]] [--url <base> [--token <bearer>]] [--config vitest.config.ts] [--timeout <ms>]',
  '      Run *.eval.ts files under your vitest and report the results.',
  '  lousho traces [traceId|prefix] [--dir D] [--limit N] [--json] [--content]',
  '      List saved traces (fileTraceExporter) or print one as a span tree.',
  '  lousho --version',
  '      Print the package version.',
  '',
  'The agent commands (dev, chat, acp, mcp, doctor, eval, build) load ./.env when it exists; variables already set win.',
  'Exit codes: 0 success, 1 failure, 2 usage error (unknown command, bad flag or argument).',
].join('\n');

/**
 * Loads a command module from the ESM build (dist/cli/*.mjs). A user's tool
 * file (`tools/*.ts`) is an ES module, so its `import '@lousho/build-ai-agent'`
 * resolves to the ESM build: loading the CLI from the same build means the
 * agent directory and the tools it loads share one copy of the SDK.
 */
function load(name) {
  return import(pathToFileURL(path.join(__dirname, '..', 'dist', 'cli', `${name}.mjs`)).href);
}

/** Each command: the dist/cli module, its exported `run*` (resolves with the exit code), and whether it loads ./.env. */
const COMMANDS = new Map([
  // Scaffolds a new project; see src/cli/init.ts. Also what `npm create lousho-agent` runs.
  ['init', { module: 'init', run: 'runInit' }],
  ['dev', { module: 'dev', run: 'runDev', env: true }],
  // A terminal REPL for an agent; see src/cli/chat.ts.
  ['chat', { module: 'chat', run: 'runChat', env: true }],
  // Serves an agent over the Agent Client Protocol on stdio; see src/cli/acp.ts.
  ['acp', { module: 'acp', run: 'runAcp', env: true }],
  // Installs a tool, skill, channel, schedule or memory slot from a JSON registry; see src/cli/add.ts.
  ['add', { module: 'add', run: 'runAdd' }],
  ['build', { module: 'build', run: 'runBuild', env: true }],
  // Default 'auto': prod (single built server+UI) when apps/agent-forge has
  // been built (`npm run build:studio`), dev (Vite + tsx, two processes)
  // otherwise. --prod/--dev force one or the other - see src/cli/studio.ts.
  ['studio', { module: 'studio', run: 'runStudio' }],
  // Serves an agent spec over MCP (stdio by default). The server keeps the
  // process alive; see src/cli/mcp.ts.
  ['mcp', { module: 'mcp', run: 'runMcp', env: true }],
  ['doctor', { module: 'doctor', run: 'runDoctorCommand', env: true }],
  // Runs eval files under the project's vitest; the exit code is the verdict (see src/cli/eval.ts).
  ['eval', { module: 'eval', run: 'runEval', env: true }],
  // Lists the runs fileTraceExporter() saved, or prints one as a span tree; see src/cli/traces.ts.
  ['traces', { module: 'traces', run: 'runTraces' }],
]);

const BYTE_ORDER_MARK = 0xfeff;

/**
 * Loads ./.env into process.env (variables already set are kept), like `node --env-file-if-exists=.env`.
 * Read by hand, not with process.loadEnvFile(): that keeps a leading byte order mark (PowerShell 5.1's
 * `Set-Content -Encoding utf8` writes one), so the first key would be named with a U+FEFF prefix and
 * silently missing.
 */
function loadDotEnv() {
  const text = readDotEnv();
  if (text === undefined) return;
  for (const [name, value] of Object.entries(parseEnv(withoutByteOrderMark(text)))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/** ./.env's text, or undefined when there is none (any other read error is reported). */
function readDotEnv() {
  try {
    return fs.readFileSync(path.resolve('.env'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`lousho: could not load .env: ${error.message}`);
    return undefined;
  }
}

function withoutByteOrderMark(text) {
  return text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
}

// `lousho --version` / `-v` / `version` print the package version (kept in sync with VERSION by scripts/sync-version.mjs).
function runVersion(rest) {
  if (rest.length > 0) return usageError(`'version' takes no arguments; got '${rest[0]}'.`);
  console.log(require(path.join(__dirname, '..', 'package.json')).version);
}

// `lousho help <command>` is `lousho <command> --help`.
function runHelp(rest) {
  if (rest.length === 0) return console.log(USAGE);
  const entry = COMMANDS.get(rest[0]);
  if (!entry) return unknownCommand(rest[0]);
  return runCommand(entry, ['--help']);
}

// `lousho --help` / `-h` / `help` print the usage and succeed (a bare `lousho` is still an error).
const BUILTINS = new Map([
  ['--help', runHelp],
  ['-h', runHelp],
  ['help', runHelp],
  ['--version', runVersion],
  ['-v', runVersion],
  ['version', runVersion],
]);

/** The exit code for a usage error, as every command returns it (src/cli/args.ts USAGE_EXIT_CODE). */
const USAGE_EXIT_CODE = 2;

function usageError(message) {
  console.error(`lousho: ${message}\n${USAGE}`);
  process.exitCode = USAGE_EXIT_CODE;
}

function unknownCommand(command) {
  usageError(`unknown command '${command ?? ''}'.`);
}

/**
 * Drops Node's MODULE_TYPELESS_PACKAGE_JSON warning: the CLI imports a
 * `tools/*.ts` file as an ES module even in a project whose package.json has
 * no "type": "module", and Node would print that warning on every load and
 * reload. Every other warning is emitted as usual.
 */
function quietTypelessPackageWarning() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const options = rest[0];
    const code = typeof options === 'object' && options !== null ? options.code : rest[1];
    if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
    return emitWarning.call(process, warning, ...rest);
  };
}

async function runCommand(entry, rest) {
  if (entry.env) loadDotEnv();
  quietTypelessPackageWarning();
  const mod = await load(entry.module);
  process.exitCode = await mod[entry.run](rest);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const builtin = BUILTINS.get(command);
  if (builtin) return builtin(rest);
  const entry = COMMANDS.get(command);
  return entry ? runCommand(entry, rest) : unknownCommand(command);
}

main().catch((error) => {
  // A command reports its own errors; this is a failure to load one (a broken install, a missing build).
  console.error(`lousho: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
