/**
 * `loushy doctor <agent.yaml>`: validates the spec with the SDK's own loader
 * and checks what the spec references (provider, built-in tools, MCP servers).
 */
import type { AgentSpec } from '../spec/schema';
import { PROVIDER_ENV_TABLE } from '../providers/providerEnv';
import { NO_SPEC_NEEDS, type SpecNeeds } from './doctorChecks';
import type { DoctorCheck, DoctorEnvironment } from './doctorTypes';

export interface SpecInspection {
  checks: DoctorCheck[];
  needs: SpecNeeds;
}

interface McpReference {
  name: string;
  command?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toReference(name: string, value: unknown): McpReference {
  const command = isRecord(value) && typeof value.command === 'string' ? value.command : undefined;
  return { name, command };
}

/** Reads `mcpServers` from a raw spec, as either a list or a name -> config map. */
function mcpReferences(raw: unknown): McpReference[] {
  const servers = isRecord(raw) ? raw.mcpServers : undefined;
  if (Array.isArray(servers)) {
    return servers.map((server, index) =>
      toReference(isRecord(server) && typeof server.name === 'string' ? server.name : `#${index + 1}`, server)
    );
  }
  if (isRecord(servers)) {
    return Object.entries(servers).map(([name, server]) => toReference(name, server));
  }
  return [];
}

function checkProvider(spec: AgentSpec): DoctorCheck {
  const type = spec.provider.type.toLowerCase();
  const base = { id: 'spec.provider', title: 'Spec provider' };
  if (type === 'mock' || PROVIDER_ENV_TABLE[type]) {
    return { ...base, status: 'ok', finding: `'${spec.provider.type}' with model '${spec.provider.model}'` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `unknown provider type '${spec.provider.type}'`,
    fix: `Set provider.type to one of: ${Object.keys(PROVIDER_ENV_TABLE).join(', ')}.`,
  };
}

function checkTool(env: DoctorEnvironment, name: string): { check: DoctorCheck; sandboxed: boolean } {
  const base = { id: `spec.tool.${name}`, title: `Spec tool '${name}'` };
  try {
    const tool = env.resolveTool(name);
    const sandboxed = tool.requiresSandbox === true;
    const finding = sandboxed ? 'built-in tool found (runs sandboxed)' : 'built-in tool found';
    return { check: { ...base, status: 'ok', finding }, sandboxed };
  } catch (error) {
    return {
      check: {
        ...base,
        status: 'fail',
        finding: message(error),
        fix: `Remove '${name}' from the spec's tools list or use a built-in tool name.`,
      },
      sandboxed: false,
    };
  }
}

function checkMcpServer(env: DoctorEnvironment, server: McpReference): DoctorCheck {
  const base = { id: `spec.mcp.${server.name}`, title: `MCP server '${server.name}'` };
  if (!server.command) {
    return { ...base, status: 'ok', finding: 'no command to resolve (remote or unspecified)' };
  }
  if (env.commandExists(server.command)) {
    return { ...base, status: 'ok', finding: `command '${server.command}' found` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `command '${server.command}' not found on PATH`,
    fix: `Install '${server.command}' or fix mcpServers.${server.name}.command in the spec.`,
  };
}

function loadFailure(path: string, error: unknown): SpecInspection {
  const check: DoctorCheck = {
    id: 'spec',
    status: 'fail',
    title: 'Agent spec',
    finding: message(error),
    fix: `Fix the field(s) named above in ${path}.`,
  };
  return { checks: [check], needs: NO_SPEC_NEEDS };
}

function safeRaw(env: DoctorEnvironment, path: string): unknown {
  try {
    return env.readRawSpec(path);
  } catch {
    return undefined;
  }
}

/** Loads the spec (if a path was given) and checks everything it references. */
export function inspectSpec(env: DoctorEnvironment): SpecInspection {
  const path = env.specPath;
  if (!path) return { checks: [], needs: NO_SPEC_NEEDS };

  let spec: AgentSpec;
  try {
    spec = env.loadSpec(path);
  } catch (error) {
    return loadFailure(path, error);
  }

  const tools = (spec.tools ?? []).map((name) => checkTool(env, name));
  const mcp = mcpReferences(safeRaw(env, path)).map((server) => checkMcpServer(env, server));
  const checks: DoctorCheck[] = [
    { id: 'spec', status: 'ok', title: 'Agent spec', finding: `'${spec.name}' is valid` },
    checkProvider(spec),
    ...tools.map((tool) => tool.check),
    ...mcp,
  ];
  const needs: SpecNeeds = {
    providers: new Set([spec.provider.type.toLowerCase()]),
    usesSandbox: tools.some((tool) => tool.sandboxed),
  };
  return { checks, needs };
}
