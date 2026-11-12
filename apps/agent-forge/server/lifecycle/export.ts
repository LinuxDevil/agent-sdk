/**
 * Agent export (L07) - `GET /agents/:id/export?format=yaml|bundle`.
 *
 * YAML is the working-copy spec verbatim; the bundle (`lousho.agent-bundle`)
 * adds what lives outside the YAML: labels, the prompt-registry text
 * `spec.promptRef` points at, and the eval datasets the spec gates on -
 * each fetched from the observe daemon, with a warning (never a failure)
 * when the daemon can't serve it. Secret values never appear: the spec
 * only ever holds `{ env }`/`{ secret }` references.
 */
import type { Express, Request, Response } from 'express';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from 'lousho';
import type { AgentBundle } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { daemonHeaders, observeTarget } from '../observeProxy';
import { specHash } from '../storage/specHash';
import { workspaceOf } from '../workspace/middleware';

/** What `buildBundle` needs of an agent: the spec and its labels. */
export interface ExportSource {
  spec: AgentSpecV2;
  labels: string[];
}

/** The daemon pieces a bundle pulls in, injectable for tests. */
export interface BundleDeps {
  fetch?: typeof fetch;
}

const DAEMON_TIMEOUT_MS = 8000;

/** `yaml.stringify(spec)` under a Studio-export header comment. */
// fallow-ignore-next-line unused-export -- contract surface (L07); L09b's export sheet consumes it
export function exportYaml(spec: AgentSpecV2): string {
  return `# Exported from Lousho Studio ${new Date().toISOString()}\n${stringifyYaml(spec, { lineWidth: 0 })}`;
}

/** `name@ref` split; `undefined` when the ref has no `@` (the schema already rejects those). */
function splitPromptRef(promptRef: string): { name: string; ref: string } | undefined {
  const at = promptRef.indexOf('@');
  if (at <= 0 || at === promptRef.length - 1) return undefined;
  return { name: promptRef.slice(0, at), ref: promptRef.slice(at + 1) };
}

/** A daemon `fetch` with the 8 s export deadline and the daemon's auth headers. */
function daemonFetch(deps: BundleDeps): typeof fetch {
  return deps.fetch ?? fetch;
}

async function daemonGet(deps: BundleDeps, path: string): Promise<unknown> {
  const res = await daemonFetch(deps)(`${observeTarget()}${path}`, {
    headers: daemonHeaders(false),
    signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  return res.json().catch(() => undefined);
}

/** The prompt-registry entry `spec.promptRef` names, or a warning when the daemon can't serve it. */
async function promptFor(spec: AgentSpecV2, deps: BundleDeps, warnings: string[]): Promise<AgentBundle['prompts']> {
  if (spec.promptRef === undefined) return [];
  const ref = splitPromptRef(spec.promptRef);
  if (ref === undefined) return [];
  const body = (await daemonGet(deps, `/api/v1/prompts/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.ref)}`)) as
    | { prompt?: { name?: unknown; version?: unknown; text?: unknown } }
    | undefined;
  const prompt = body?.prompt;
  if (typeof prompt?.name !== 'string' || typeof prompt.version !== 'number' || typeof prompt.text !== 'string') {
    warnings.push(
      `Prompt '${spec.promptRef}' could not be read from the observe daemon; the bundle uses the inline instructions only.`
    );
    return [];
  }
  return [{ name: prompt.name, version: prompt.version, content: prompt.text }];
}

/** `input`/`expected` as stored: parsed JSON when the daemon sent a JSON string, else the raw value. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** One bundle eval entry's `examples` list. */
type BundleExamples = NonNullable<AgentBundle['evals']>[number]['examples'];

/** The examples of one eval dataset, or `[]` (with a warning) when the daemon can't serve it. */
async function datasetExamples(name: string, deps: BundleDeps, warnings: string[]): Promise<BundleExamples> {
  const body = (await daemonGet(deps, `/api/v1/datasets/${encodeURIComponent(name)}?limit=200`)) as
    | { examples?: Array<{ input?: unknown; expected?: unknown }> }
    | undefined;
  if (!Array.isArray(body?.examples)) {
    warnings.push(`Dataset '${name}' could not be read; its examples are not in the bundle.`);
    return [];
  }
  return body.examples.map((example) => ({
    input: parseMaybeJson(example.input),
    expected: example.expected === undefined || example.expected === null ? null : parseMaybeJson(example.expected),
  }));
}

/** The distinct dataset names `spec.evals` gates on (the section is pending in spec v2; read defensively). */
function evalDatasetNames(spec: AgentSpecV2): string[] {
  const evals = (spec as { evals?: unknown }).evals;
  if (!Array.isArray(evals)) return [];
  const names = new Set<string>();
  for (const entry of evals) {
    const name = (entry as { dataset?: unknown } | null)?.dataset;
    if (typeof name === 'string' && name !== '') names.add(name);
  }
  return [...names];
}

/** The eval datasets section of the bundle; `undefined` when the spec gates on none. */
async function evalsFor(spec: AgentSpecV2, deps: BundleDeps, warnings: string[]): Promise<AgentBundle['evals']> {
  const names = evalDatasetNames(spec);
  if (names.length === 0) return undefined;
  const evals: NonNullable<AgentBundle['evals']> = [];
  for (const name of names) {
    const examples = await datasetExamples(name, deps, warnings);
    if (examples.length > 0) evals.push({ dataset: name, examples });
  }
  return evals.length > 0 ? evals : undefined;
}

/**
 * The `lousho.agent-bundle` for one agent: spec + labels + the daemon-side
 * prompt/eval pieces, with a `warnings` line per piece the daemon could
 * not serve. Daemon failures never fail the export.
 */
// fallow-ignore-next-line unused-export -- contract surface (L07); L09b's export sheet consumes it
export async function buildBundle(
  source: ExportSource,
  deps: BundleDeps = {}
): Promise<{ bundle: AgentBundle; warnings: string[] }> {
  const warnings: string[] = [];
  const [prompts, evals] = await Promise.all([promptFor(source.spec, deps, warnings), evalsFor(source.spec, deps, warnings)]);
  const bundle: AgentBundle = {
    kind: 'lousho.agent-bundle',
    version: 1,
    spec: source.spec,
    labels: source.labels,
    prompts,
    ...(evals !== undefined ? { evals } : {}),
    exportedAt: new Date().toISOString(),
  };
  return { bundle, warnings };
}

function attachment(res: Response, filename: string): void {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

/**
 * `GET /agents/:id/export?format=yaml|bundle`. Handlers read the workspace's
 * `AgentRepo` off `workspaceOf(req)` (the workspace seam); the observe
 * daemon is reached through the global `fetch`.
 */
export function registerExportRoutes(app: Express, deps: BundleDeps = {}): void {
  app.get(
    '/agents/:id/export',
    asyncRoute(async (req: Request, res: Response) => {
      const format = req.query.format;
      if (format !== 'yaml' && format !== 'bundle') {
        sendError(res, 400, "format must be 'yaml' or 'bundle'");
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      const spec = await ws.repo.readSpec(id);
      if (spec === undefined) {
        sendError(res, 404, `No agent '${id}'`);
        return;
      }
      // `adapt=1` (L09a): export the portability check's adapted
      // instructions instead of the working copy's - 409 until a check
      // for the current spec hash exists and produced an adaptation.
      let exportSpec = spec;
      if (req.query.adapt === '1') {
        const analysis = await ws.suggestions.findPortability(id, specHash(spec));
        if (analysis === undefined || analysis.adaptedInstructions === null) {
          sendError(res, 409, 'Run the portability check first.', 'LOUSHO_PORTABILITY_MISSING');
          return;
        }
        exportSpec = { ...spec, instructions: analysis.adaptedInstructions };
      }
      if (format === 'yaml') {
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        attachment(res, `${id}.yaml`);
        res.send(exportYaml(exportSpec));
        return;
      }
      const meta = await ws.repo.readMeta(id);
      const { bundle, warnings } = await buildBundle({ spec: exportSpec, labels: meta.labels }, deps);
      if (warnings.length > 0) {
        res.setHeader('X-Lousho-Export-Warnings', encodeURIComponent(JSON.stringify(warnings)));
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      attachment(res, `${id}.lousho-agent.json`);
      res.send(JSON.stringify(bundle, null, 2));
    })
  );
}
