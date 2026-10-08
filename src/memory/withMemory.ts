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
import type { MemoryItem, MemoryScopeContext, MemorySlot } from './defineMemory';
import { SDKError } from '../execution/errors';

/** A slot bound to a run's scope key. */
type BoundSlot = readonly [slot: MemorySlot, key: string];

/** The run's key for `slot`: `'global'`, `'session:<id>'`, or the scope function's value. */
function scopeKey(slot: MemorySlot, ctx: MemoryScopeContext): string | undefined {
  if (slot.scope === 'global') return 'global';
  if (slot.scope === 'session') return ctx.sessionId && `session:${ctx.sessionId}`;
  return slot.scope(ctx) || undefined;
}

function toolNames({ name, expose }: MemorySlot): string[] {
  return [...(expose.remember ? [`remember_${name}`] : []), ...(expose.recall ? [`recall_${name}`] : [])];
}

function memoryTools([slot, key]: BoundSlot): DefinedTool[] {
  const about = slot.description ? ` It holds: ${slot.description}` : '';
  const remember = defineTool({
    name: `remember_${slot.name}`,
    description: `Save a fact to the "${slot.name}" memory so it is recalled in later conversations.${about}`,
    input: z.object({ text: z.string().min(1).describe('The fact, written so it makes sense on its own') }),
    execute: async ({ text }) => ({ remembered: (await slot.provider.add(key, { text })).id }),
  });
  const recall = defineTool({
    name: `recall_${slot.name}`,
    // N4: recalling changes nothing, so plan mode can use it.
    annotations: { readOnlyHint: true, destructiveHint: false },
    description: `Search the "${slot.name}" memory${slot.provider.ranking === 'relevance' ? ' by meaning, most relevant first' : ', newest items first'}.${about}`,
    input: z.object({ query: z.string().optional(), limit: z.number().int().positive().optional() }),
    execute: async ({ query, limit = slot.recall.maxItems }) => ({
      items: (await slot.provider.list(key, { query, limit })).map(({ id, text, createdAt }) => ({ id, text, createdAt })),
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
  const lines = items.map((item) => `- ${item.text.replace(/<\/memory>/gi, '').replace(/\s+/g, ' ').trim()}`);
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
          const items = await slot.provider.list(key, { limit: slot.recall.maxItems, query });
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

/** `slots` bound to the run's scope keys; a slot whose scope has no key for the run is left out. */
function boundSlots(slots: readonly MemorySlot[], ctx: MemoryScopeContext): BoundSlot[] {
  return slots.flatMap((slot): BoundSlot[] => {
    const key = scopeKey(slot, ctx);
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
