import { describe, expect, it } from 'vitest';
import { CompactedLLMProviderError } from '../execution/errors';
import { mockModel, type MockModel, type MockRequest, type MockStaticTurn, type MockTurn } from '../testing';
import { improveAgent, type Harness, type ImproveOptions, type ProbeRun } from './index';
import { anonymise, selectionSeed } from './select';

const BASE: Harness = { instructions: 'You answer questions.', skills: {} };
const FIX = 'You answer questions. If a document is forbidden, say so and stop.';
const LONG = `${FIX} Explain why.`;

const write = (content: string): MockStaticTurn => ({ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content } }] });
const edit = (content: string): MockTurn[] => [write(content), '<notes>Traced to a failed run.</notes>'];
const noEdit: MockTurn[] = ['<notes>KEEP_BASE.</notes>'];

const systemOf = (request: MockRequest) => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const stageOf = (request: MockRequest): string => {
  const system = systemOf(request);
  if (system.includes('You are choosing which of')) return 'select';
  const checkpoint = /composing checkpoint (\d+) of \d+/.exec(system)?.[1];
  if (checkpoint) return `compose-${checkpoint}`;
  if (system.includes('You are the composer.')) return 'compose';
  const scope = system.includes('earliest point of divergence') ? 'invariant' : 'domain';
  const round = /(?:This is round|You are candidate) (\d+) of \d+/.exec(system)?.[1];
  return round ? `${scope}-${round}` : scope;
};

const editors = (script: Record<string, MockTurn[]>): MockModel => {
  const queues = Object.fromEntries(Object.entries(script).map(([stage, turns]) => [stage, [...turns]]));
  const count = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
  const next: MockTurn = (request) => {
    const turn = queues[stageOf(request)]?.shift();
    if (turn === undefined) throw new Error(`No turn left for the ${stageOf(request)} session.`);
    return typeof turn === 'function' ? turn(request) : turn;
  };
  return mockModel(Array.from({ length: count }, () => next));
};

const probe: ImproveOptions['probe'] = async (harness, caseId): Promise<ProbeRun> => {
  const { instructions } = harness;
  const passed = caseId === 'held-out' ? !instructions.includes('Always') : instructions.includes('forbidden');
  const answer = caseId === 'held-out' ? 'HELD-OUT ANSWER' : instructions.includes('Always') ? 'REJECTED ANSWER' : `Answer under: ${instructions}`;
  return { passed, transcript: `user: hi\nassistant: ${answer}`, answer, tokens: instructions.includes('Explain') ? 12 : 10, ended: 'stop' };
};

const options = (over: Partial<ImproveOptions> = {}): ImproveOptions => ({
  harness: BASE,
  cases: ['stuck'],
  holdout: ['held-out'],
  probe,
  editor: { provider: mockModel([]) },
  repeats: 2,
  select: true,
  ...over,
});

const readAll: MockStaticTurn = { toolCalls: ['A', 'B', 'C'].map((id) => ({ name: 'read_file', args: { path: `context/candidates/${id}.md` } })) };
const idOf = (label: string, labels: readonly string[]) => [...anonymise(labels, selectionSeed(options()))].find(([, entry]) => entry === label)?.[0] ?? '';
const choose = (id: string, why = 'Delivery decided it.'): MockStaticTurn => `<why>${why}</why>\n\`\`\`choice\n${id}\n\`\`\``;

describe('advisory selector', () => {
  it('with one passer no selector runs', async () => {
    const provider = editors({ invariant: noEdit, domain: edit(`${FIX} Always.`), compose: edit(FIX) });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.harness?.instructions).toBe(FIX);
    expect(result).not.toHaveProperty('selection');
    expect(provider.calls.map(stageOf)).not.toContain('select');
    expect(result.gate?.map((verdict) => [verdict.label, verdict.passed])).toEqual([
      ['compose', true],
      ['domain', false],
      ['invariant', false],
    ]);
  });

  it('labels are shuffled deterministically', () => {
    const labels = ['compose', 'domain', 'invariant', 'invariant-2'];
    const first = anonymise(labels, 'cycle-1');
    expect(anonymise([...labels].reverse(), 'cycle-1')).toEqual(first);
    expect([...first.keys()]).toEqual(['A', 'B', 'C', 'D']);
    expect([...first.values()].sort()).toEqual([...labels].sort());
    const orders = new Set(Array.from({ length: 8 }, (_, i) => [...anonymise(labels, `cycle-${i}`).values()].join()));
    expect(orders.size).toBeGreaterThan(1);
    expect(selectionSeed(options())).toBe(selectionSeed(options()));
    expect(selectionSeed(options({ cases: ['other'] }))).not.toBe(selectionSeed(options()));
  });

  it('keeps the harness the selector chose among those that passed, with its plain-text reason', async () => {
    const labels = ['compose', 'domain'];
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [choose(idOf('compose', labels), 'See [the docs](https://x.example) <b>now</b>.')] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.harness?.instructions).toBe(LONG);
    expect(result.selection).toEqual({ chosen: 'compose', why: 'See the docs now.', fallback: false });
    expect(result.reason).toMatch(/2 harnesses passed the gate; the advisory selector chose compose\.$/);
    expect(result.gate?.filter((verdict) => verdict.passed).map((verdict) => verdict.label)).toEqual(['compose', 'domain']);
  });

  it('an invalid choice falls back to the cheapest', async () => {
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [choose('Z')] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.harness?.instructions).toBe(FIX);
    expect(result.selection).toMatchObject({ chosen: 'domain', fallback: true });
    expect(result.selection?.why).toMatch(/no valid choice/);
  });

  it('a selector failure falls back to the cheapest', async () => {
    const failing: MockTurn = () => {
      throw new Error('selector crashed');
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [failing] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.harness?.instructions).toBe(FIX);
    expect(result.selection).toMatchObject({ chosen: 'domain', fallback: true });
  });

  it('the selector never sees a rejected harness or a held-out case', async () => {
    let saw = '';
    const capture: MockTurn = (request) => {
      saw = JSON.stringify(request.messages);
      return choose('A');
    };
    const provider = editors({ 'invariant-1': edit(`${FIX} Always.`), 'domain-1': edit(FIX), 'invariant-2': noEdit, 'domain-2': noEdit, compose: edit(LONG), select: [readAll, capture] });
    const result = await improveAgent(options({ proposers: 2, editor: { provider } }));
    expect(result.gate?.find((verdict) => verdict.label === 'invariant-1')?.passed).toBe(false);
    expect(saw).toContain('Answer under:');
    expect(saw).not.toContain('REJECTED ANSWER');
    expect(saw).not.toContain('HELD-OUT ANSWER');
    expect(saw).not.toContain('held-out');
    expect(saw).not.toMatch(/compose|domain-1|invariant/);
  });

  it('with select off, the result is unchanged', async () => {
    const script = () => editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG) });
    const plain = await improveAgent(options({ select: undefined, editor: { provider: script() } }));
    const off = await improveAgent(options({ select: false, editor: { provider: script() } }));
    expect(off).toEqual(plain);
    expect(plain.reason).toBe('A training case improved by at least 2 in 3 runs, none got worse, and no held-out case got worse. Cost per passing run went from 10 to 12 tokens (noise 0).');
    expect(plain.harness?.instructions).toBe(LONG);
    expect(plain.gate).toEqual([{ label: 'compose', passed: true, reason: plain.reason }]);
    expect(plain).not.toHaveProperty('selection');
  });

  it('chooses among seq checkpoints that passed', async () => {
    const labels = ['compose-1', 'compose-2'];
    const provider = editors({
      'invariant-1': noEdit,
      'domain-1': noEdit,
      'compose-1': edit(FIX),
      'invariant-2': noEdit,
      'domain-2': noEdit,
      'compose-2': edit(LONG),
      select: [choose(idOf('compose-2', labels))],
    });
    const result = await improveAgent(options({ mode: 'seq', proposers: 2, editor: { provider } }));
    expect(result.harness?.instructions).toBe(LONG);
    expect(result.selection).toMatchObject({ chosen: 'compose-2', fallback: false });
  });

  it('falls back on a provider outage during selection', async () => {
    const outage: MockTurn = () => {
      throw new CompactedLLMProviderError({ error: 'down', category: 'unknown', retryable: true, statusCode: 503 });
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [outage] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.outcome).toBe('proposal');
    expect(result.selection).toMatchObject({ chosen: 'domain', fallback: true });
  });

  it('stops rather than falling back when aborted during selection', async () => {
    const controller = new AbortController();
    const abort: MockTurn = () => {
      controller.abort();
      return choose('A');
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [abort] });
    await expect(improveAgent(options({ signal: controller.signal, editor: { provider } }))).rejects.toThrow();
  });

  it('accepts a lower-case choice, and says so when no reason was given', async () => {
    const labels = ['compose', 'domain'];
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [`\`\`\`choice\n${idOf('compose', labels).toLowerCase()}\n\`\`\``] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.selection).toEqual({ chosen: 'compose', why: 'The selector gave no reason.', fallback: false });
  });

  it('shows the last assistant answer of a transcript, without tool calls, and leaves out unscored runs', async () => {
    let saw = '';
    const capture: MockTurn = (request) => {
      saw = JSON.stringify(request.messages);
      return choose('A');
    };
    const transcriptOnly: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
      const scored = await probe(harness, caseId, repeat);
      if (caseId === 'stuck' && repeat === 1 && harness.instructions === FIX) return { ...scored, passed: null, answer: undefined, transcript: 'assistant: UNSCORED RUN' };
      return { ...scored, answer: undefined, transcript: `user: hi\nassistant: thinking\ncall load_skill {"name":"secret-skill"}\nassistant: FINAL ${harness.instructions.length}` };
    };
    const provider = editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [readAll, capture] });
    await improveAgent(options({ probe: transcriptOnly, repeats: 3, editor: { provider } }));
    expect(saw).toContain(`FINAL ${FIX.length}`);
    expect(saw).not.toContain('secret-skill');
    expect(saw).not.toContain('thinking');
    expect(saw).not.toContain('UNSCORED RUN');
  });

  it("counts the selector's tokens toward maxTokens, and stops rather than falling back", async () => {
    const script = () => editors({ invariant: noEdit, domain: edit(FIX), compose: edit(LONG), select: [choose('A')] });
    const full = await improveAgent(options({ editor: { provider: script() } }));
    const result = await improveAgent(options({ maxTokens: full.spend.tokens - 1, editor: { provider: script() } }));
    expect(result.outcome).toBe('budget-exceeded');
    expect(result).not.toHaveProperty('selection');
  });

  it("itemises the chosen harness with its own editor's reasons", async () => {
    const labels = ['compose', 'domain'];
    const domainEdit = [write(FIX), '<notes>reason: instructions: "is forbidden": domain saw it.</notes>'];
    const provider = editors({ invariant: noEdit, domain: domainEdit, compose: edit(LONG), select: [choose(idOf('domain', labels))] });
    const result = await improveAgent(options({ editor: { provider } }));
    expect(result.changes?.[0].reason).toBe('domain saw it.');
  });
});
