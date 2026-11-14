/**
 * Seeded generators ("arbitraries") for the round-trip property test:
 * `arbSpec` builds a random but deterministic `AgentSpecV2` covering every
 * section and agent field, `arbLayout` a random `CanvasLayout` over a
 * graph's node ids. They are plain functions over a `mulberry32` rng so a
 * failing seed reproduces exactly.
 *
 * `arbSpec` returns `AgentSpecV2` through a cast on purpose: `evals`, `flow`
 * and `abortListeners` are `never` on the SDK type until their runtime
 * tickets land, and unknown keys are not part of the interface — but the
 * canvas must carry all of them untouched through `extra`, so the generator
 * exercises them anyway.
 */
import type { CanvasLayout } from '../../../../shared/wireTypes';
import { SPEC_KEY_ORDER } from '../order';
import type { AgentSpecV2 } from '../specTypes';
import type { Graph } from '../types';
import { chance, int, pick } from './prng';

type Rng = () => number;

const MODELS = ['anthropic/claude-sonnet-5-5', 'openai/gpt-5', 'mock/mock-1'] as const;

/** Tool refs: real builtin names plus every other ToolRef variant. Duplicates exercise the `#2` id rule. */
const TOOL_CHOICES = [
  { builtin: 'http_request' },
  { builtin: 'current_date' },
  { builtin: 'web_fetch', approval: 'always' },
  { registry: 'github-issues' },
  { file: 'tools/search.ts' },
  { hosted: 'web_search' },
  { hub: true },
] as const;

const MCP_KEYS = ['github', 'fs', 'linear'] as const;
const SUBAGENT_KEYS = ['research', 'helper', 'worker'] as const;
const PERMISSION_PATTERNS = ['http_request', 'github__*', '*', ['http_request', 'web_fetch']] as const;

/** One valid value per optional agent field, emitted with p = 0.3. */
const OPTIONAL_FIELDS: ReadonlyArray<readonly [string, (rng: Rng) => unknown]> = [
  ['fallbackModels', () => ['openai/gpt-5']],
  ['instructionsByFamily', (rng) => ({ claude: 'Tail ' + int(rng, 0, 9) })],
  ['promptRef', () => 'main@prod'],
  ['modelSettings', () => ({ temperature: 0.2 })],
  ['reasoning', (rng) => pick(rng, ['low', 'high', { budgetTokens: 2048 }] as const)],
  ['subagentOptions', () => ({ maxConcurrent: 2 })],
  ['maxSubagentDepth', (rng) => int(rng, 1, 3)],
  ['maxHandoffs', (rng) => int(rng, 1, 4)],
  ['permissionMode', () => 'plan'],
  ['approvalTtlMs', (rng) => int(rng, 1000, 60000)],
  ['askQuestion', () => true],
  ['limits', () => ({ maxCostUsd: 1 })],
  ['maxSteps', (rng) => int(rng, 1, 50)],
  ['compaction', () => true],
  ['retry', () => false],
  ['rateLimit', () => ({ requestsPerMinute: 10 })],
  ['promptCaching', () => 'auto'],
  ['toolSearch', () => ({ maxResults: 5 })],
  ['codeMode', () => true],
];

/** A random list of `n` items built by `make`. */
const times = <T>(rng: Rng, n: number, make: (rng: Rng, i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(rng, i));

function arbTools(rng: Rng): unknown[] {
  return times(rng, int(rng, 0, 3), (r) => pick(r, TOOL_CHOICES));
}

function arbMcpServers(rng: Rng): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (let i = 0; i < int(rng, 0, 3); i += 1) {
    servers[pick(rng, MCP_KEYS)] = chance(rng, 0.5)
      ? { command: 'npx', args: ['-y', 'x'] }
      : { url: 'https://mcp.example/' + int(rng, 0, 9) };
  }
  return servers;
}

function arbSubagents(rng: Rng, depth: number): Record<string, unknown> {
  const subs: Record<string, unknown> = {};
  for (let i = 0; i < int(rng, 0, 3); i += 1) {
    const key = pick(rng, SUBAGENT_KEYS);
    if (depth < 2 && chance(rng, 0.3)) {
      subs[key] = { inline: arbInline(rng, depth + 1) };
    } else {
      subs[key] = chance(rng, 0.5)
        ? { ref: 'agents/x.yaml' }
        : { remote: { url: 'https://r', description: 'remote' } };
    }
  }
  return subs;
}

function arbTriggers(rng: Rng): Array<Record<string, unknown>> {
  return times(rng, int(rng, 0, 3), (r, i) =>
    chance(r, 0.5)
      ? { id: 't' + i, type: 'chat' }
      : { id: 't' + i, type: 'cron', cron: '0 9 * * *', prompt: 'go' }
  );
}

function arbSectionValue(rng: Rng, key: string, depth: number): unknown {
  switch (key) {
    case 'triggers':
      return arbTriggers(rng);
    case 'tools':
      return arbTools(rng);
    case 'mcpServers':
      return arbMcpServers(rng);
    case 'skills':
      return times(rng, int(rng, 0, 3), (r, i) =>
        pick(r, [
          { dir: 'skills/a' },
          { registry: 'changelog' },
          { inline: { name: 's' + i, description: 'd', content: 'c' } },
        ])
      );
    case 'memory':
      return times(rng, int(rng, 0, 3), (_r, i) => ({
        name: 'm' + i,
        scope: 'session',
        provider: { type: 'in-memory' },
      }));
    case 'subagents':
      return arbSubagents(rng, depth);
    case 'handoffs':
      return times(rng, int(rng, 0, 3), (_r, i) => ({ agent: 'billing' + i }));
    case 'guardrails':
      return times(rng, int(rng, 0, 3), (_r, i) => ({ id: 'g' + i, name: 'max-length', on: 'input' }));
    case 'permissions':
      return times(rng, int(rng, 0, 3), (r, i) => ({
        id: 'p' + i,
        tool: pick(r, PERMISSION_PATTERNS),
        action: pick(r, ['allow', 'deny', 'ask'] as const),
      }));
    case 'hooks':
      return times(rng, int(rng, 0, 3), (r, i) =>
        chance(r, 0.5)
          ? { id: 'h' + i, file: 'hooks/h.ts' }
          : { id: 'h' + i, inline: { name: 'n', point: 'preToolCall', code: 'return ctx;' } }
      );
    default:
      return undefined;
  }
}

/** The sections `buildSpec` fills with p = 0.5, in emission order. */
const INLINE_SECTION_KEYS = [
  'tools', 'mcpServers', 'skills', 'memory', 'subagents', 'handoffs', 'guardrails', 'permissions', 'hooks',
] as const;
const ROOT_SECTION_KEYS = ['triggers', ...INLINE_SECTION_KEYS] as const;

/** Sections and `output` into `acc`. */
function fillSections(rng: Rng, acc: Record<string, unknown>, depth: number, isInline: boolean): void {
  for (const key of isInline ? INLINE_SECTION_KEYS : ROOT_SECTION_KEYS) {
    if (chance(rng, 0.5)) acc[key] = arbSectionValue(rng, key, depth);
  }
  if (chance(rng, 0.3)) acc['output'] = { jsonSchema: { type: 'object' } };
}

/** Leaf step types — the ones a depth-3 (or unlucky) node must pick. */
const FLOW_LEAF_TYPES = [
  'evaluator', 'llmCall', 'agent', 'approval', 'toolCall', 'setVariable', 'return', 'end', 'throw',
] as const;
/** Container step types — only offered while `depth < 3`. */
const FLOW_CONTAINER_TYPES = ['sequence', 'parallel', 'oneOf', 'forEach'] as const;

/** The default fields of one leaf step type (the same defaults the palette uses). */
function flowLeafFields(rng: Rng, type: string): Record<string, unknown> {
  switch (type) {
    case 'evaluator':
      return { expression: 'a + b', outputVariable: 'result' };
    case 'llmCall':
      return { prompt: 'Say hi', outputVariable: 'text' };
    case 'agent':
      return { agent: 'self', outputVariable: 'answer' };
    case 'approval':
      return { message: 'Approve this?' };
    case 'toolCall':
      return { tool: 'http_request', arguments: {}, outputVariable: 'toolResult' };
    case 'setVariable':
      return { variable: 'v' + int(rng, 0, 9), value: 'x' };
    case 'return':
      return { value: '$result' };
    case 'end':
      return { value: '$text' };
    case 'throw':
      return { message: 'failed' };
    default:
      return {};
  }
}

/**
 * One random executable step, depth ≤ 3, with a fresh `s<n>` id from
 * `nextId`. Containers only appear while `depth < 3`; `oneOf` gets 2–3
 * options with at most one condition-less default.
 */
function arbFlowStep(rng: Rng, depth: number, nextId: () => string): Record<string, unknown> {
  const id = nextId();
  const nest = (): Record<string, unknown> => arbFlowStep(rng, depth + 1, nextId);
  if (depth < 3 && chance(rng, 0.4)) {
    switch (pick(rng, FLOW_CONTAINER_TYPES)) {
      case 'sequence':
      case 'parallel':
        return { type: pick(rng, ['sequence', 'parallel'] as const), id, steps: times(rng, int(rng, 1, 3), nest) };
      case 'oneOf': {
        const count = int(rng, 2, 3);
        const options = times(rng, count, (r, i) => ({
          ...(i === count - 1 && chance(r, 0.5) ? {} : { condition: `c${i} == 'x'` }),
          step: nest(),
        }));
        return { type: 'oneOf', id, options };
      }
      case 'forEach':
        return {
          type: 'forEach',
          id,
          items: pick(rng, ['$items', ['$a', '$b']] as const),
          itemVariable: 'item',
          ...(chance(rng, 0.7) ? { step: nest() } : {}),
        };
    }
  }
  const type = pick(rng, FLOW_LEAF_TYPES);
  return { type, id, ...flowLeafFields(rng, type) };
}

/**
 * A random `AgentFlow`: a root `sequence` of 1–3 steps (depth ≤ 3, unique
 * `s1…` ids, every executable type possible), flow metadata with optional
 * `description`/`inputs`/`agents` — the shape `addFlowNodes` must turn
 * into a lossless node tree.
 */
function arbFlow(rng: Rng): Record<string, unknown> {
  let n = 0;
  const nextId = () => `s${(n += 1)}`;
  const flow: Record<string, unknown> = {
    code: 'flow-' + int(rng, 0, 99),
    name: 'Flow ' + int(rng, 0, 99),
  };
  if (chance(rng, 0.3)) flow['description'] = 'desc ' + int(rng, 0, 9);
  if (chance(rng, 0.3)) flow['inputs'] = [{ name: 'topic', type: 'string' }];
  flow['flow'] = {
    type: 'sequence',
    id: nextId(),
    steps: times(rng, int(rng, 1, 3), () => arbFlowStep(rng, 1, nextId)),
  };
  if (chance(rng, 0.3)) flow['agents'] = [{ name: 'helper' }];
  return flow;
}

/** The root-only keys: abort listeners (only when triggers came out non-empty), `evals`, `flow` and an unknown key. */
function fillRootOnly(rng: Rng, acc: Record<string, unknown>): void {
  const triggers = (acc['triggers'] as Array<{ id: string }> | undefined) ?? [];
  if (triggers.length > 0 && chance(rng, 0.5)) {
    acc['abortListeners'] = times(rng, int(rng, 0, 3), (r, i) => ({
      id: 'a' + i,
      triggerId: pick(r, triggers).id,
      when: 'true',
      match: 'true',
      scope: 'both',
    }));
  }
  if (chance(rng, 0.2)) acc['evals'] = [{ dataset: 'd', gates: [{ maxSteps: 5 }], minPassRate: 0.8 }];
  // ~20% a full flow tree; ~10% a flow with no runnable root step (stays in
  // `extra`, exercising the C15 fallback); the rest none.
  const roll = int(rng, 0, 9);
  if (roll < 2) acc['flow'] = arbFlow(rng);
  else if (roll === 2) acc['flow'] = { code: 'f', name: 'f' };
  if (chance(rng, 0.2)) acc['x-extra'] = { n: int(rng, 0, 9) };
}

/** `acc` re-emitted in `SPEC_KEY_ORDER` with unknown keys last. */
function emitOrdered(acc: Record<string, unknown>): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const key of SPEC_KEY_ORDER) {
    if (key in acc) spec[key] = acc[key];
  }
  for (const key of Object.keys(acc)) {
    if (!(key in spec)) spec[key] = acc[key];
  }
  return spec;
}

/**
 * The shared builder behind `arbSpec` / `arbInline`: fills `acc` in any
 * order, then emits keys in `SPEC_KEY_ORDER` with unknown keys last.
 * `isInline` drops the root-only keys and makes `description` required.
 */
function buildSpec(rng: Rng, depth: number, isInline: boolean): Record<string, unknown> {
  const acc: Record<string, unknown> = {
    name: 'agent-' + int(rng, 0, 999),
    model: pick(rng, MODELS),
    instructions: chance(rng, 0.8) ? 'Do ' + int(rng, 0, 99) : { file: 'prompts/main.md' },
  };
  if (!isInline) acc['version'] = 2;
  if (isInline || chance(rng, 0.3)) {
    acc['description'] = (isInline ? 'Sub ' : 'Agent ') + int(rng, 0, 99);
  }
  for (const [key, make] of OPTIONAL_FIELDS) {
    if (chance(rng, 0.3)) acc[key] = make(rng);
  }
  fillSections(rng, acc, depth, isInline);
  if (!isInline) fillRootOnly(rng, acc);
  return emitOrdered(acc);
}

/** An inline subagent spec: `arbSpec` minus `version` and the root-only sections, with `description` required. */
function arbInline(rng: Rng, depth: number): Record<string, unknown> {
  return buildSpec(rng, depth, true);
}

/** A random spec covering every handled section and agent field, keys in SPEC_KEY_ORDER. */
export function arbSpec(rng: Rng, depth = 0): AgentSpecV2 {
  return buildSpec(rng, depth, false) as unknown as AgentSpecV2;
}

/** A random layout over `graph`'s node ids: ~70% get a position, agents may be collapsed, plus notes and a viewport. */
export function arbLayout(rng: Rng, graph: Graph): CanvasLayout {
  const nodes: CanvasLayout['nodes'] = {};
  for (const node of graph.nodes) {
    if (node.kind === 'note') continue;
    if (!chance(rng, 0.7)) continue;
    const entry: { x: number; y: number; collapsed?: boolean } = {
      x: int(rng, -2000, 2000),
      y: int(rng, -2000, 2000),
    };
    if (node.kind === 'agent' && chance(rng, 0.3)) entry.collapsed = chance(rng, 0.5);
    nodes[node.id] = entry;
  }
  const layout: CanvasLayout = {
    schemaVersion: 1,
    nodes,
    notes: times(rng, int(rng, 0, 2), (_r, i) => ({
      id: 'n' + i,
      x: int(rng, -2000, 2000),
      y: int(rng, -2000, 2000),
      text: 'note ' + i,
    })),
  };
  if (chance(rng, 0.5)) {
    layout.viewport = { x: int(rng, -500, 500), y: int(rng, -500, 500), zoom: pick(rng, [0.5, 1, 1.5] as const) };
  }
  return layout;
}
