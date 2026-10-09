/**
 * Wires memory slots into createAgent() runs (LOU-W6): each run resolves its
 * scope keys, gets a `memory` preGenerate hook that recalls into the system
 * prompt on the run's first model call, and gets the slots' tools bound to
 * those keys.
 */
import { z } from 'zod';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolDescriptor } from '../types';
import { HookRegistry, type AgentHook } from '../execution/hooks';
import type { Message } from '../providers/llm';
import type { AgentConfig } from '../types';
import { textOf } from '../providers/content';
import { memoryKey, type MemoryItem, type MemoryScopeContext, type MemorySlot } from './defineMemory';
import { SDKError } from '../execution/errors';

/** A slot bound to a run's provider key (`<slot name>#<scope key>`). */
type BoundSlot = readonly [slot: MemorySlot, key: string];

/** JSON.stringify with object keys sorted, so equal values serialize identically (items dedupe on text). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v
  );
}

function toolNames({ name, expose }: MemorySlot): string[] {
  return [...(expose.remember ? [`remember_${name}`] : []), ...(expose.recall ? [`recall_${name}`] : [])];
}

/** Most items one `recall_<name>` call returns, whatever `limit` the model asks for (Eve MEM-F11). */
const MAX_RECALL_LIMIT = 100;

/** Eve MEM-F15: how long a remembered item lasts, by the slot's scope. */
function persistence(slot: MemorySlot): string {
  if (slot.scope === 'session') return 'recalled later in this conversation';
  if (slot.scope === 'global') return 'recalled in later conversations';
  return 'recalled in later conversations with the same user or key';
}

/** What `recall_<name>` returns for an item: its `score` (vector providers) and, on a free-text slot, its other metadata (Eve MEM-F11). */
function recalledItem(slot: MemorySlot, { id, text, createdAt, metadata }: MemoryItem) {
  const { score, ...rest } = metadata ?? {};
  return {
    id,
    text,
    createdAt,
    ...(typeof score === 'number' && { score }),
    // An itemSchema slot's metadata is the parsed `text`: not sent twice.
    ...(!slot.itemSchema && Object.keys(rest).length > 0 && { metadata: rest }),
  };
}

function memoryTools([slot, key]: BoundSlot): DefinedTool[] {
  const about = slot.description ? ` It holds: ${slot.description}` : '';
  const remember = defineTool({
    name: `remember_${slot.name}`,
    description: `Save a fact to the "${slot.name}" memory so it is ${persistence(slot)}.${about}`,
    input: slot.itemSchema ?? z.object({ text: z.string().min(1).describe('The fact, written so it makes sense on its own') }),
    execute: async (args) => {
      // With an itemSchema the parsed arguments are the item: canonical JSON
      // for its text, the parsed object for its metadata.
      const item = slot.itemSchema
        ? { text: stableStringify(args), metadata: args as Record<string, unknown> }
        : { text: (args as { text: string }).text };
      return { remembered: (await slot.provider.add(key, item)).id };
    },
  });
  const recall = defineTool({
    name: `recall_${slot.name}`,
    // N4: recalling changes nothing, so plan mode can use it.
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: `Search the "${slot.name}" memory${slot.provider.ranking === 'relevance' ? ' by meaning, most relevant first' : ', newest items first'}.${about}`,
    input: z.object({
      query: z.string().optional(),
      limit: z.number().int().positive().optional().describe(`Most items to return (at most ${MAX_RECALL_LIMIT})`),
    }),
    execute: async ({ query, limit = slot.recall.maxItems }) => ({
      items: (await slot.provider.list(key, { query, limit: Math.min(limit, MAX_RECALL_LIMIT) })).map((item) => recalledItem(slot, item)),
    }),
  });
  // Bound to this run's scope key, so they exist in this run's registry only
  // (a resumed run has none - see the memory.test.ts approval-resume case);
  // `transient` keeps them out of the agent fingerprint, or every resume
  // would report their loss as agent drift.
  for (const tool of [remember, recall]) tool.transient = true;
  return [...(slot.expose.remember ? [remember] : []), ...(slot.expose.recall ? [recall] : [])];
}

const BLOCK = /\n*<memory name="([^"]*)">[\s\S]*?<\/memory>/g;

function block(name: string, items: readonly MemoryItem[]): string {
  // Eve MEM-F16: an opening or closing memory tag inside an item would break
  // the block (and the replacement of blocks in a resumed transcript).
  const lines = items.map((item) => `- ${item.text.replace(/<(\/?memory)/gi, '&lt;$1').replace(/\s+/g, ' ').trim()}`);
  return [`<memory name="${name}">`, ...lines, '</memory>'].join('\n');
}

/** Puts `blocks` at the end of the system message, replacing earlier blocks of the same slots (from a resumed run). */
function setBlocks(messages: Message[], names: ReadonlySet<string>, blocks: string[]): void {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const base = system ? textOf(system).replace(BLOCK, (match, name: string) => (names.has(name) ? '' : match)) : '';
  const content = [base, ...blocks].filter(Boolean).join('\n\n');
  if (system) messages[0] = { ...system, content };
  else if (blocks.length > 0) messages.unshift({ role: 'system', content });
}

/** Slots whose recall failure was already logged (one console.warn per slot). */
const warnedRecall = new WeakSet<MemorySlot>();

function warnRecallFailed(slot: MemorySlot, error: unknown): void {
  if (warnedRecall.has(slot)) return;
  warnedRecall.add(slot);
  console.warn(`[lousho] memory '${slot.name}': recall failed, continuing without it: ${(error as Error)?.message ?? String(error)}`);
}

/**
 * Recalls into the system prompt on the run's first model call (not a
 * sub-agent's). A handoff replaces the system prompt with the target's, so a
 * later call puts the recalled blocks back when they are missing.
 */
function recallHook(bound: readonly BoundSlot[]): AgentHook {
  let recalled: { names: Set<string>; blocks: string[] } | undefined;
  return {
    name: 'memory-recall',
    async preGenerate(ctx) {
      if (ctx.subagent) return;
      if (recalled) {
        const { names, blocks } = recalled;
        const system = ctx.request.messages[0]?.role === 'system' ? textOf(ctx.request.messages[0]) : '';
        if (!blocks.every((text) => system.includes(text))) setBlocks(ctx.request.messages, names, blocks);
        return;
      }
      const lastInput = textOf([...ctx.messages].reverse().find((m) => m.role === 'user') ?? { content: '' });
      const recalling = bound.filter(([slot]) => slot.recall.onSessionStart);
      const blocks = await Promise.all(
        recalling.map(async ([slot, key]) => {
          const query = slot.recall.query === 'last-input' && lastInput ? lastInput : undefined;
          let items: MemoryItem[];
          try {
            items = await slot.provider.list(key, { limit: slot.recall.maxItems, query });
          } catch (error) {
            // Eve MEM-F4: recall is an optimization; a corrupt file or a store
            // outage must not fail every run. The recall_ tool still reports it.
            warnRecallFailed(slot, error);
            return '';
          }
          return items.length > 0 ? block(slot.name, items) : '';
        })
      );
      recalled = { names: new Set(recalling.map(([slot]) => slot.name)), blocks: blocks.filter(Boolean) };
      setBlocks(ctx.request.messages, recalled.names, recalled.blocks);
    },
  };
}

/** The agent's registry plus one run's memory tools. */
class RunToolRegistry extends ToolRegistry {
  constructor(private readonly base: ToolRegistry | undefined) {
    super();
  }
  get(name: string): ToolDescriptor | undefined {
    return super.get(name) ?? this.base?.get(name);
  }
  has(name: string): boolean {
    return super.has(name) || this.base?.has(name) === true;
  }
  list(): string[] {
    return [...new Set([...(this.base?.list() ?? []), ...super.list()])];
  }
  getAll(): Record<string, ToolDescriptor> {
    return { ...this.base?.getAll(), ...super.getAll() };
  }
}

/** Agent memory for createAgent(), or `undefined` without slots. */
export interface AgentMemory {
  /** Adds the slots' tool names to the agent's tools; throws when one is taken. */
  addTools(toolsConfig: Record<string, { tool: string }>): void;
  /**
   * N6: the agent a run handed off to, with this run's memory tools added to
   * its tools and registry (bound to the same scope keys), so the lead's
   * memory stays on after a handoff.
   */
  forTarget<S extends { agent: AgentConfig; toolRegistry?: ToolRegistry }>(ctx: MemoryScopeContext, spec: S): S;
  /** One run's tool registry and hooks, for its session id / metadata. */
  forRun(
    ctx: MemoryScopeContext,
    toolRegistry: ToolRegistry | undefined,
    hooks: HookRegistry | undefined
  ): { toolRegistry: ToolRegistry; hooks: HookRegistry };
}

/** `slots` bound to the run's provider keys (`<slot name>#<scope key>`); a slot whose scope has no key for the run is left out. */
function boundSlots(slots: readonly MemorySlot[], ctx: MemoryScopeContext): BoundSlot[] {
  return slots.flatMap((slot): BoundSlot[] => {
    const key = memoryKey(slot, ctx);
    return key === undefined ? [] : [[slot, key]];
  });
}

/** `toolRegistry` plus the memory tools of `bound`. */
function runToolRegistry(bound: readonly BoundSlot[], toolRegistry: ToolRegistry | undefined): ToolRegistry {
  const runTools = new RunToolRegistry(toolRegistry);
  runTools.registerMany(bound.flatMap(memoryTools));
  return runTools;
}

export function agentMemory(slots: readonly MemorySlot[] | undefined): AgentMemory | undefined {
  if (!slots || slots.length === 0) return undefined;
  const names = new Set<string>();
  for (const { name } of slots) {
    if (names.has(name)) throw new SDKError(`createAgent: two memory slots are named '${name}'. Rename one.`, 'LOUSHO_MEMORY_INVALID');
    names.add(name);
  }
  return {
    addTools(toolsConfig) {
      for (const tool of slots.flatMap(toolNames)) {
        if (toolsConfig[tool]) {
          throw new SDKError(`createAgent: a tool named '${tool}' is already registered, but a memory slot adds one. Rename one.`, 'LOUSHO_MEMORY_INVALID');
        }
        toolsConfig[tool] = { tool };
      }
    },
    forTarget(ctx, spec) {
      const tools = { ...spec.agent.tools };
      for (const tool of slots.flatMap(toolNames)) tools[tool] ??= { tool };
      return { ...spec, agent: { ...spec.agent, tools }, toolRegistry: runToolRegistry(boundSlots(slots, ctx), spec.toolRegistry) };
    },
    forRun(ctx, toolRegistry, hooks) {
      const bound = boundSlots(slots, ctx);
      const runTools = runToolRegistry(bound, toolRegistry);
      const runHooks = new HookRegistry();
      runHooks.registerMany([recallHook(bound), ...(hooks?.list() ?? [])]);
      return { toolRegistry: runTools, hooks: runHooks };
    },
  };
}
