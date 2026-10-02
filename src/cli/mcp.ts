/**
 * `lousho mcp <agent.yaml|json> [--http --port N --host H]` - serve an agent
 * spec over MCP (LOU-Z3). stdio by default; stdout carries only the MCP
 * protocol there, so every message from this command goes to stderr.
 */
import * as path from 'node:path';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';
import { parseCommand, portValue, stringValue, usageError, type CommandSpec } from './args';
import { serveMcp, type ServeMcpHandle } from '../tools/mcp/server/serveMcp';

const USAGE = 'Usage: lousho mcp <agent.yaml|json> [--http --port N --host H]';

/** Parsed `lousho mcp` arguments. */
export interface McpCliArgs {
  configPath: string;
  http: boolean;
  port: number;
  host: string;
  /** `-h` / `--help` was given: print the usage, run nothing. */
  help?: boolean;
}

const SPEC: CommandSpec = {
  command: 'mcp',
  usage: USAGE,
  positionals: 1,
  options: { http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' } },
};

/** Parses `lousho mcp` arguments; throws `LOUSHO_CONFIG_INVALID` for a missing path, an unknown flag, a flag without its value or a bad port. */
export function parseMcpArgs(rest: string[]): McpCliArgs {
  const { values, positionals, help } = parseCommand(SPEC, rest);
  if (help) return { configPath: '', http: false, port: 3920, host: '127.0.0.1', help };
  if (positionals.length === 0) throw usageError(SPEC, 'an agent spec file path is required.');
  return { configPath: positionals[0], http: values.http === true, port: portValue(SPEC, values.port, 3920), host: stringValue(values.host) ?? '127.0.0.1' };
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
    const args = parseMcpArgs(rest);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const server = await startMcpServer(args);
    if (server.url) console.error(`lousho mcp: serving on ${server.url}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
