/**
 * subagentFromSpec(): turns one validated `spec.subagents` entry into a value
 * of `createAgent({ subagents })` - a SimpleAgent for `{ inline }` and
 * `{ ref }` entries (built through the host's `buildAgent`, which S16's
 * compiler supplies as itself), a RemoteSubagent for `{ remote }` through
 * remoteAgent(). A `{ remote }` auth ref resolves once eagerly so a missing
 * secret fails the build, then again per task so a rotated token is picked
 * up. Node-side: only the compiler imports this; the entry schema lives in
 * ../subagents.ts.
 */
import type { SimpleAgent } from '../../../createAgent';
import { ConfigurationError } from '../../../execution/errors';
import { remoteAgent } from '../../../subagents/remoteAgent';
import type { RemoteSubagent } from '../../../subagents/types';
import type { SecretRef } from '../secrets';
import type { AgentSpecV2, InlineAgentSpec, SubagentSpec } from '../types';
import { resolveSecretRef, type SecretHost } from './secrets';

/** What {@link subagentFromSpec} needs; the S16 compiler passes itself as `buildAgent`. */
export interface SubagentHost extends SecretHost {
  /** Builds a sub-agent from an inline (or loaded) spec. `path` is the canvas path, e.g. 'sub:research'. */
  buildAgent(spec: InlineAgentSpec, name: string, path: string): Promise<SimpleAgent>;
  /** Loads a `{ ref }` target as an agent spec. Absent → refs are unsupported on this host. */
  loadAgentRef?(ref: string): Promise<AgentSpecV2>;
}

/** `{ ref }`: the host loads the spec, the top-level-only keys drop off, then it builds like an inline one. */
async function refSubagent(name: string, spec: { ref: string }, host: SubagentHost): Promise<SimpleAgent> {
  const field = `subagents.${name}.ref`;
  if (host.loadAgentRef === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' needs a host that can load agent files; this host cannot.`,
      field,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const { version: _version, triggers: _triggers, flow: _flow, evals: _evals, ...rest } = await host.loadAgentRef(spec.ref);
  if (typeof rest.description !== 'string' || rest.description.trim() === '') {
    throw new ConfigurationError(
      `AgentSpec v2: sub-agent '${name}' (${spec.ref}) has no description; the lead model needs one to pick it.`,
      field,
      'LOUSHO_SPEC_INVALID'
    );
  }
  return host.buildAgent({ ...rest, description: rest.description }, name, `sub:${name}`);
}

/** `{ remote }`: a remoteAgent() of the entry's URL; `auth` is resolved eagerly once, then lazily per task. */
async function remoteSubagent(
  name: string,
  spec: { remote: { url: string; auth?: SecretRef; description: string } },
  host: SubagentHost
): Promise<RemoteSubagent> {
  const { url, auth, description } = spec.remote;
  const field = `subagents.${name}.remote.auth`;
  if (auth !== undefined) await resolveSecretRef(auth, host, field);
  return remoteAgent({
    url,
    name,
    description,
    ...(auth !== undefined && { auth: () => resolveSecretRef(auth, host, field) }),
  });
}

/** One builder per SubagentSpec form, dispatched on the form key the entry carries. */
const FORM_BUILDERS = {
  inline: (name: string, spec: { inline: InlineAgentSpec }, host: SubagentHost): Promise<SimpleAgent> =>
    host.buildAgent(spec.inline, name, `sub:${name}`),
  ref: refSubagent,
  remote: remoteSubagent,
};

/**
 * The `createAgent({ subagents })` value `spec.subagents[name]` stands for.
 * The entry is taken as already validated (exactly one of `ref`, `inline`,
 * `remote`); the `{ ref }` and `{ remote }` forms fail with ConfigurationError
 * naming the spec field when the host cannot serve them.
 */
export async function subagentFromSpec(
  name: string,
  spec: SubagentSpec,
  host: SubagentHost
): Promise<SimpleAgent | RemoteSubagent> {
  if ('ref' in spec) return FORM_BUILDERS.ref(name, spec, host);
  if ('inline' in spec) return FORM_BUILDERS.inline(name, spec, host);
  return FORM_BUILDERS.remote(name, spec, host);
}
