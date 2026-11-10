import { z } from 'zod';
import { isHostPattern, matchesHost } from '../../security/hostPattern';
import { permissionListSchema, type PermissionRuleSpec } from '../../spec/v2/permissions';
import { secretRefSchema, type SecretRef } from '../../spec/v2/secrets';

/** The `shared/policies/policy.json` file: what the runtime enforces for every page and the main agent. */
export interface WorkspacePolicy {
  /** Ordered permission rules in the spec v2 `PermissionRuleSpec` shape (compiled by `permissionsFromSpec`; each rule needs an `id`); the first match decides. */
  permissions: PermissionRuleSpec[];
  /** The workspace tool allowlist. */
  tools: {
    /** Tool names; `*` or a trailing `*` (`publish_*`) covers several. */
    allow: string[];
  };
  /** Secrets pages may read, as env or secret-store refs. */
  secrets: SecretRef[];
  /** Outbound network limits. */
  network?: {
    /** Lower-case host names or `*.example.com` wildcards; hosts must be listed, there is no "any host" form. */
    allowHosts: string[];
  };
  /** Tools that must wait for a human. */
  approvals?: {
    /** Tool names; `*` or a trailing `*` covers several. */
    require: string[];
  };
  /** Execution isolation. */
  sandbox?: {
    /** Whether code and shell execution must be sandboxed. */
    required: boolean;
  };
}

/** The host's limit on any workspace policy; same shape, and a workspace can only narrow it. */
export type PolicyCeiling = WorkspacePolicy;

/** What the runtime enforces: every field present, an empty list meaning nothing is granted. */
export interface EffectivePolicy {
  /** The runtime evaluates each list first-match and applies the stricter decision (deny > ask > allow > none). */
  permissions: {
    /** The ceiling's rules, unchanged. */
    ceiling: PermissionRuleSpec[];
    /** The workspace's rules with its `allow` rules dropped. */
    workspace: PermissionRuleSpec[];
  };
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
    /** Whether execution must be sandboxed. */
    required: boolean;
  };
}

const TOOL_NAME = /^(?:\*|[A-Za-z0-9_-]{1,127}\*?)$/;

const toolNameSchema = z.string().regex(TOOL_NAME, "must be a tool name, '*', or a name ending in '*'");
const hostSchema = z
  .string()
  .refine(
    (host) => isHostPattern(host) && host === host.toLowerCase(),
    'must be a lower-case host name such as api.example.com or *.example.com (no scheme, port or path)'
  );

export const workspacePolicyObjectSchema = z
  .object({
    permissions: permissionListSchema,
    tools: z.object({ allow: z.array(toolNameSchema) }).strict(),
    secrets: z.array(secretRefSchema),
    network: z.object({ allowHosts: z.array(hostSchema) }).strict().optional(),
    approvals: z.object({ require: z.array(toolNameSchema) }).strict().optional(),
    sandbox: z.object({ required: z.boolean() }).strict().optional(),
  })
  .strict();

/** Zod schema for `shared/policies/policy.json`; every object is strict, so an unknown key is an error. */
export const workspacePolicySchema: z.ZodType<WorkspacePolicy> = workspacePolicyObjectSchema;

type Covers = (outer: string, inner: string) => boolean;

const toolCovers: Covers = (outer, inner) => outer === inner || outer === '*' || (outer.endsWith('*') && inner.startsWith(outer.slice(0, -1)));

const hostCovers: Covers = (outer, inner) => matchesHost([outer], inner);

function intersect(ceiling: readonly string[], workspace: readonly string[], covers: Covers): string[] {
  const kept = [
    ...workspace.filter((entry) => ceiling.some((outer) => covers(outer, entry))),
    ...ceiling.filter((entry) => workspace.some((outer) => covers(outer, entry))),
  ];
  return [...new Set(kept)];
}

function narrowHosts(ceiling: readonly string[] | undefined, workspace: readonly string[] | undefined): string[] {
  if (ceiling === undefined) return [];
  if (workspace === undefined) return [...ceiling];
  return intersect(ceiling, workspace, hostCovers);
}

function secretKey(ref: SecretRef): string {
  return 'env' in ref ? `env:${ref.env}` : `secret:${ref.secret}`;
}

function narrowSecrets(ceiling: readonly SecretRef[], workspace: readonly SecretRef[]): SecretRef[] {
  const allowed = new Set(ceiling.map(secretKey));
  const seen = new Set<string>();
  return workspace.filter((ref) => {
    const key = secretKey(ref);
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Narrows a host ceiling with a workspace policy (both validated, invalid input throws); the per-field rules are in the P0.6 PR. */
export function narrowPolicy(ceiling: PolicyCeiling, workspace: WorkspacePolicy): EffectivePolicy {
  const host = workspacePolicySchema.parse(ceiling);
  const own = workspacePolicySchema.parse(workspace);
  return {
    permissions: { ceiling: host.permissions, workspace: own.permissions.filter((rule) => rule.action !== 'allow') },
    tools: { allow: intersect(host.tools.allow, own.tools.allow, toolCovers) },
    secrets: narrowSecrets(host.secrets, own.secrets),
    network: { allowHosts: narrowHosts(host.network?.allowHosts, own.network?.allowHosts) },
    approvals: { require: [...new Set([...(host.approvals?.require ?? []), ...(own.approvals?.require ?? [])])] },
    sandbox: { required: (host.sandbox?.required ?? false) || (own.sandbox?.required ?? false) },
  };
}
