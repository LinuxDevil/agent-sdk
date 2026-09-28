#!/usr/bin/env node
'use strict';

const path = require('node:path');

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command !== 'dev') {
    console.error(`loushy: unknown command '${command || ''}'. Usage: loushy dev <config.yaml|config.json> [--port N]`);
    process.exitCode = 1;
    return;
  }

  const configPath = rest.find((arg) => !arg.startsWith('--'));
  const portFlag = rest.find((arg) => arg.startsWith('--port'));
  const port = portFlag ? Number(portFlag.split('=')[1] || rest[rest.indexOf(portFlag) + 1]) : 3737;

  if (!configPath) {
    console.error('loushy dev: a config file path is required. Usage: loushy dev <config.yaml|config.json> [--port N]');
    process.exitCode = 1;
    return;
  }

  const { startDevServer } = require(path.join(__dirname, '..', 'dist', 'cli', 'dev.js'));

  try {
    const handle = await startDevServer(path.resolve(configPath), port);
    console.log(`loushy dev: listening on http://localhost:${handle.port}`);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
