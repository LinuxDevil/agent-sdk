/**
 * `loushy doctor <agent.yaml>`: validates the spec with the SDK's own loader
 * and checks what the spec references (provider, built-in tools, MCP servers).
 */
import type { AgentSpec, McpServerSpec } from '../spec/schema';
import { listProviders } from '../providers/providerSpec';
import { NO_SPEC_NEEDS, type SpecNeeds } from './doctorChecks';
import type { DoctorCheck, DoctorEnvironment } from './doctorTypes';

export interface SpecInspection {
  checks: DoctorCheck[];
  needs: SpecNeeds;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkProvider(spec: AgentSpec): DoctorCheck {
  const type = spec.provider.type.toLowerCase();
  const base = { id: 'spec.provider', title: 'Spec provider' };
  const known = listProviders().map((info) => info.name);
  if (type === 'mock' || known.includes(type)) {
    return { ...base, status: 'ok', finding: `'${spec.provider.type}' with model '${spec.provider.model}'` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `unknown provider type '${spec.provider.type}'`,
    fix: `Set provider.type to one of: ${known.join(', ')}.`,
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

function checkMcpServer(env: DoctorEnvironment, name: string, server: McpServerSpec): DoctorCheck {
  const base = { id: `spec.mcp.${name}`, title: `MCP server '${name}'` };
  if (!('command' in server)) {
    return { ...base, status: 'ok', finding: 'no command to resolve (remote or unspecified)' };
  }
  if (env.commandExists(server.command)) {
    return { ...base, status: 'ok', finding: `command '${server.command}' found` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `command '${server.command}' not found on PATH`,
    fix: `Install '${server.command}' or fix mcpServers.${name}.command in the spec.`,
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
  const mcp = Object.entries(spec.mcpServers ?? {}).map(([name, server]) =>
    checkMcpServer(env, name, server)
  );
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
