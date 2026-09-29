#!/usr/bin/env node
'use strict';

const path = require('node:path');

const USAGE = [
  'Usage:',
  '  loushy dev <config.yaml|config.json> [--port N] [--host H]',
  '  loushy build --target=<name> --agent=<path> [--out=<dir>]',
  '  loushy studio [--port N] [--host H]',
].join('\n');

async function runDev(rest) {
  const configPath = rest.find((arg) => !arg.startsWith('--'));
  const portFlag = rest.find((arg) => arg.startsWith('--port'));
  const port = portFlag ? Number(portFlag.split('=')[1] || rest[rest.indexOf(portFlag) + 1]) : 3737;
  const hostFlag = rest.find((arg) => arg.startsWith('--host'));
  const host = hostFlag ? (hostFlag.split('=')[1] || rest[rest.indexOf(hostFlag) + 1]) : '127.0.0.1';

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
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runBuildCommand(rest) {
  // Flag parsing (--target/--agent/--out) lives in src/cli/build.ts's
  // parseBuildArgs(), which follows the same `--flag=value` / `--flag value`
  // convention as runDev() above.
  const { runBuild } = require(path.join(__dirname, '..', 'dist', 'cli', 'build.js'));
  process.exitCode = await runBuild(rest);
}

async function runStudio(rest) {
  const portFlag = rest.find((arg) => arg.startsWith('--port'));
  const apiPort = portFlag ? Number(portFlag.split('=')[1] || rest[rest.indexOf(portFlag) + 1]) : 4750;
  const hostFlag = rest.find((arg) => arg.startsWith('--host'));
  const apiHost = hostFlag ? (hostFlag.split('=')[1] || rest[rest.indexOf(hostFlag) + 1]) : '127.0.0.1';

  const { startStudio } = require(path.join(__dirname, '..', 'dist', 'cli', 'studio.js'));

  try {
    startStudio({ repoRoot: process.cwd(), apiPort, apiHost });
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'dev':
      return runDev(rest);
    case 'build':
      return runBuildCommand(rest);
    case 'studio':
      return runStudio(rest);
    default:
      console.error(`loushy: unknown command '${command || ''}'.\n${USAGE}`);
      process.exitCode = 1;
  }
}

main();
