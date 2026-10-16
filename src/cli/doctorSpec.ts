/**
 * `lousho doctor <agent.yaml>`: validates the spec with the SDK's own loader
 * and checks what the spec references (provider, built-in tools, MCP servers).
 * `lousho doctor <agent-dir>` loads the directory and checks its model's provider.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AgentSpec, McpServerSpec } from '../spec/schema';
import { summarizePolicy } from '../spec/policy';
import { unknownGuardrailMessage } from '../spec/guardrailOptions';
import { listProviders } from '../providers/providerSpec';
import { NO_SPEC_NEEDS, type SpecNeeds } from './doctorChecks';
import type { AgentDirSummary, DoctorCheck, DoctorEnvironment } from './doctorTypes';

export interface SpecInspection {
  checks: DoctorCheck[];
  needs: SpecNeeds;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkProvider(
  spec: Pick<AgentSpec, 'provider'>,
  title = 'Spec provider',
  fixPrefix = 'Set provider.type to one of'
): DoctorCheck {
  const type = spec.provider.type.toLowerCase();
  const base = { id: 'spec.provider', title };
  const known = listProviders().map((info) => info.name);
  if (type === 'mock' || known.includes(type)) {
    return { ...base, status: 'ok', finding: `'${spec.provider.type}' with model '${spec.provider.model}'` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `unknown provider type '${spec.provider.type}'`,
    fix: `${fixPrefix}: ${known.join(', ')}.`,
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

function checkPolicy(spec: AgentSpec): DoctorCheck[] {
  return summarizePolicy(spec.policy).map(({ block, text, unknownGuardrails }) => {
    const base = { id: `spec.policy.${block}`, title: `Spec policy ${block}` };
    if (unknownGuardrails.length === 0) return { ...base, status: 'ok' as const, finding: text };
    return {
      ...base,
      status: 'fail' as const,
      finding: unknownGuardrails.map(unknownGuardrailMessage).join('; '),
      fix: 'Use a built-in guardrail name in policy.guardrails.',
    };
  });
}

/** The fix line for a spec that failed to load: a missing file, a config of an agent directory, or bad fields. */
function loadFix(file: string, error: unknown): string {
  if ((error as { code?: unknown }).code === 'LOUSHO_SPEC_NOT_FOUND') {
    return `Check the path: ${file} does not exist (pass an agent.yaml / agent.json spec or an agent directory).`;
  }
  const dir = nodePath.dirname(file);
  if (/^agent\.(json|ya?ml)$/i.test(nodePath.basename(file)) && fs.existsSync(nodePath.join(dir, 'instructions.md'))) {
    return `${file} looks like the config of an agent directory, which is not an agent spec: run \`lousho doctor ${dir}\` instead.`;
  }
  return `Fix the field(s) named above in ${file}.`;
}

function loadFailure(file: string, error: unknown): SpecInspection {
  const check: DoctorCheck = {
    id: 'spec',
    status: 'fail',
    title: 'Agent spec',
    finding: message(error),
    fix: loadFix(file, error),
  };
  return { checks: [check], needs: NO_SPEC_NEEDS };
}

/** `lousho doctor <agent-dir>`: loads the directory (config, instructions, tools, ...) and checks its model's provider. */
async function inspectAgentDir(env: DoctorEnvironment, dir: string): Promise<SpecInspection> {
  const title = 'Agent directory';
  if (!env.loadAgentDir) {
    return { checks: [{ id: 'spec', status: 'warn', title, finding: 'agent directories cannot be inspected here', fix: 'Pass a spec file instead.' }], needs: NO_SPEC_NEEDS };
  }
  let summary: AgentDirSummary;
  try {
    summary = await env.loadAgentDir(dir);
  } catch (error) {
    const check: DoctorCheck = { id: 'spec', status: 'fail', title, finding: message(error), fix: `Fix the file named above in ${dir}.` };
    return { checks: [check], needs: NO_SPEC_NEEDS };
  }
  const tools = summary.tools.length === 0 ? 'no tools' : `${summary.tools.length} tool(s): ${summary.tools.join(', ')}`;
  const checks: DoctorCheck[] = [{ id: 'spec', status: 'ok', title, finding: `'${summary.name}' loads (${tools})` }];
  for (const [i, issue] of (summary.permissionIssues ?? []).entries()) {
    checks.push({
      id: `spec.permissions.${i}`,
      status: 'warn',
      title: 'Agent permissions',
      finding: issue,
      fix: "Fix the tool name in the rule: a rule that matches no tool never applies, so a 'deny' guards nothing.",
    });
  }
  const slash = summary.model?.indexOf('/') ?? -1;
  if (summary.model === undefined || slash <= 0) {
    return { checks, needs: NO_SPEC_NEEDS };
  }
  const type = summary.model.slice(0, slash);
  checks.push(checkProvider({ provider: { type, model: summary.model.slice(slash + 1) } }, 'Agent model', "Set the config's model to '<provider>/<model>' with a provider from"));
  return { checks, needs: { providers: new Set([type.toLowerCase()]), usesSandbox: false } };
}

/** Loads the spec or agent directory (if a path was given) and checks everything it references. */
export async function inspectSpec(env: DoctorEnvironment): Promise<SpecInspection> {
  const path = env.specPath;
  if (!path) return { checks: [], needs: NO_SPEC_NEEDS };
  if (env.isDirectory?.(path)) return inspectAgentDir(env, path);

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
    ...checkPolicy(spec),
  ];
  const needs: SpecNeeds = {
    providers: new Set([spec.provider.type.toLowerCase()]),
    usesSandbox: tools.some((tool) => tool.sandboxed),
  };
  return { checks, needs };
}
