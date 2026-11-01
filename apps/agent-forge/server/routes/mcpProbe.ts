/**
 * `POST /catalog/mcp/probe` - connects the one MCP server the request
 * describes, lists its tools, disconnects and answers `{ ok, tools?, error? }`.
 *
 * Why: the canvas MCP node's Probe button and per-tool toggles (and the
 * Author's `probeMcpServer` tool) need to know what a server offers before
 * the spec is saved - `connectMcp()` already returns the tool list, so the
 * probe is a connect/list/close under one deadline
 * ({@link MCP_PROBE_TIMEOUT_MS}).
 *
 * Two response details differ from a raw connect:
 *  - Secret refs (`{ secret }` in `env`/`headers`/`oauth.clientSecret`,
 *    `{ env }` in `env`) are resolved through the Studio secrets store and
 *    the process env first; an unresolvable ref is `ok: false` naming the
 *    ref (never a value) rather than a half-configured spawn.
 *  - The spec's `tools` include/exclude filter and `optional` flag are
 *    dropped: the probe lists everything so the canvas can offer the
 *    per-tool toggles itself.
 *
 * Connection failures (refused, crashed, missing peer, OAuth sign-in
 * needed, timeout) are `ok: false` inside a 200 - only a malformed body or
 * an invalid spec is an HTTP error, and only POST is served (a stdio probe
 * spawns a command on this machine; the token gate is the guard).
 */
import type { Express } from 'express';
import { agentSpecV2Schema, resolveSecretRef, type McpServerSpec } from 'lousho';
import { connectMcp, type McpConnections } from 'lousho/mcp';
import type { McpProbeResponse, McpProbeTool, McpServerSpecV2 } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';

/** The whole probe's deadline - connect plus tool list inside one request. */
// fallow-ignore-next-line unused-export -- part of the route's contract; consumed by C07's Probe button and later timeouts tests
export const MCP_PROBE_TIMEOUT_MS = 10_000;

/** Deps for {@link registerMcpProbeRoute}. */
export interface McpProbeDeps {
  /** Value of a named secret from the Studio store; `undefined` when unset. */
  resolveSecret: (name: string) => string | undefined;
  /** Injected for tests; defaults to the SDK's `connectMcp`. */
  connect?: typeof connectMcp;
  /** Injected for tests; defaults to {@link MCP_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A `{ env }`/`{ secret }` ref - the SDK's `SecretRef` shape (not a root export). */
type ProbeSecretRef = { env: string } | { secret: string };

/** What `resolveSecretRef` reads from; the process env backs `{ env }` refs. */
interface ProbeHost {
  resolveSecret: (name: string) => string | undefined;
}

/** The `ok:false` marker for a ref the host cannot resolve. */
class ProbeRefMissing extends Error {}

/** `withTimeout` beat the wrapped promise. */
class ProbeTimeoutError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------
// Step 1: validate `body.server` by parsing the wrapper spec it sits in.
// ---------------------------------------------------------------------

/**
 * The `{ path, message }` issues of `server` inside a minimal wrapper spec
 * (`mcpServers.probe`), with the `mcpServers.probe` path prefix stripped so
 * they read as fields of the server entry itself; `undefined` when it parses.
 */
function probeSpecIssues(server: unknown): { path: string; message: string }[] | undefined {
  const parsed = agentSpecV2Schema.safeParse({
    version: 2,
    name: 'probe',
    model: 'mock/mock-1',
    instructions: 'probe',
    mcpServers: { probe: server },
  });
  if (parsed.success) return undefined;
  return parsed.error.issues.map((issue) => {
    const raw = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment));
    const path = raw[0] === 'mcpServers' && raw[1] === 'probe' ? raw.slice(2) : raw;
    return { path: path.join('.'), message: issue.message };
  });
}

// ---------------------------------------------------------------------
// Step 2: resolve SecretRefs (stdio `env`; HTTP `headers`, `oauth.clientSecret`).
// ---------------------------------------------------------------------

/** One `string | SecretRef` value through `resolveSecretRef`; unresolvable → {@link ProbeRefMissing}. */
async function resolveValue(value: string | ProbeSecretRef, host: ProbeHost, field: string): Promise<string> {
  if (typeof value === 'string') return value;
  try {
    return await resolveSecretRef(value, host, field);
  } catch {
    throw new ProbeRefMissing(
      'env' in value
        ? `Environment variable '${value.env}' is not set.`
        : `Secret '${value.secret}' is not set. Add it in Settings \u2192 Secrets.`
    );
  }
}

/** A `string | SecretRef` map resolved value-by-value (`undefined` stays undefined). */
async function resolveMap(
  map: Record<string, string | ProbeSecretRef> | undefined,
  host: ProbeHost,
  field: string
): Promise<Record<string, string> | undefined> {
  if (map === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    resolved[key] = await resolveValue(value, host, `${field}.${key}`);
  }
  return resolved;
}

/**
 * A shallow copy of `server` with every SecretRef resolved: `env` for a
 * stdio entry, `headers` and `oauth.clientSecret` for an HTTP one (the
 * wrapper parse already ran, so every object value is a well-formed ref).
 * Throws {@link ProbeRefMissing} for the first unresolvable ref.
 */
async function resolveRefs(server: McpServerSpecV2, host: ProbeHost): Promise<Record<string, unknown>> {
  const copy: Record<string, unknown> = { ...server };
  if ('command' in server) {
    const env = await resolveMap(server.env, host, 'mcpServers.probe.env');
    if (env !== undefined) copy['env'] = env;
    return copy;
  }
  const headers = await resolveMap(server.headers, host, 'mcpServers.probe.headers');
  if (headers !== undefined) copy['headers'] = headers;
  const oauth = server.oauth;
  const clientSecret = oauth?.clientSecret;
  if (oauth !== undefined && isObject(clientSecret)) {
    copy['oauth'] = { ...oauth, clientSecret: await resolveValue(clientSecret, host, 'mcpServers.probe.oauth.clientSecret') };
  }
  return copy;
}

// ---------------------------------------------------------------------
// Step 3: the probe lists everything - the filter belongs to the run, not the probe.
// ---------------------------------------------------------------------

/** `resolved` minus `tools` (include/exclude) and `optional`, as `connectMcp` takes it. */
function probeSpec(resolved: Record<string, unknown>): McpServerSpec {
  const spec = { ...resolved };
  delete spec['tools'];
  delete spec['optional'];
  return spec as unknown as McpServerSpec;
}

// ---------------------------------------------------------------------
// Step 4: connect under the deadline.
// ---------------------------------------------------------------------

/** Rejects with {@link ProbeTimeoutError} after `ms`; the wrapped promise keeps running (its caller closes it). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

// ---------------------------------------------------------------------
// Step 5: the tool list without the `probe__` namespace.
// ---------------------------------------------------------------------

/** `conn.tools` as probe rows: `probe__` prefix stripped, sorted by name. */
function listProbeTools(conn: McpConnections): McpProbeTool[] {
  return Object.entries(conn.tools)
    .map(([key, descriptor]) => ({ name: key.replace(/^probe__/, ''), description: descriptor.tool?.description ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Registers `POST /catalog/mcp/probe`. `deps.resolveSecret` is the secrets
 * store's `getSecret` (Studio-global state wired at createApp time, like
 * the other catalog routes); `connect`/`timeoutMs` exist for tests.
 */
export function registerMcpProbeRoute(app: Express, deps: McpProbeDeps): void {
  const connect = deps.connect ?? connectMcp;
  const timeoutMs = deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  app.post(
    '/catalog/mcp/probe',
    asyncRoute(async (req, res) => {
      const body = req.body as { server?: unknown } | undefined;
      if (!isObject(body?.server)) {
        sendError(res, 400, "Request body must include a 'server' MCP spec object", 'LOUSHO_BODY_INVALID');
        return;
      }
      const issues = probeSpecIssues(body.server);
      if (issues !== undefined) {
        const first = issues[0];
        sendError(
          res,
          400,
          `Invalid MCP server spec: ${first.path ? `${first.path}: ` : ''}${first.message}`,
          'LOUSHO_SPEC_INVALID',
          { issues }
        );
        return;
      }
      let resolved: Record<string, unknown>;
      try {
        resolved = await resolveRefs(body.server as McpServerSpecV2, deps);
      } catch (error) {
        if (!(error instanceof ProbeRefMissing)) throw error;
        res.json({ ok: false, error: error.message } satisfies McpProbeResponse);
        return;
      }
      // Connect, list, disconnect - all inside one request. A connect that
      // outlives the deadline is still closed once it finally lands.
      const pending = Promise.resolve().then(() => connect({ probe: probeSpec(resolved) }, { lazy: false, onError: 'throw' }));
      let conn: McpConnections;
      try {
        conn = await withTimeout(pending, timeoutMs);
      } catch (error) {
        const response: McpProbeResponse =
          error instanceof ProbeTimeoutError
            ? { ok: false, error: `The server did not answer within ${MCP_PROBE_TIMEOUT_MS / 1000} seconds.` }
            : { ok: false, error: error instanceof Error ? error.message : String(error) };
        if (error instanceof ProbeTimeoutError) void pending.then((open) => open.close()).catch(() => {});
        res.json(response);
        return;
      }
      try {
        res.json({ ok: true, tools: listProbeTools(conn) } satisfies McpProbeResponse);
      } finally {
        await conn.close().catch(() => {});
      }
    })
  );
}
