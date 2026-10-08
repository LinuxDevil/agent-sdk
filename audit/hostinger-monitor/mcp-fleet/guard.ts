/**
 * Read-only guard for the Hostinger MCP server.
 *
 * The server (hostinger-api-mcp >= 2026-10) exposes three meta-tools:
 *   search          readOnlyHint: true   - finds API operations
 *   execute         destructiveHint: true - runs ONE operation by name
 *   multi-execute   destructiveHint: true - runs up to 20 operations
 * so "read-only" cannot be expressed as a tool-name allowlist alone: the
 * dangerous part is the `operation` argument of `execute`. The guard is a
 * fail-closed allowlist over (tool name, operation name).
 *
 * Four independent layers (any one of them is enough to block a mutation):
 *   1. Tool filtering: `multi-execute` is never handed to the agent.
 *   2. `permissions` rules: deny execute unless the operation is allowlisted,
 *      allow the known tools, deny('*') for everything else (fail closed).
 *   3. A `preToolCall` hook running the same decision.
 *   4. The execute descriptor itself is wrapped: it re-checks the operation
 *      right before calling the MCP server (defence in depth, also protects
 *      direct programmatic calls).
 */
import { allow, deny, type AgentHook, type PermissionRule } from '@lousho/build-ai-agent';

/** GET-only Hostinger operations this monitor may run. Everything else is denied. */
export const READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  'vps_virtual-machines_list',
  'vps_virtual-machines_get',
  'vps_virtual-machines_metrics',
  'vps_actions_list',
  'vps_actions_get',
  'vps_backups_list',
  'vps_firewall_list',
  'vps_firewall_get',
  'vps_snapshots_get',
  'vps_data-centers_list',
  'vps_templates_list',
  'vps_templates_get',
  'vps_monarx_scan-metrics',
]);

export const SERVER = 'hostinger';
export const SEARCH_TOOL = `${SERVER}__search`;
export const EXECUTE_TOOL = `${SERVER}__execute`;
export const MULTI_TOOL = `${SERVER}__multi-execute`;

/** Local (non-MCP) tools the agent may call. */
export const LOCAL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['current_time']);

export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/** The single source of truth: may this tool call run? Fails closed. */
export function decide(toolName: string, args: unknown): GuardDecision {
  if (toolName === SEARCH_TOOL || LOCAL_READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
  if (toolName === EXECUTE_TOOL) {
    const op = args && typeof args === 'object' ? (args as Record<string, unknown>).operation : undefined;
    if (typeof op === 'string' && READ_ONLY_OPERATIONS.has(op)) return { allowed: true };
    return {
      allowed: false,
      reason: `Operation ${JSON.stringify(op)} is not on the read-only allowlist. This monitor may only run: ${[...READ_ONLY_OPERATIONS].join(', ')}.`,
    };
  }
  return { allowed: false, reason: `Tool '${toolName}' is not a known read-only tool (fail-closed guard).` };
}

/** Layer 2: permission rules (first match wins). */
export const guardPermissions: PermissionRule[] = [
  {
    tool: EXECUTE_TOOL,
    when: (args) => !decide(EXECUTE_TOOL, args).allowed,
    action: 'deny',
    reason: 'Only read-only Hostinger operations are allowed.',
  },
  allow([SEARCH_TOOL, EXECUTE_TOOL, ...LOCAL_READ_ONLY_TOOLS]),
  deny('*', 'Fail-closed: tool is not on the read-only allowlist.'),
];

/** Layer 3: the same decision as a preToolCall hook. */
export const guardHook: AgentHook = {
  name: 'read-only-guard',
  preToolCall(ctx) {
    const d = decide(ctx.toolName, ctx.args);
    return d.allowed ? undefined : { deny: d.reason };
  },
};

/**
 * Layers 1 + 4: keep only the read-only-capable MCP tools and wrap `execute`
 * so it re-checks the operation before anything reaches the server.
 */
export function guardMcpTools<T extends { execute?: (...a: any[]) => any }>(tools: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (name === SEARCH_TOOL) out[name] = tool;
    else if (name === EXECUTE_TOOL) {
      const inner = tool.execute!;
      out[name] = {
        ...tool,
        needsApproval: false, // the allowlist is the gate; the agent is unattended
        execute: (args: unknown, ...rest: unknown[]) => {
          const d = decide(EXECUTE_TOOL, args);
          if (!d.allowed) throw new Error(`read-only guard: ${d.reason}`);
          return inner(args, ...rest);
        },
      };
    }
    // anything else (multi-execute, future tools) is dropped: fail closed
  }
  return out;
}
