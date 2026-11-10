import { z } from 'zod';
import { permissionListSchema, type PermissionRuleSpec } from '../../spec/v2/permissions';
import { secretRefSchema, type SecretRef } from '../../spec/v2/secrets';

/** How isolated shell and code execution must be, from least to most strict. */
export const SANDBOX_MODES = ['none', 'process', 'container'] as const;

/** One sandbox strictness level. */
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** The `shared/policies/policy.json` file: what the runtime enforces for every page and the main agent. */
export interface WorkspacePolicy {
  /** Ordered permission rules, in the agent-dir rule shape (`permissionRulesOf`); the first match decides. */
  permissions?: PermissionRuleSpec[];
  /** The workspace tool allowlist. */
  tools?: {
    /** Tool names; `*` or a trailing `*` (`publish_*`) covers several. */
    allow: string[];
  };
  /** Secrets pages may read, as env or secret-store refs. */
  secrets?: SecretRef[];
  /** Outbound network limits. */
  network?: {
    /** Host names; `*.example.com` covers every subdomain. */
    allowHosts: string[];
  };
  /** Tools that must wait for a human. */
  approvals?: {
    /** Tool names; `*` or a trailing `*` covers several. */
    require: string[];
  };
  /** Execution isolation. */
  sandbox?: {
    /** Strictness level: `none`, `process` or `container`. */
    mode: SandboxMode;
  };
}

/** The host's limit on any workspace policy; same shape, and a workspace can only narrow it. */
export type PolicyCeiling = WorkspacePolicy;

/** What the runtime enforces: every field present, an empty list meaning nothing is granted. */
export interface EffectivePolicy {
  /** Permission rules in evaluation order (see {@link narrowPolicy}). */
  permissions: PermissionRuleSpec[];
  /** Tools that may be used. */
  tools: {
    /** Allowed tool names. */
    allow: string[];
  };
  /** Secrets that may be read. */
  secrets: SecretRef[];
  /** Outbound network limits. */
  network: {
    /** Allowed hosts. */
    allowHosts: string[];
  };
  /** Tools that must wait for a human. */
  approvals: {
    /** Tool names needing approval. */
    require: string[];
  };
  /** Execution isolation. */
  sandbox: {
    /** Strictness level. */
    mode: SandboxMode;
  };
}

const TOOL_NAME = /^(?:\*|[A-Za-z0-9_-]{1,127}\*?)$/;
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOST_NAME = new RegExp(`^(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

const toolNameSchema = z.string().regex(TOOL_NAME, "must be a tool name, '*', or a name ending in '*'");
const hostSchema = z
  .string()
  .regex(HOST_NAME, 'must be a lower-case host name such as api.example.com or *.example.com (no scheme, port or path)');

export const workspacePolicyObjectSchema = z
  .object({
    permissions: permissionListSchema.optional(),
    tools: z.object({ allow: z.array(toolNameSchema) }).strict().optional(),
    secrets: z.array(secretRefSchema).optional(),
    network: z.object({ allowHosts: z.array(hostSchema) }).strict().optional(),
    approvals: z.object({ require: z.array(toolNameSchema) }).strict().optional(),
    sandbox: z.object({ mode: z.enum(SANDBOX_MODES) }).strict().optional(),
  })
  .strict();

/** Zod schema for `shared/policies/policy.json`; every object is strict, so an unknown key is an error. */
export const workspacePolicySchema: z.ZodType<WorkspacePolicy> = workspacePolicyObjectSchema;

type Covers = (outer: string, inner: string) => boolean;

const toolCovers: Covers = (outer, inner) => outer === inner || outer === '*' || (outer.endsWith('*') && inner.startsWith(outer.slice(0, -1)));

const hostCovers: Covers = (outer, inner) => outer === inner || (outer.startsWith('*.') && inner.endsWith(outer.slice(1)));

function intersect(ceiling: readonly string[], workspace: readonly string[], covers: Covers): string[] {
  const kept = [
    ...workspace.filter((entry) => ceiling.some((outer) => covers(outer, entry))),
    ...ceiling.filter((entry) => workspace.some((outer) => covers(outer, entry))),
  ];
  return [...new Set(kept)];
}

function narrowList(ceiling: readonly string[] | undefined, workspace: readonly string[] | undefined, covers: Covers): string[] {
  if (ceiling === undefined) return [];
  if (workspace === undefined) return [...ceiling];
  return intersect(ceiling, workspace, covers);
}

function secretKey(ref: SecretRef): string {
  return 'env' in ref ? `env:${ref.env}` : `secret:${ref.secret}`;
}

function narrowSecrets(ceiling: readonly SecretRef[] | undefined, workspace: readonly SecretRef[] | undefined): SecretRef[] {
  if (ceiling === undefined) return [];
  if (workspace === undefined) return [...ceiling];
  const allowed = new Set(ceiling.map(secretKey));
  const seen = new Set<string>();
  return workspace.filter((ref) => {
    const key = secretKey(ref);
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function narrowPermissions(ceiling: readonly PermissionRuleSpec[] = [], workspace: readonly PermissionRuleSpec[] = []): PermissionRuleSpec[] {
  return [
    ...workspace.filter((rule) => rule.action === 'deny'),
    ...ceiling,
    ...workspace.filter((rule) => rule.action === 'ask'),
  ];
}

function stricter(a: SandboxMode, b: SandboxMode): SandboxMode {
  return SANDBOX_MODES.indexOf(a) >= SANDBOX_MODES.indexOf(b) ? a : b;
}

/**
 * Combines the host's policy ceiling with a workspace policy into what the runtime enforces. Pure, and the result never grants anything the ceiling does not.
 *
 * Per field:
 * - `tools.allow` and `network.allowHosts`: the intersection, where `*` / `name*` (tools) and `*.host` (hosts) cover what they match. A workspace that omits the field inherits the ceiling's list; a ceiling that omits it grants nothing (fail closed).
 * - `secrets`: only refs that appear in the ceiling (same `env` or `secret` name). Omitted in the workspace, the ceiling's refs stay; omitted in the ceiling, none do.
 * - `permissions`: first match wins, so the result is the workspace's denies, then the ceiling's rules in their own order, then the workspace's asks. A workspace deny beats a ceiling allow; a ceiling deny still beats a workspace ask; workspace allow rules are dropped because they could only widen. A workspace ask applies only where no ceiling rule decided.
 * - `approvals.require`: the union of both lists, so it only grows.
 * - `sandbox.mode`: the stricter of the two (`none` < `process` < `container`); absent means `none`.
 */
export function narrowPolicy(ceiling: PolicyCeiling, workspace: WorkspacePolicy): EffectivePolicy {
  return structuredClone({
    permissions: narrowPermissions(ceiling.permissions, workspace.permissions),
    tools: { allow: narrowList(ceiling.tools?.allow, workspace.tools?.allow, toolCovers) },
    secrets: narrowSecrets(ceiling.secrets, workspace.secrets),
    network: { allowHosts: narrowList(ceiling.network?.allowHosts, workspace.network?.allowHosts, hostCovers) },
    approvals: { require: [...new Set([...(ceiling.approvals?.require ?? []), ...(workspace.approvals?.require ?? [])])] },
    sandbox: { mode: stricter(ceiling.sandbox?.mode ?? 'none', workspace.sandbox?.mode ?? 'none') },
  });
}
