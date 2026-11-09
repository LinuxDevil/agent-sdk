import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { connectNodes, duplicateNode, removeNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, TriggerSpec } from '../../specTypes';
import type { AbortNodeData, Graph, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';
import { ABORT_VIEW } from '../../../../canvas/kinds/abort';

/** The ticket's worked example: a webhook trigger and the listener that cancels its runs. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
triggers:
  - { id: t3, type: webhook, path: /hooks/github, promptTemplate: 'Review {{event.pr}}' }
abortListeners:
  - { id: a1, triggerId: t3, when: "event.action == 'closed'", match: 'event.pr == run.event.pr', scope: both }
`;

const WEBHOOK: TriggerSpec = { id: 't3', type: 'webhook', path: '/hooks/github', promptTemplate: 'x' };
const CRON: TriggerSpec = { id: 't2', type: 'cron', cron: '0 9 * * *', prompt: 'go' };
const CHANNEL: TriggerSpec = {
  id: 't4',
  type: 'channel',
  channel: 'slack',
  secrets: { signingSecret: { secret: 's' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
};

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(
  abortListeners: Record<string, unknown>[],
  triggers: TriggerSpec[] = [WEBHOOK],
  over: Record<string, unknown> = {}
): Graph {
  return specToGraph(specOf({ triggers, abortListeners, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

const abortNode = (graph: Graph, id = 'abort:a1') =>
  graph.nodes.find((n) => n.id === id) as Extract<Graph['nodes'][number], { kind: 'abort' }>;

describe('specToGraph: abort listener worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec);

  it('produces the trigger and abort nodes with abort:<id>, owned by the root agent', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(['agent', 'trigger:t3', 'abort:a1']);
    const abort = graph.nodes[2];
    expect(abort.kind).toBe('abort');
    expect(abort.owner).toBe('agent');
    expect((abort.data as AbortNodeData).item).toStrictEqual(
      (spec as unknown as { abortListeners: unknown[] }).abortListeners[0]
    );
  });

  it('derives the starts and cancels edges', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('starts:trigger:t3->agent');
    expect(ids).toContain('cancels:trigger:t3->abort:a1');
  });

  it('round-trips to an identical spec', () => {
    expect(graphToSpec(graph).spec).toStrictEqual(spec);
  });

  it('gives the card its title, scope chip, rows and in-only ports', () => {
    const node = abortNode(graph);
    expect(ABORT_VIEW.title(node, graph)).toBe('Cancel on Webhook');
    expect(ABORT_VIEW.chip?.(node)).toBe('queued + running');
    expect(ABORT_VIEW.rows(node)).toEqual([
      { k: 'when', v: "event.action == 'closed'" },
      { k: 'match', v: 'event.pr == run.event.pr' },
    ]);
    expect(ABORT_VIEW.ports).toStrictEqual({ in: true, out: false });
  });

  it('clips the rows to their first line and 40 characters and drops empty ones', () => {
    const long = 'x'.repeat(41);
    const g = graphOf([{ id: 'a1', triggerId: 't3', when: `first\nsecond`, match: long, scope: 'both' }]);
    expect(ABORT_VIEW.rows(abortNode(g))).toEqual([
      { k: 'when', v: 'first' },
      { k: 'match', v: `${'x'.repeat(39)}…` },
    ]);
    const exact = graphOf([{ id: 'a1', triggerId: 't3', when: 'y'.repeat(40), match: '', scope: 'both' }]);
    expect(ABORT_VIEW.rows(abortNode(exact))).toEqual([{ k: 'when', v: 'y'.repeat(40) }]);
  });

  it('titles (no trigger) while triggerId names no trigger node', () => {
    const g = graphOf([{ id: 'a1', triggerId: '', when: 'w', match: 'm', scope: 'both' }]);
    expect(ABORT_VIEW.title(abortNode(g), g)).toBe('Cancel on (no trigger)');
    const orphan = graphOf([{ id: 'a1', triggerId: 'gone', when: 'w', match: 'm', scope: 'both' }]);
    expect(ABORT_VIEW.title(abortNode(orphan), orphan)).toBe('Cancel on (no trigger)');
  });
});

describe('connectNodes: trigger → abort', () => {
  const listener = { id: 'a1', triggerId: 't3', when: 'w', match: 'm', scope: 'both' };

  it('rewires triggerId to the dragged channel trigger', () => {
    const g = graphOf([listener], [WEBHOOK, CHANNEL]);
    const result = connectNodes(g, 'trigger:t4', 'abort:a1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((abortNode(result.graph).data as AbortNodeData).item.triggerId).toBe('t4');
      const ids = deriveEdges(result.graph).map((e) => e.id);
      expect(ids).toContain('cancels:trigger:t4->abort:a1');
      expect(ids).not.toContain('cancels:trigger:t3->abort:a1');
    }
  });

  it('refuses a cron trigger with the webhook/channel reason', () => {
    const g = graphOf([listener], [WEBHOOK, CRON]);
    expect(connectNodes(g, 'trigger:t2', 'abort:a1')).toEqual({
      ok: false,
      reason: 'Abort listeners work with webhook and channel triggers',
    });
  });

  it('refuses re-dragging the trigger already watched', () => {
    const g = graphOf([listener], [WEBHOOK, CHANNEL]);
    expect(connectNodes(g, 'trigger:t3', 'abort:a1')).toEqual({
      ok: false,
      reason: 'This listener already watches this trigger',
    });
  });
});

describe('abortRules.validate', () => {
  const valid = { id: 'a1', triggerId: 't3', when: 'w', match: 'm', scope: 'both' };

  it('accepts a listener watching a webhook trigger', () => {
    expect(validateGraph(graphOf([valid]))).toStrictEqual([]);
  });

  it('flags an empty triggerId', () => {
    const g = graphOf([{ ...valid, triggerId: ' ' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', 'Pick the trigger this listener watches', 'abortListeners[0].triggerId'),
    ]);
  });

  it('flags a triggerId with no trigger node', () => {
    const g = graphOf([{ ...valid, triggerId: 'nope' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', "There is no trigger 'nope'", 'abortListeners[0].triggerId'),
    ]);
  });

  it('flags a triggerId naming a cron trigger', () => {
    const g = graphOf([{ ...valid, triggerId: 't2' }], [WEBHOOK, CRON]);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', 'Abort listeners work with webhook and channel triggers', 'abortListeners[0].triggerId'),
    ]);
  });

  it('flags empty when and match expressions', () => {
    const g = graphOf([{ ...valid, when: '', match: ' ' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', 'Write when an event should cancel runs', 'abortListeners[0].when'),
      error('abort:a1', 'Write how to match the run to cancel', 'abortListeners[0].match'),
    ]);
  });

  it.each(['', 'has space', 'a'.repeat(65)])('rejects the id %j', (id) => {
    const g = graphOf([{ ...valid, id }]);
    expect(validateGraph(g)).toStrictEqual([
      error(`abort:${id}`, 'The id can use letters, digits, dash or underscore', 'abortListeners[0].id'),
    ]);
  });

  it('leaves the listener with the no-trigger error when its trigger is removed', () => {
    const g = removeNode(graphOf([valid], [WEBHOOK, CHANNEL]), 'trigger:t3');
    // No cascade delete: the listener stays and reports the missing trigger.
    expect(g.nodes.some((n) => n.id === 'abort:a1')).toBe(true);
    expect(validateGraph(g)).toStrictEqual([
      error('abort:a1', "There is no trigger 't3'", 'abortListeners[0].triggerId'),
    ]);
  });
});

describe('abortRules.duplicateData', () => {
  it('gives the copy the next free a-item id and keeps its trigger', () => {
    const g = graphOf(
      [
        { id: 'a1', triggerId: 't3', when: 'w', match: 'm', scope: 'queued' },
        { id: 'a2', triggerId: 't3', when: 'x', match: 'y', scope: 'running' },
      ],
      [WEBHOOK]
    );
    const dup = duplicateNode(g, 'abort:a2');
    expect(dup.nodeId).toBe('abort:a3');
    expect((dup.graph.nodes.find((n) => n.id === 'abort:a3')!.data as AbortNodeData).item).toStrictEqual({
      id: 'a3',
      triggerId: 't3',
      when: 'x',
      match: 'y',
      scope: 'running',
    });
  });
});
