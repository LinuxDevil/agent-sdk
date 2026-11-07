import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, SkillRef } from '../../specTypes';
import type { Graph, Problem, SkillNodeData } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: one entry per `SkillRef` form. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
skills:
  - dir: skills/code-review
  - registry: changelog
  - inline:
      name: tone
      description: How we write to customers
      content: "# Tone\\nBe brief and kind."
`;

const WORKED_IDS = ['agent', 'skill:code-review', 'skill:changelog', 'skill:tone'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(skills: SkillRef[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ skills }));
}

function nodeById(graph: Graph, id: string): SkillNodeData {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node.data as SkillNodeData;
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

describe('specToGraph: skill worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the three skill nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each spec entry verbatim as data.item, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const skills = spec.skills ?? [];
    for (const [i, node] of graph.nodes.slice(1).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('skill');
      expect((node.data as { item: unknown }).item).toStrictEqual(skills[i]);
    }
  });

  it('derives a uses edge from the agent to every skill', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    for (const id of WORKED_IDS.slice(1)) {
      expect(ids).toContain(`uses:agent->${id}`);
    }
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('skillRules.validate', () => {
  it.each([
    ['', 'skill:new'],
    ['  ', 'skill:  '],
    ['/abs/skills', 'skill:skills'],
    ['../skills', 'skill:skills'],
    ['a/../skills', 'skill:skills'],
    ['C:\\skills', 'skill:skills'],
    ['a\\b', 'skill:b'],
  ])('rejects the folder path %j', (dir, nodeId) => {
    const graph = graphOf([{ dir }]);
    expect(validateGraph(graph)).toStrictEqual([
      error(nodeId, 'Use a folder inside the agent folder', 'skills[0].dir'),
    ]);
  });

  it.each(['skills/review', 'review', 'a/b/c', 'skills/review/'])('accepts the folder path %j', (dir) => {
    const graph = graphOf([{ dir }]);
    expect(validateGraph(graph)).toStrictEqual([]);
  });

  it('requires a registry name', () => {
    const graph = graphOf([{ registry: '' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('skill:new', 'Pick a registry skill', 'skills[0].registry'),
    ]);
  });

  it.each(['', 'Bad Name', '-leading-dash', 'UPPER'])(
    'rejects the inline name %j',
    (name) => {
      const graph = graphOf([{ inline: { name, description: 'd', content: 'c' } }]);
      const nodeId = name === '' ? 'skill:new' : `skill:${name}`;
      expect(validateGraph(graph)).toStrictEqual([
        error(
          nodeId,
          'The skill name can use lower-case letters, digits, dash or underscore',
          'skills[0].inline.name',
        ),
      ]);
    },
  );

  it('requires an inline description', () => {
    const graph = graphOf([{ inline: { name: 'tone', description: '', content: 'c' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('skill:tone', 'The skill needs a description', 'skills[0].inline.description'),
    ]);
  });

  it('requires inline content', () => {
    const graph = graphOf([{ inline: { name: 'tone', description: 'd', content: '' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('skill:tone', 'The skill needs content', 'skills[0].inline.content'),
    ]);
  });

  it('reports every missing inline field together', () => {
    const graph = graphOf([{ inline: { name: '', description: '', content: '' } }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('skill:new', 'The skill name can use lower-case letters, digits, dash or underscore', 'skills[0].inline.name'),
      error('skill:new', 'The skill needs a description', 'skills[0].inline.description'),
      error('skill:new', 'The skill needs content', 'skills[0].inline.content'),
    ]);
  });

  it('reports two skills of one owner with the same skillNodeName on both nodes', () => {
    const graph = graphOf([
      { inline: { name: 'tone', description: 'd', content: 'c' } },
      { dir: 'skills/tone' },
    ]);
    expect(validateGraph(graph)).toStrictEqual([
      error('skill:tone', "Two skills are named 'tone'", 'skills[0]'),
      error('skill:tone#2', "Two skills are named 'tone'", 'skills[1]'),
    ]);
  });

  it('does not flag same-named skills of different owners', () => {
    const graph = specToGraph(
      specOf({
        skills: [{ registry: 'changelog' }],
        subagents: {
          a: {
            inline: {
              name: 'a',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              skills: [{ registry: 'changelog' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(graph)).toStrictEqual([]);
  });

  it('maps problems to the nested spec path inside an inline agent', () => {
    const graph = specToGraph(
      specOf({
        subagents: {
          a: {
            inline: {
              name: 'a',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              skills: [{ dir: '' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(graph)).toStrictEqual([
      error('sub:a/skill:new', 'Use a folder inside the agent folder', 'subagents.a.inline.skills[0].dir'),
    ]);
  });
});

describe('skillRules.duplicateData', () => {
  it('gives an inline copy a fresh <name>-copy name', () => {
    const g = graphOf([{ inline: { name: 'tone', description: 'd', content: 'c' } }]);
    const first = duplicateNode(g, 'skill:tone');
    expect(first.nodeId).toBe('skill:tone-copy');
    expect(nodeById(first.graph, 'skill:tone-copy').item).toStrictEqual({
      inline: { name: 'tone-copy', description: 'd', content: 'c' },
    });
    const second = duplicateNode(first.graph, 'skill:tone');
    expect(second.nodeId).toBe('skill:tone-copy-2');
  });

  it('keeps a dir copy\'s name, so the duplicate-name error shows on both', () => {
    const g = graphOf([{ dir: 'skills/tone' }]);
    const r = duplicateNode(g, 'skill:tone');
    expect(r.nodeId).toBe('skill:tone#2');
    expect(nodeById(r.graph, 'skill:tone#2').item).toStrictEqual({ dir: 'skills/tone' });
    expect(validateGraph(r.graph)).toStrictEqual([
      error('skill:tone', "Two skills are named 'tone'", 'skills[0]'),
      error('skill:tone#2', "Two skills are named 'tone'", 'skills[1]'),
    ]);
  });
});
