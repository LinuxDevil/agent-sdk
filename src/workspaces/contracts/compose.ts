import { createHash } from 'node:crypto';
import { ValidationError } from '../../execution/errors';
import type { HarnessLayer } from './baseHarness';
import type { Harness } from './harness';

/** The harness a page runs with: every layer composed in order, with where each value came from. */
export interface EffectiveHarness {
  /** Layer sources in the order they were applied: the base harness, then profiles depth first, then the page. */
  sources: string[];
  /** Every layer's instruction prose in order, each under `### From <source>`. */
  instructions: string;
  /** Deep-merged audience; later layers win per key and arrays replace. */
  audience?: Harness['audience'];
  /** Deep-merged platform; later layers win per key and arrays replace. */
  platform?: Harness['platform'];
  /** The latest input schema, or an `allOf` when a later layer sets `"merge": "allOf"`. */
  inputs?: Harness['inputs'];
  /** The latest output schema (or an `allOf`), and artifacts unioned by name with later layers winning. */
  outputs?: Harness['outputs'];
  /** Required capabilities, unioned across layers. */
  capabilities?: Harness['capabilities'];
  /** Constraints unioned by id; a later layer replaces an earlier constraint with the same id. */
  constraints?: Harness['constraints'];
  /** Criteria unioned by id with later layers winning, and the latest threshold. */
  evaluation?: Harness['evaluation'];
  /** The minimum of each limit, so a later layer can only tighten, and the latest model hints. */
  runtime?: Harness['runtime'];
  /** Context resources as an ordered union. */
  context?: Harness['context'];
  /** For each field path, the sources its value came from, in applied order. */
  provenance: Record<string, string[]>;
  /** sha256 hex of the canonical JSON of the composed harness, prose included; stable across runs and key order. */
  hash: string;
}

type JsonObject = Record<string, unknown>;
type Fields = Omit<EffectiveHarness, 'sources' | 'instructions' | 'provenance' | 'hash'>;
type Limits = NonNullable<NonNullable<Harness['runtime']>['limits']>;
type ModelHints = NonNullable<NonNullable<Harness['runtime']>['modelHints']>;
type SchemaRef = Record<string, unknown> | string;

interface Draft {
  fields: Fields;
  sections: string[];
  provenance: Record<string, string[]>;
}

const MAX_DEPTH = 4;
const BASE_SOURCE = 'workspace base';
const PAGE_SOURCE = 'page';

function invalid(message: string): ValidationError {
  return new ValidationError(message, undefined, 'LOUSHO_SPEC_INVALID');
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Walk {
  bySource: Map<string, HarnessLayer>;
  ordered: HarnessLayer[];
  chains: Map<HarnessLayer, string[]>;
}

function indexBySource(layers: readonly HarnessLayer[]): Map<string, HarnessLayer> {
  const bySource = new Map<string, HarnessLayer>();
  for (const layer of layers) {
    if (bySource.has(layer.source)) throw invalid(`two layers have the source '${layer.source}'; each source must appear once`);
    bySource.set(layer.source, layer);
  }
  return bySource;
}

function resolveTarget(walk: Walk, owner: HarnessLayer, ref: string): HarnessLayer {
  const target = walk.bySource.get(ref);
  if (!target) throw invalid(`${owner.source} extends '${ref}', but no layer has that source`);
  return target;
}

function childChain(walk: Walk, target: HarnessLayer, trail: string[]): string[] {
  return walk.chains.get(target) ?? visit(walk, target, trail);
}

function visit(walk: Walk, layer: HarnessLayer, path: string[]): string[] {
  let longest: string[] = [];
  for (const ref of layer.harness.extends ?? []) {
    const target = resolveTarget(walk, layer, ref);
    const trail = [...path, target.source];
    if (path.includes(target.source)) throw invalid(`harness extends cycle: ${trail.join(' -> ')}`);
    const chain = childChain(walk, target, trail);
    if (chain.length > longest.length) longest = chain;
  }
  const chain = [layer.source, ...longest];
  if (path.length + longest.length - 1 > MAX_DEPTH) throw invalid(`harness extends deeper than ${MAX_DEPTH}: ${[...path, ...longest].join(' -> ')}`);
  walk.chains.set(layer, chain);
  walk.ordered.push(layer);
  return chain;
}

function orderLayers(layers: readonly HarnessLayer[]): HarnessLayer[] {
  const walk: Walk = { bySource: indexBySource(layers), ordered: [], chains: new Map() };
  for (const source of [BASE_SOURCE, PAGE_SOURCE]) {
    const root = walk.bySource.get(source);
    if (root && !walk.chains.has(root)) visit(walk, root, [source]);
  }
  const unreached = layers.filter((layer) => !walk.chains.has(layer)).map((layer) => layer.source);
  if (unreached.length > 0) throw invalid(`layers not reached from the workspace base or the page: ${unreached.sort().join(', ')}`);
  return walk.ordered;
}

function addSource(draft: Draft, path: string, source: string): void {
  const sources = draft.provenance[path] ?? [];
  if (!sources.includes(source)) draft.provenance[path] = [...sources, source];
}

function setSource(draft: Draft, path: string, source: string): void {
  draft.provenance[path] = [source];
}

function clearBelow(draft: Draft, path: string): void {
  for (const key of Object.keys(draft.provenance)) {
    if (key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete draft.provenance[key];
  }
}

function composeInstructions(draft: Draft, layer: HarnessLayer): void {
  const files = layer.harness.instructions ?? [];
  if (files.length === 0) return;
  const texts = files.map((file) => {
    const text = layer.texts[file];
    if (text === undefined) throw invalid(`${layer.source} lists instruction '${file}', but its layer has no text for it`);
    return text;
  });
  draft.sections.push(`### From ${layer.source}\n\n${texts.join('\n\n')}`);
  addSource(draft, 'instructions', layer.source);
}

function keyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function deepMerge(draft: Draft, current: unknown, next: unknown, path: string, source: string, freeText = false): unknown {
  if (!isPlainObject(next)) {
    clearBelow(draft, path);
    setSource(draft, path, source);
    return next;
  }
  if (!isPlainObject(current)) delete draft.provenance[path];
  const merged: JsonObject = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(next)) {
    const own = Object.prototype.hasOwnProperty.call(merged, key) ? merged[key] : undefined;
    setOwn(merged, key, deepMerge(draft, own, value, freeText ? keyPath(path, key) : `${path}.${key}`, source, true));
  }
  return merged;
}

function composeAudience(draft: Draft, layer: HarnessLayer): void {
  const next = layer.harness.audience;
  if (next) draft.fields.audience = deepMerge(draft, draft.fields.audience, next, 'audience', layer.source) as Fields['audience'];
}

function composePlatform(draft: Draft, layer: HarnessLayer): void {
  const next = layer.harness.platform;
  if (next) draft.fields.platform = deepMerge(draft, draft.fields.platform, next, 'platform', layer.source) as Fields['platform'];
}

function asSchemaObject(schema: SchemaRef): JsonObject {
  return typeof schema === 'string' ? { $ref: schema } : schema;
}

function composeSchema(draft: Draft, current: SchemaRef | undefined, next: SchemaRef | undefined, path: string, source: string): SchemaRef | undefined {
  if (next === undefined) return current;
  if (typeof next === 'string' || next.merge !== 'allOf') {
    setSource(draft, path, source);
    return next;
  }
  const rest = Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'merge'));
  addSource(draft, path, source);
  return current === undefined ? rest : { allOf: [asSchemaObject(current), rest] };
}

function unionBy<T>(draft: Draft, current: T[] | undefined, next: T[] | undefined, key: (item: T) => string, path: string, source: string): T[] | undefined {
  if (!next) return current;
  const items = new Map((current ?? []).map((item) => [key(item), item]));
  for (const item of next) {
    items.set(key(item), item);
    setSource(draft, keyPath(path, key(item)), source);
  }
  draft.provenance[path] = [...new Set([...items.keys()].flatMap((id) => draft.provenance[keyPath(path, id)] ?? []))];
  return [...items.values()];
}

function orderedUnion(draft: Draft, current: string[] | undefined, next: string[] | undefined, path: string, source: string): string[] | undefined {
  if (!next) return current;
  addSource(draft, path, source);
  return [...new Set([...(current ?? []), ...next])];
}

function composeInputs(draft: Draft, layer: HarnessLayer): void {
  const schema = composeSchema(draft, draft.fields.inputs?.schema, layer.harness.inputs?.schema, 'inputs.schema', layer.source);
  if (schema !== undefined) draft.fields.inputs = { schema };
}

function composeOutputs(draft: Draft, layer: HarnessLayer): void {
  const next = layer.harness.outputs;
  if (!next) return;
  const current = draft.fields.outputs;
  const schema = composeSchema(draft, current?.schema, next.schema, 'outputs.schema', layer.source);
  const artifacts = unionBy(draft, current?.artifacts, next.artifacts, (artifact) => artifact.name, 'outputs.artifacts', layer.source);
  draft.fields.outputs = { ...(schema !== undefined && { schema }), ...(artifacts && { artifacts }) };
}

function composeCapabilities(draft: Draft, layer: HarnessLayer): void {
  const require = orderedUnion(draft, draft.fields.capabilities?.require, layer.harness.capabilities?.require, 'capabilities.require', layer.source);
  if (require) draft.fields.capabilities = { require };
}

function composeConstraints(draft: Draft, layer: HarnessLayer): void {
  draft.fields.constraints = unionBy(draft, draft.fields.constraints, layer.harness.constraints, (constraint) => constraint.id, 'constraints', layer.source);
}

function composeEvaluation(draft: Draft, layer: HarnessLayer): void {
  const next = layer.harness.evaluation;
  if (!next) return;
  const criteria = unionBy(draft, draft.fields.evaluation?.criteria, next.criteria, (criterion) => criterion.id, 'evaluation.criteria', layer.source) ?? [];
  const threshold = next.threshold ?? draft.fields.evaluation?.threshold;
  if (next.threshold !== undefined) setSource(draft, 'evaluation.threshold', layer.source);
  draft.fields.evaluation = { criteria, ...(threshold !== undefined && { threshold }) };
}

function tightenLimits(draft: Draft, current: Limits | undefined, next: Limits | undefined, source: string): Limits | undefined {
  if (!next) return current;
  const limits: Limits = { ...current };
  for (const [key, value] of Object.entries(next) as [keyof Limits, number][]) {
    const existing = limits[key];
    if (existing !== undefined && existing <= value) continue;
    limits[key] = value;
    setSource(draft, `runtime.limits.${key}`, source);
  }
  return limits;
}

function laterHints(draft: Draft, current: ModelHints | undefined, next: ModelHints | undefined, source: string): ModelHints | undefined {
  if (!next) return current;
  for (const key of Object.keys(next)) setSource(draft, `runtime.modelHints.${key}`, source);
  return { ...current, ...next };
}

function composeRuntime(draft: Draft, layer: HarnessLayer): void {
  const next = layer.harness.runtime;
  if (!next) return;
  const limits = tightenLimits(draft, draft.fields.runtime?.limits, next.limits, layer.source);
  const modelHints = laterHints(draft, draft.fields.runtime?.modelHints, next.modelHints, layer.source);
  draft.fields.runtime = { ...(limits && { limits }), ...(modelHints && { modelHints }) };
}

function composeContext(draft: Draft, layer: HarnessLayer): void {
  const resources = orderedUnion(draft, draft.fields.context?.resources, layer.harness.context?.resources, 'context.resources', layer.source);
  if (resources) draft.fields.context = { resources };
}

const FIELD_RULES: readonly ((draft: Draft, layer: HarnessLayer) => void)[] = [
  composeInstructions,
  composeAudience,
  composePlatform,
  composeInputs,
  composeOutputs,
  composeCapabilities,
  composeConstraints,
  composeEvaluation,
  composeRuntime,
  composeContext,
];

const FIELD_ORDER = ['audience', 'platform', 'inputs', 'outputs', 'capabilities', 'constraints', 'evaluation', 'runtime', 'context'] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return Object.fromEntries(keys.map((key) => [key, canonicalize(value[key])]));
}

function sortedProvenance(provenance: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(provenance)
      .sort()
      .map((key) => [key, provenance[key] as string[]])
  );
}

/** Compose resolved harness layers into one effective harness: the base harness, then each `extends` ref matched exactly to a layer `source`, depth first, then the page. */
export function composeHarness(layers: readonly HarnessLayer[]): EffectiveHarness {
  const ordered = orderLayers(layers);
  const draft: Draft = { fields: {}, sections: [], provenance: {} };
  for (const layer of ordered) {
    for (const rule of FIELD_RULES) rule(draft, layer);
  }
  const fields = Object.fromEntries(FIELD_ORDER.filter((key) => draft.fields[key] !== undefined).map((key) => [key, draft.fields[key]])) as Fields;
  const composed = structuredClone({ sources: ordered.map((layer) => layer.source), instructions: draft.sections.join('\n\n'), ...fields });
  const hash = createHash('sha256').update(JSON.stringify(canonicalize(composed)), 'utf8').digest('hex');
  return { ...composed, provenance: sortedProvenance(draft.provenance), hash };
}
