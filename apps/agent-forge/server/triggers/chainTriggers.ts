/**
 * Agent chain triggers (R07): when agent A's run ends `done`/`error`,
 * every agent B whose spec carries `{ type: 'agent', after: 'A' }`
 * dispatches through the workspace `TriggerHost` with the prompt
 * template rendered over A's result.
 *
 * Two halves:
 *
 * - Save time: `validateChains`/`findChainProblem` reject specs that
 *   would loop forever or chain deeper than {@link MAX_CHAIN_DEPTH}
 *   agents. The graph walks are iterative with memoised longest-path
 *   tables - specs come from user files, so nothing here recurses.
 *
 * - Run time: `attachChainTriggers` listens to the host's `onRunEnd`
 *   (trigger-launched runs) AND to RunManager `'status'` transitions for
 *   runs the host does not own (manual test-pane runs), so a manual
 *   test of A chains just like a scheduled one. The chain a run was
 *   dispatched with travels in its `ChainEvent`; since `RunEnd` does not
 *   carry the event, dispatched runKeys are remembered in
 *   `chainByRunKey` until that run ends.
 *
 * A cancelled run (`RunEnd.cancelled`, or a manual `stopped`/abort)
 * chains nothing, and `paused` is not an end.
 */
import type { AgentSpecV2 } from 'lousho';
import type { TriggerSpec } from 'lousho/spec';

import type { AgentRepo } from '../storage/agentRepo';
import type { RunManager } from '../runRegistry';
import { renderTemplate } from './template';
import type { RunEnd, TriggerHost } from './triggerHost';

export const MAX_CHAIN_DEPTH = 3;

/** `AgentSpecV2['triggers'][number]` narrowed to the `agent` kind. */
export type AgentTrigger = Extract<TriggerSpec, { type: 'agent' }>;

export type ChainStatus = 'done' | 'error';

/** The `triggerEvent` a chained dispatch carries into the run. */
export interface ChainEvent {
  type: 'agent';
  after: string;
  run: { status: ChainStatus; resultText: string; traceId: string };
  /** Agent ids chained so far, ending with the agent whose run just ended. */
  chain: string[];
}

/** `resultText` is capped before it reaches a template or the event. */
const RESULT_TEXT_CAP = 8000;

const TERMINAL = new Set(['done', 'error', 'stopped']);

/** Agent ids chained after `agentId` (direct), from all specs. */
export function chainTargets(
  specs: Map<string, AgentSpecV2>,
  agentId: string,
  status: ChainStatus
): Array<{ agentId: string; trigger: AgentTrigger }> {
  const targets: Array<{ agentId: string; trigger: AgentTrigger }> = [];
  for (const [ownerId, spec] of specs) {
    for (const trigger of spec.triggers ?? []) {
      if (trigger.type !== 'agent' || trigger.after !== agentId) continue;
      if (trigger.on !== 'any' && trigger.on !== status) continue;
      targets.push({ agentId: ownerId, trigger });
    }
  }
  return targets;
}

export type ChainValidation = { ok: true } | { ok: false; error: string; cycle?: string[] };

/** A save that `validateChains` refuses; routes map it to 400 LOUSHO_CHAIN_INVALID. */
export class ChainInvalidError extends Error {
  readonly code = 'LOUSHO_CHAIN_INVALID';
  constructor(
    message: string,
    readonly cycle?: string[]
  ) {
    super(message);
    this.name = 'ChainInvalidError';
  }
}

/**
 * Save-time check over all specs with `candidate` replacing
 * `candidateId`'s spec. Only problems the candidate can be blamed for
 * are reported: its own `after` targets (unknown/self), cycles and
 * over-deep paths that pass through `candidateId`.
 */
export function validateChains(
  specs: Map<string, AgentSpecV2>,
  candidateId: string,
  candidate: AgentSpecV2
): ChainValidation {
  const effective = new Map(specs);
  effective.set(candidateId, candidate);

  for (const trigger of candidate.triggers ?? []) {
    if (trigger.type !== 'agent') continue;
    if (trigger.after === candidateId) return { ok: false, error: "An agent can't run after itself." };
    if (!effective.has(trigger.after)) {
      return {
        ok: false,
        error: `Trigger ${trigger.id} runs after '${trigger.after}', but there is no agent with that id.`,
      };
    }
  }

  // Edges point `after` -> owner: A's run ending starts every B with
  // `after: 'A'`, so a chain reads left to right along these edges.
  const adj = adjacency(effective);
  const cycle = cycleThrough(adj, candidateId);
  if (cycle !== undefined) {
    return {
      ok: false,
      error: `These agents would start each other forever: ${cycle.join(' → ')}.`,
      cycle,
    };
  }

  const { down, argDown, up, argUp } = longestPaths(adj, effective);
  const depth = (up.get(candidateId) ?? 1) + (down.get(candidateId) ?? 1) - 1;
  if (depth <= MAX_CHAIN_DEPTH) return { ok: true };

  const before: string[] = [];
  for (let cur = argUp.get(candidateId); cur !== undefined; cur = argUp.get(cur)) before.unshift(cur);
  const after: string[] = [];
  for (let cur = argDown.get(candidateId); cur !== undefined; cur = argDown.get(cur)) after.push(cur);
  return {
    ok: false,
    error: `This chain is longer than ${MAX_CHAIN_DEPTH} agents: ${[...before, candidateId, ...after].join(' → ')}.`,
  };
}

/** Loads every stored spec once; unreadable specs are skipped (they fail their own reads elsewhere). */
export async function loadSpecs(repo: AgentRepo): Promise<Map<string, AgentSpecV2>> {
  const specs = new Map<string, AgentSpecV2>();
  for (const id of repo.listIds()) {
    const spec = await repo.readSpec(id).catch(() => undefined);
    if (spec !== undefined) specs.set(id, spec);
  }
  return specs;
}

/** `after` -> owner adjacency for every `agent` trigger in `specs`. */
function adjacency(specs: Map<string, AgentSpecV2>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [ownerId, spec] of specs) {
    for (const trigger of spec.triggers ?? []) {
      if (trigger.type !== 'agent') continue;
      const owners = adj.get(trigger.after) ?? [];
      owners.push(ownerId);
      adj.set(trigger.after, owners);
    }
  }
  return adj;
}

/**
 * A cycle that passes through `start`, as `[start, ..., start]`, or
 * `undefined`. Iterative DFS: when an edge leads back to `start`, the
 * parent chain from `start` to that node plus `start` is the cycle.
 */
function cycleThrough(adj: Map<string, string[]>, start: string): string[] | undefined {
  const parent = new Map<string, string | null>([[start, null]]);
  const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const owners = adj.get(top.node) ?? [];
    if (top.next >= owners.length) {
      stack.pop();
      continue;
    }
    const next = owners[top.next++];
    if (next === start) {
      const cycle: string[] = [];
      for (let cur: string | null = top.node; cur !== null; cur = parent.get(cur) ?? null) cycle.unshift(cur);
      return [...cycle, start];
    }
    if (!parent.has(next)) {
      parent.set(next, top.node);
      stack.push({ node: next, next: 0 });
    }
  }
  return undefined;
}

interface PathTables {
  /** Longest chain (agent count) starting at each node. */
  down: Map<string, number>;
  /** The successor continuing `down`'s longest chain. */
  argDown: Map<string, string>;
  /** Longest chain (agent count) ending at each node. */
  up: Map<string, number>;
  /** The predecessor continuing `up`'s longest chain. */
  argUp: Map<string, string>;
}

/** Memoised longest-path tables over `adj` (down) and its transpose (up). */
function longestPaths(adj: Map<string, string[]>, specs: Map<string, AgentSpecV2>): PathTables {
  const radj = new Map<string, string[]>();
  for (const [from, tos] of adj) {
    for (const to of tos) {
      const preds = radj.get(to) ?? [];
      preds.push(from);
      radj.set(to, preds);
    }
  }
  const nodes = [...specs.keys()];
  const downEdges = longestFrom(adj, nodes);
  const upEdges = longestFrom(radj, nodes);
  return {
    down: downEdges,
    argDown: argExtremes(adj, downEdges),
    up: upEdges,
    argUp: argExtremes(radj, upEdges),
  };
}

type DfsFrame = { node: string; next: number };

/** Iterative memoised longest-path lengths along `edges` (1 for a sink). */
function longestFrom(edges: Map<string, string[]>, nodes: string[]): Map<string, number> {
  const memo = new Map<string, number>();
  for (const start of nodes) {
    if (!memo.has(start)) resolveChain(start, edges, memo);
  }
  return memo;
}

/** Post-order DFS from `start`: resolves its longest chain into `memo`. */
function resolveChain(start: string, edges: Map<string, string[]>, memo: Map<string, number>): void {
  const stack: DfsFrame[] = [{ node: start, next: 0 }];
  const inPath = new Set([start]);
  while (stack.length > 0) step(stack, edges, memo, inPath);
}

/** One DFS step: descend into the next unresolved successor, or finish the top node. */
function step(stack: DfsFrame[], edges: Map<string, string[]>, memo: Map<string, number>, inPath: Set<string>): void {
  const top = stack[stack.length - 1];
  const successors = edges.get(top.node) ?? [];
  const next = successors[top.next];
  if (next !== undefined && !inPath.has(next)) {
    top.next += 1;
    if (!memo.has(next)) {
      inPath.add(next);
      stack.push({ node: next, next: 0 });
    }
    return;
  }
  top.next += 1;
  if (top.next <= successors.length) return;
  // All successors resolved (or skipped as back edges): finish the node.
  memo.set(top.node, chainLength(successors, memo));
  inPath.delete(top.node);
  stack.pop();
}

/** `1 +` the longest resolved successor chain (1 when none resolved). */
function chainLength(successors: string[], memo: Map<string, number>): number {
  let best = 1;
  for (const succ of successors) {
    const len = memo.get(succ);
    if (len !== undefined && len + 1 > best) best = len + 1;
  }
  return best;
}

/** The neighbour continuing each node's longest chain, from the length table. */
function argExtremes(edges: Map<string, string[]>, lengths: Map<string, number>): Map<string, string> {
  const args = new Map<string, string>();
  for (const [node, successors] of edges) {
    let best = 1;
    let arg: string | undefined;
    for (const next of successors) {
      const len = lengths.get(next);
      if (len !== undefined && len + 1 > best) {
        best = len + 1;
        arg = next;
      }
    }
    if (arg !== undefined) args.set(node, arg);
  }
  return args;
}

interface StatusPayload {
  agentId: string;
  status: string;
  resultText?: string | null;
  traceId?: string | null;
  abortReason?: string;
  source?: string;
}

/**
 * Attaches chain dispatch to one workspace's trigger host: host runs end
 * through `onRunEnd`, manual runs through the RunManager `'status'`
 * stream (skipping `source: 'trigger'` entries the host already reports).
 * Returns the unsubscribe.
 */
export function attachChainTriggers(deps: {
  host: TriggerHost;
  repo: AgentRepo;
  runManager: RunManager;
  log: TriggerHost['log'];
}): () => void {
  /** `runKey` -> the `chain` its ChainEvent carried, until that run ends. */
  const chainByRunKey = new Map<string, string[]>();
  /** Agents with an in-flight non-trigger run, so a terminal status is handled once. */
  const liveManual = new Set<string>();

  const fire = async (
    agentId: string,
    status: ChainStatus,
    run: { resultText: string | null; traceId: string | null },
    priorChain: string[]
  ): Promise<void> => {
    const chain = [...priorChain, agentId];
    const specs = await loadSpecs(deps.repo);
    for (const target of chainTargets(specs, agentId, status)) {
      const targetId = target.agentId;
      if (chain.includes(targetId)) {
        deps.log(targetId, `Chain from ${agentId} skipped: ${[...chain, targetId].join(' → ')} would loop`);
        continue;
      }
      if (chain.length >= MAX_CHAIN_DEPTH) {
        deps.log(targetId, `Chain from ${agentId} skipped: more than 3 agents in a row`);
        continue;
      }
      const resultText = (run.resultText ?? '').slice(0, RESULT_TEXT_CAP);
      const traceId = run.traceId ?? '';
      const event: ChainEvent = {
        type: 'agent',
        after: agentId,
        run: { status, resultText, traceId },
        chain,
      };
      const input = renderTemplate(target.trigger.promptTemplate, {
        run: { status, resultText, traceId },
        after: agentId,
      });
      const result = deps.host.dispatch({ agentId: targetId, triggerId: target.trigger.id, input, event });
      if (result.ok) {
        chainByRunKey.set(result.runKey, chain);
      } else {
        deps.log(targetId, `Chain from ${agentId} skipped: ${result.reason.replace('_', ' ')}`, 'warn');
      }
    }
  };

  const onRunEnd = (end: RunEnd): void => {
    if (end.cancelled) return;
    const status: ChainStatus = end.status === 'done' ? 'done' : 'error';
    const prior = chainByRunKey.get(end.run.runKey) ?? [];
    chainByRunKey.delete(end.run.runKey);
    void fire(end.run.agentId, status, { resultText: end.resultText, traceId: end.traceId }, prior).catch((error: unknown) =>
      deps.log(end.run.agentId, `Chain dispatch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    );
  };

  const onStatus = (payload: StatusPayload): void => {
    // Host-owned runs already reported through onRunEnd.
    if (payload.source === 'trigger') return;
    if (!TERMINAL.has(payload.status)) {
      if (payload.status === 'idle') liveManual.delete(payload.agentId);
      else liveManual.add(payload.agentId);
      return;
    }
    // A terminal status counts only for a run this listener saw start, so
    // a repeated 'done'/'error' emit cannot chain twice.
    if (!liveManual.delete(payload.agentId)) return;
    const cancelled =
      payload.status === 'stopped' || (payload.status === 'error' && payload.abortReason !== undefined);
    if (cancelled) return;
    const status: ChainStatus = payload.status === 'done' ? 'done' : 'error';
    void fire(payload.agentId, status, { resultText: payload.resultText ?? null, traceId: payload.traceId ?? null }, []).catch(
      (error: unknown) =>
        deps.log(payload.agentId, `Chain dispatch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    );
  };

  const offEnd = deps.host.onRunEnd(onRunEnd);
  deps.runManager.on('status', onStatus);
  return () => {
    offEnd();
    deps.runManager.off('status', onStatus);
  };
}
