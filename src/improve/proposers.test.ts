import { describe, expect, it } from 'vitest';
import { mockModel, type MockModel, type MockRequest, type MockTurn } from '../testing';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';
import { COMPOSE_PROMPT, DOMAIN_PROMPT, INVARIANT_PROMPT } from './prompts';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';

const write = (path: string, content: string): MockTurn => ({ toolCalls: [{ name: 'write_file', args: { path, content } }] });
const edit = (content: string): MockTurn[] => [write('harness/instructions.md', content), '<notes>Traced to a failed run.</notes>'];
const noEdit: MockTurn[] = ['<notes>KEEP_BASE. Nothing in the runs argues for a change.</notes>'];
const run = (passed: boolean | null, tokens = 10): ProbeRun => ({ passed, transcript: `user: hi\nassistant: ${passed}`, tokens, ended: 'stop' });

const systemOf = (request: MockRequest) => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const stageOf = (request: MockRequest): string => {
  const system = systemOf(request);
  if (system.includes('You are the composer.')) return 'compose';
  const scope = system.includes('earliest point of divergence') ? 'invariant' : 'domain';
  const index = /You are candidate (\d+) of \d+/.exec(system)?.[1];
  return index ? `${scope}-${index}` : scope;
};

const editors = (script: Record<string, MockTurn[]>): MockModel => {
  const queues = Object.fromEntries(Object.entries(script).map(([stage, turns]) => [stage, [...turns]]));
  const count = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
  const next: MockTurn = (request) => {
    const turn = queues[stageOf(request)]?.shift();
    if (turn === undefined) throw new Error(`No turn left for the ${stageOf(request)} editor.`);
    return typeof turn === 'function' ? turn(request) : turn;
  };
  return mockModel(Array.from({ length: count }, () => next));
};

const gated =
  (tokens: (harness: Harness) => number = () => 10): ImproveOptions['probe'] =>
  async (harness, caseId) => {
    if (caseId !== 'held-out') return run(harness.instructions.includes('forbidden'), tokens(harness));
    return run(!harness.instructions.includes('Always'), tokens(harness));
  };

const options = (over: Partial<ImproveOptions> = {}): ImproveOptions => ({
  harness: BASE,
  cases: ['stuck'],
  holdout: ['held-out'],
  probe: gated(),
  editor: { provider: mockModel([]) },
  repeats: 2,
  ...over,
});

describe('improveAgent with several proposers', () => {
  it('k=2 runs four editors and one composer, which sees every candidate', async () => {
    let composerSaw = '';
    const listCandidates: MockTurn = { toolCalls: [{ name: 'list_dir', args: { path: 'context/candidates' } }] };
    const capture: MockTurn = (request) => {
      composerSaw = JSON.stringify(request.messages);
      return { toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content: FIX } }] };
    };
    const provider = editors({
      'invariant-1': noEdit,
      'domain-1': edit(FIX),
      'invariant-2': edit(`${FIX} Be brief.`),
      'domain-2': noEdit,
      compose: [listCandidates, capture, '<notes>kept: stop rule: helped: stuck</notes>'],
    });
    const result = await improveAgent(options({ proposers: 2, editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.stages.map((stage) => stage.label)).toEqual(['invariant-1', 'domain-1', 'invariant-2', 'domain-2', 'compose']);
    for (const label of ['invariant-1', 'domain-1', 'invariant-2', 'domain-2']) expect(composerSaw).toContain(`${label}/`);
    expect(Object.keys(result.candidates?.pool ?? {})).toEqual(['invariant-1', 'domain-1', 'invariant-2', 'domain-2']);
    expect(result.candidates?.pool?.['invariant-2'].instructions).toBe(`${FIX} Be brief.`);
    expect(result.candidates?.invariant).toEqual(BASE);
    expect(result.candidates?.domain.instructions).toBe(FIX);
  });

  it('tells each proposer which of k it is, and the composer how many proposals there are', async () => {
    const provider = editors({ 'invariant-1': noEdit, 'domain-1': noEdit, 'invariant-2': noEdit, 'domain-2': noEdit, compose: noEdit });
    await improveAgent(options({ proposers: 2, editor: { provider } }));
    const systems = provider.calls.map(systemOf);
    expect(systems.filter((system) => system.includes('You are candidate 2 of 2'))).toHaveLength(2);
    expect(systems.find((system) => system.includes('You are the composer.'))).toContain('There are 4 proposals, 2 from invariant editors and 2 from domain editors');
  });

  it('probes only the proposals that differ from the base', async () => {
    const probed: string[] = [];
    const probe: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
      if (caseId === 'stuck') probed.push(harness.instructions);
      return gated()(harness, caseId, repeat);
    };
    const provider = editors({ 'invariant-1': noEdit, 'domain-1': edit(FIX), 'invariant-2': noEdit, 'domain-2': noEdit, compose: noEdit });
    const result = await improveAgent(options({ proposers: 2, probe, editor: { provider } }));
    expect(result.outcome).toBe('keep-base');
    expect(probed.filter((instructions) => instructions === FIX)).toHaveLength(2);
  });

  it('identical proposals give distinct=1, meanJaccard=1', async () => {
    const provider = editors({ 'invariant-1': edit(FIX), 'domain-1': edit(FIX), 'invariant-2': edit(FIX), 'domain-2': edit(FIX), compose: noEdit });
    const result = await improveAgent(options({ proposers: 2, editor: { provider } }));
    expect(result.diversity).toEqual({ meanJaccard: 1, distinct: 1 });
  });

  it('measures how far apart the proposals are, line by line', async () => {
    const provider = editors({ 'invariant-1': edit('A\nB'), 'domain-1': edit('A\nC'), 'invariant-2': noEdit, 'domain-2': noEdit, compose: noEdit });
    const result = await improveAgent(options({ proposers: 2, editor: { provider } }));
    expect(result.diversity?.distinct).toBe(3);
    expect(result.diversity?.meanJaccard).toBeCloseTo((1 / 3 + 0 + 0 + 0 + 0 + 1) / 6, 4);
  });

  it('fallback considers every pool member, cheapest first', async () => {
    const tokens = (harness: Harness) => (harness.instructions.includes('Costly') ? 14 : harness.instructions.includes('Mid') ? 12 : 10);
    const heldOut: string[] = [];
    const probe: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
      if (caseId === 'held-out') heldOut.push(harness.instructions);
      return gated(tokens)(harness, caseId, repeat);
    };
    const provider = editors({
      'invariant-1': edit(`${FIX} Costly.`),
      'domain-1': edit(`${FIX} Always a.`),
      'invariant-2': edit(`${FIX} Mid.`),
      'domain-2': edit(`${FIX} Always a.`),
      compose: edit(`${FIX} Always b.`),
    });
    const result = await improveAgent(options({ proposers: 2, probe, editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.harness?.instructions).toBe(`${FIX} Mid.`);
    expect(result.reason).toMatch(/The invariant-2 editor's harness passed instead/);
    expect(result.gate).toEqual([
      { label: 'compose', passed: false, reason: expect.stringMatching(/held-out/) },
      { label: 'domain-1', passed: false, reason: expect.stringMatching(/held-out/) },
      { label: 'invariant-2', passed: true, reason: expect.any(String) },
      { label: 'domain-2', passed: false, reason: "Same as the domain-1 editor's harness, so it was not judged again." },
    ]);
    expect(heldOut).not.toContain(`${FIX} Costly.`);
  });

  it('k=1 output is unchanged', async () => {
    const script = () => editors({ invariant: noEdit, domain: edit(FIX), compose: edit(FIX) });
    const plain = await improveAgent(options({ editor: { provider: script() } }));
    expect(plain).toMatchInlineSnapshot(`
      {
        "base": {
          "excluded": 0,
          "noise": 0,
          "passRate": 0,
          "runs": 2,
          "tokensPerRun": 10,
        },
        "candidates": {
          "compose": {
            "instructions": "You answer questions. If a document is forbidden, say so and stop.",
            "skills": {},
          },
          "domain": {
            "instructions": "You answer questions. If a document is forbidden, say so and stop.",
            "skills": {},
          },
          "invariant": {
            "instructions": "You answer questions.",
            "skills": {},
          },
        },
        "cases": [
          {
            "base": {
              "passed": 0,
              "scored": 2,
            },
            "caseId": "stuck",
            "final": {
              "passed": 2,
              "scored": 2,
            },
            "reasons": [
              "Improved from 0/2 to 2/2.",
            ],
            "role": "training",
          },
          {
            "base": {
              "passed": 2,
              "scored": 2,
            },
            "caseId": "held-out",
            "final": {
              "passed": 2,
              "scored": 2,
            },
            "reasons": [
              "Held: 2/2 before, 2/2 after.",
            ],
            "role": "holdout",
          },
        ],
        "changes": [
          {
            "after": "You answer questions. If a document is forbidden, say so and stop.",
            "before": "You answer questions.",
            "kind": "modify",
            "target": "instructions",
          },
        ],
        "costOnPassingCases": {
          "base": 10,
          "cases": 1,
          "final": 10,
          "noise": 0,
        },
        "diff": "instructions.md
      - You answer questions.
      + You answer questions. If a document is forbidden, say so and stop.",
        "final": {
          "excluded": 0,
          "noise": 0,
          "passRate": 1,
          "runs": 2,
          "tokensPerRun": 10,
        },
        "freshBase": {
          "excluded": 0,
          "noise": 0,
          "passRate": 0,
          "runs": 2,
          "tokensPerRun": 10,
        },
        "gate": [
          {
            "label": "compose",
            "passed": true,
            "reason": "A training case improved by at least 2 in 3 runs, none got worse, and no held-out case got worse. Cost per passing run went from 10 to 10 tokens (noise 0).",
          },
        ],
        "harness": {
          "instructions": "You answer questions. If a document is forbidden, say so and stop.",
          "skills": {},
        },
        "holdout": {
          "base": {
            "excluded": 0,
            "noise": 0,
            "passRate": 1,
            "runs": 2,
            "tokensPerRun": 10,
          },
          "final": {
            "excluded": 0,
            "noise": 0,
            "passRate": 1,
            "runs": 2,
            "tokensPerRun": 10,
          },
        },
        "ledger": {
          "cached": 0,
          "excluded": 0,
          "planned": 12,
          "run": 12,
        },
        "outcome": "proposal",
        "reason": "A training case improved by at least 2 in 3 runs, none got worse, and no held-out case got worse. Cost per passing run went from 10 to 10 tokens (noise 0).",
        "spend": {
          "tokens": 4502,
        },
        "stages": [
          {
            "label": "invariant",
            "notes": "KEEP_BASE. Nothing in the runs argues for a change.",
            "status": "no-change",
            "tokens": 792,
          },
          {
            "label": "domain",
            "notes": "Traced to a failed run.",
            "status": "edited",
            "tokens": 1628,
          },
          {
            "label": "compose",
            "notes": "Traced to a failed run.",
            "status": "edited",
            "tokens": 1962,
          },
        ],
      }
    `);
    const one = await improveAgent(options({ proposers: 1, editor: { provider: script() } }));
    expect(one).toEqual(plain);
    expect(plain).not.toHaveProperty('diversity');
    expect(plain.candidates).not.toHaveProperty('pool');
  });

  it('k=1 gives the editors the same prompts as before', async () => {
    const provider = editors({ invariant: noEdit, domain: noEdit, compose: noEdit });
    await improveAgent(options({ editor: { provider } }));
    expect(provider.calls.map(systemOf)).toEqual([INVARIANT_PROMPT, DOMAIN_PROMPT, COMPOSE_PROMPT]);
  });

  it('stops with budget-exceeded among the proposers, keeping only the stages that started', async () => {
    const provider = editors({ 'invariant-1': edit(FIX), 'domain-1': edit(FIX), 'invariant-2': edit(FIX), 'domain-2': edit(FIX), compose: noEdit });
    const result = await improveAgent(options({ proposers: 2, parallelEditors: false, maxTokens: 2500, editor: { provider } }));
    expect(result.outcome).toBe('budget-exceeded');
    expect(result.stages.length).toBeLessThan(4);
    expect(result).not.toHaveProperty('candidates');
    expect(result).not.toHaveProperty('diversity');
  });

  it('runs the proposers one at a time, in order, when parallelEditors is false', async () => {
    const provider = editors({ 'invariant-1': noEdit, 'domain-1': noEdit, 'invariant-2': noEdit, 'domain-2': noEdit, compose: noEdit });
    await improveAgent(options({ proposers: 2, parallelEditors: false, editor: { provider } }));
    expect(provider.calls.map(stageOf)).toEqual(['invariant-1', 'domain-1', 'invariant-2', 'domain-2', 'compose']);
  });

  it.each([0, 5, 1.5])('rejects proposers=%s', async (proposers) => {
    await expect(improveAgent(options({ proposers }))).rejects.toThrow(/proposers must be a whole number from 1 to 4/);
  });
});
