/**
 * `loushy mcp <agent.yaml|json> [--http --port N --host H]` - serve an agent
 * spec over MCP (LOU-Z3). stdio by default; stdout carries only the MCP
 * protocol there, so every message from this command goes to stderr.
 */
import * as path from 'node:path';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';
import { serveMcp, type ServeMcpHandle } from '../tools/mcp/server/serveMcp';

const USAGE = 'Usage: loushy mcp <agent.yaml|json> [--http --port N --host H]';

/** Parsed `loushy mcp` arguments. */
export interface McpCliArgs {
  configPath: string;
  http: boolean;
  port: number;
  host: string;
}

function readValue(rest: string[], name: string): string | undefined {
  const index = rest.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const inline = rest[index].split('=')[1];
  return inline ?? rest[index + 1];
}

/** Parses `loushy mcp` arguments; throws an Error that says how to fix a bad invocation. */
export function parseMcpArgs(rest: string[]): McpCliArgs {
  const valueIndexes = ['--port', '--host'].map((flag) => rest.indexOf(flag)).filter((i) => i >= 0);
  const configPath = rest.find(
    (arg, index) => !arg.startsWith('--') && !valueIndexes.some((i) => i + 1 === index)
  );
  if (!configPath) throw new Error(`loushy mcp: an agent spec file path is required. ${USAGE}`);

  const port = Number(readValue(rest, 'port') ?? 3920);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`loushy mcp: --port must be an integer between 0 and 65535. ${USAGE}`);
  }
  return {
    configPath,
    http: rest.includes('--http'),
    port,
    host: readValue(rest, 'host') ?? '127.0.0.1',
  };
}

/** Loads the spec and starts serving it. Resolves with the running server. */
export async function startMcpServer(args: McpCliArgs): Promise<ServeMcpHandle> {
  const spec = loadSpec(path.resolve(args.configPath));
  const agent = specToAgent(spec);
  return serveMcp({
    agent,
    name: spec.name,
    transport: args.http ? { type: 'http', port: args.port, host: args.host } : 'stdio',
    warn: (message) => console.error(message),
  });
}

/** CLI entry point. Resolves with the process exit code once the server is up. */
export async function runMcp(rest: string[]): Promise<number> {
  try {
    const server = await startMcpServer(parseMcpArgs(rest));
    if (server.url) console.error(`loushy mcp: serving on ${server.url}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
