/**
 * LOU-X5: `spec.policy` is validated and compiled into createAgent options.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { agentSpecSchema, type AgentSpec } from './schema';
import { compilePolicy, summarizePolicy } from './policy';
import { specToAgent } from './specToAgent';
import { LLMProviderRegistry } from '../providers/llm';
import { mockModel, type MockModel } from '../testing';

const base = { name: 'bot', prompt: 'hi', provider: { type: 'mock', model: 'm' } };

function policyIssues(policy: unknown): string[] {
  const result = agentSpecSchema.safeParse({ ...base, policy });
  if (result.success) throw new Error('expected validation to fail');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const accepted = (policy: unknown) => agentSpecSchema.parse({ ...base, policy }).policy;

describe('AgentSpec.policy schema (LOU-X5)', () => {
  it('accepts every known field and keeps unknown keys', () => {
    const policy = {
      requiresApproval: ['send_email'],
      guardrails: ['secret-scan', { name: 'deny-topics', topics: ['weapons'], on: ['input', 'output'] }],
      limits: { maxTokens: 1000, maxCostUsd: 0.5, maxDurationMs: 30_000, maxSteps: 6 },
      askQuestion: true,
      compaction: { thresholdPercent: 0.7 },
      harness: 'codex',
    };
    expect(accepted(policy)).toEqual(policy);
    expect(accepted({})).toEqual({});
  });

  it.each([true, false, ['a', 'b']])('requiresApproval accepts %j', (value) => {
    expect(accepted({ requiresApproval: value })).toEqual({ requiresApproval: value });
  });

  it.each(['yes', [1], ['']])('requiresApproval rejects %j', (value) => {
    expect(policyIssues({ requiresApproval: value })[0]).toMatch(/^policy\.requiresApproval/);
  });

  it('accepts each built-in guardrail by name or with options', () => {
    const guardrails = [
      'max-length',
      { name: 'max-length', maxChars: 500 },
      'secret-scan',
      { name: 'secret-scan', action: 'rewrite', replacement: 'xxx' },
      { name: 'regex', pattern: '\\d{3}-\\d{2}-\\d{4}', flags: 'i', action: 'rewrite' },
      { name: 'deny-topics', topics: ['a'] },
      { name: 'llm-judge', model: 'openai/gpt-4o-mini', instruction: 'Be nice.' },
      'pii',
      { name: 'pii', types: ['email', 'us-ssn'], action: 'rewrite' },
      'secrets',
      { name: 'secrets', action: 'block', extraPatterns: ['INTERNAL-\\d{6}'] },
      'prompt-injection',
      { name: 'prompt-injection', model: 'openai/gpt-4o-mini' },
      { name: 'moderation', model: 'openai/gpt-4o-mini', categories: ['violence', 'self-harm'] },
    ];
    expect(accepted({ guardrails })).toEqual({ guardrails });
  });

  it('rejects bad options of the starter-set guardrails (N5a)', () => {
    expect(policyIssues({ guardrails: [{ name: 'pii', types: ['passport'] }] })[0]).toMatch(/guardrail 'pii' option 'types\.0'/);
    expect(policyIssues({ guardrails: [{ name: 'pii', types: [] }] })[0]).toMatch(/guardrail 'pii' option 'types'/);
    expect(policyIssues({ guardrails: [{ name: 'pii', replacement: 'x' }] })[0]).toMatch(/guardrail 'pii': Unrecognized key/);
    expect(policyIssues({ guardrails: [{ name: 'secrets', extraPatterns: ['('] }] })[0]).toMatch(/extraPatterns has an invalid regular expression/);
    expect(policyIssues({ guardrails: ['moderation'] })[0]).toMatch(/guardrail 'moderation' option 'model'/);
    expect(policyIssues({ guardrails: [{ name: 'moderation', model: 'm', categories: ['spam'] }] })[0]).toMatch(/option 'categories\.0'/);
    expect(policyIssues({ guardrails: [{ name: 'prompt-injection', model: '' }] })[0]).toMatch(/guardrail 'prompt-injection' option 'model'/);
  });

  it('rejects an unknown guardrail name with did-you-mean and the available names', () => {
    const [issue] = policyIssues({ guardrails: ['deny-topic'] });
    expect(issue).toContain('policy.guardrails.0: ');
    expect(issue).toContain("unknown guardrail 'deny-topic' (did you mean 'deny-topics'?)");
    expect(issue).toContain('Available: max-length, secret-scan, regex, deny-topics, llm-judge');
    expect(policyIssues({ guardrails: [{ name: 'zzz' }] })[0]).not.toContain('did you mean');
  });

  it('rejects bad guardrail options, naming the guardrail and option', () => {
    expect(policyIssues({ guardrails: ['regex'] })[0]).toMatch(/guardrail 'regex' option 'pattern': Required/);
    expect(policyIssues({ guardrails: [{ name: 'regex', pattern: '(' }] })[0]).toMatch(/not a valid regular expression/);
    expect(policyIssues({ guardrails: ['deny-topics'] })[0]).toMatch(/guardrail 'deny-topics' option 'topics'/);
    expect(policyIssues({ guardrails: [{ name: 'deny-topics', topics: [] }] })[0]).toMatch(/option 'topics'/);
    expect(policyIssues({ guardrails: ['llm-judge'] })[0]).toMatch(/guardrail 'llm-judge' option 'model'/);
    expect(policyIssues({ guardrails: [{ name: 'max-length', maxChar: 5 }] })[0]).toMatch(/guardrail 'max-length': Unrecognized key/);
    expect(policyIssues({ guardrails: [{ name: 'max-length', maxChars: -1 }] })[0]).toMatch(/option 'maxChars'/);
    expect(policyIssues({ guardrails: [{ name: 'secret-scan', on: 'everywhere' }] })[0]).toMatch(/option 'on'/);
    expect(policyIssues({ guardrails: [3] })[0]).toMatch(/must be a name or an object with a 'name'/);
    expect(policyIssues({ guardrails: 'secret-scan' })[0]).toMatch(/policy\.guardrails/);
  });

  it('validates limits', () => {
    expect(policyIssues({ limits: { maxTokens: 0 } })[0]).toMatch(/^policy\.limits\.maxTokens/);
    expect(policyIssues({ limits: { maxSteps: 1.5 } })[0]).toMatch(/^policy\.limits\.maxSteps/);
    expect(policyIssues({ limits: { maxCostUsd: 'cheap' } })[0]).toMatch(/^policy\.limits\.maxCostUsd/);
    expect(policyIssues({ limits: { maxToken: 5 } })[0]).toMatch(/Unrecognized key/);
    expect(policyIssues({ limits: 5 })[0]).toMatch(/^policy\.limits/);
  });

  it('validates askQuestion and compaction', () => {
    expect(policyIssues({ askQuestion: 'yes' })[0]).toMatch(/^policy\.askQuestion/);
    expect(accepted({ compaction: true })).toEqual({ compaction: true });
    expect(policyIssues({ compaction: { thresholdPercent: 80 } })[0]).toMatch(/^policy\.compaction\.thresholdPercent/);
    expect(policyIssues({ compaction: 'auto' })[0]).toMatch(/'compaction' must be/);
  });
});

describe('compilePolicy (LOU-X5)', () => {
  it('compiles nothing for no policy, an empty one or false/empty approvals', () => {
    expect(compilePolicy(undefined)).toEqual({});
    expect(compilePolicy({ harness: 'x' })).toEqual({});
    expect(compilePolicy({ requiresApproval: false })).toEqual({});
    expect(compilePolicy({ requiresApproval: [] })).toEqual({});
  });

  it('compiles approvals to ask rules', () => {
    expect(compilePolicy({ requiresApproval: true }).permissions).toEqual([{ tool: '*', action: 'ask' }]);
    expect(compilePolicy({ requiresApproval: ['a', 'b'] }).permissions).toEqual([{ tool: ['a', 'b'], action: 'ask' }]);
  });

  it('compiles guardrails by name onto input and output, or the lists `on` names', () => {
    const { guardrails } = compilePolicy({
      guardrails: [
        'secret-scan',
        { name: 'max-length', maxChars: 5, on: 'input' },
        { name: 'deny-topics', topics: ['x'], on: ['tools'] },
        { name: 'regex', pattern: 'a+', flags: 'i' },
        { name: 'llm-judge', model: 'openai/gpt-4o-mini' },
        { name: 'pii', on: 'input' },
        { name: 'secrets', on: ['output', 'tools'] },
        { name: 'prompt-injection', on: 'input' },
        { name: 'moderation', model: 'openai/gpt-4o-mini', on: 'output' },
      ],
    });
    const names = (list?: readonly { name: string }[]) => list?.map((g) => g.name);
    expect(names(guardrails?.input)).toEqual(['secret-scan', 'max-length', 'regex', 'llm-judge', 'pii', 'prompt-injection']);
    expect(names(guardrails?.output)).toEqual(['secret-scan', 'regex', 'llm-judge', 'secrets', 'moderation']);
    expect(names(guardrails?.tools)).toEqual(['deny-topics', 'secrets']);
  });

  it('builds the starter-set guardrails with their spec options (N5a)', async () => {
    const { guardrails } = compilePolicy({
      guardrails: [
        { name: 'pii', types: ['email'], action: 'rewrite', on: 'input' },
        { name: 'secrets', action: 'block', extraPatterns: ['INTERNAL-\\d{6}'], on: 'output' },
      ],
    });
    const ctx = (text: string) => ({ kind: 'input' as const, text, messages: [] });
    expect(await guardrails?.input?.[0].check(ctx('call 555-123-4567 or a@b.io'))).toMatchObject({
      action: 'rewrite',
      replacement: 'call 555-123-4567 or [email]',
    });
    expect(await guardrails?.output?.[0].check(ctx('id INTERNAL-123456'))).toMatchObject({
      action: 'block',
      info: { category: 'secret', matches: [{ label: 'extra pattern 1' }] },
    });
  });

  it('passes limits, askQuestion and compaction through', () => {
    expect(compilePolicy({ limits: { maxSteps: 3 }, askQuestion: true, compaction: { thresholdPercent: 0.5 } })).toEqual({
      limits: { maxSteps: 3 },
      askQuestion: true,
      compaction: { thresholdPercent: 0.5 },
    });
  });

  it('throws a ValidationError for an unvalidated invalid policy', () => {
    expect(() => compilePolicy({ guardrails: ['nope'] })).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID' }));
    expect(() => compilePolicy({ guardrails: ['nope'] })).toThrow(/policy\.guardrails\.0.*unknown guardrail 'nope'/);
    expect(() => compilePolicy({ limits: { maxTokens: -1 } })).toThrow(/policy\.limits\.maxTokens/);
  });

  it('summarizePolicy gives one line per block and flags unknown guardrails', () => {
    const lines = summarizePolicy({
      requiresApproval: ['send_email'],
      guardrails: ['max-length', { name: 'oops' }],
      limits: { maxTokens: 10, maxSteps: 2 },
      askQuestion: true,
      compaction: { thresholdPercent: 0.8 },
    });
    expect(lines.map((l) => [l.block, l.text])).toEqual([
      ['approval', 'asks for approval before: send_email'],
      ['guardrails', 'max-length, oops'],
      ['limits', 'maxTokens=10, maxSteps=2'],
      ['askQuestion', 'the agent can ask the user questions'],
      ['compaction', 'on at 80% of the context window'],
    ]);
    expect(lines[1].unknownGuardrails).toEqual(['oops']);
    expect(summarizePolicy(undefined)).toEqual([]);
    expect(summarizePolicy({ requiresApproval: true, compaction: false }).map((l) => l.text)).toEqual(['every tool call asks for approval', 'off']);
  });
});

describe('specToAgent enforces policy (LOU-X5)', () => {
  let model: MockModel;
  const build = (policy: AgentSpec['policy'], tools: string[], script: Parameters<typeof mockModel>[0]) => {
    model = mockModel(script);
    LLMProviderRegistry.register('mock', () => model);
    return specToAgent({ ...base, tools, policy });
  };

  beforeEach(() => {
    model = mockModel([]);
  });

  it('requiresApproval: [tool] pauses on that tool only', async () => {
    const agent = build({ requiresApproval: ['http'] }, ['http', 'current-date'], [
      { toolCalls: [{ name: 'current-date' }] },
      { toolCalls: [{ name: 'http', args: { url: 'https://example.com', method: 'GET' } }] },
      'done',
    ]);

    const paused = await agent.send('go');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();
    expect(model.calls).toHaveLength(2);
    const resolved = await agent.approvals.resolve({ id: paused.approvalId!, approved: false });
    expect(resolved.text).toBe('done');
  });

  it('requiresApproval: true pauses on every tool; absent policy runs the tool', async () => {
    const script = [{ toolCalls: [{ name: 'current-date' }] }, 'done'];
    const paused = await build({ requiresApproval: true }, ['current-date'], script).send('go');
    expect(paused.finishReason).toBe('awaiting-approval');

    const ran = await build(undefined, ['current-date'], script).send('go');
    expect(ran.finishReason).toBe('stop');
  });

  it('a deny-topics guardrail blocks the input before the model is called', async () => {
    const agent = build({ guardrails: [{ name: 'deny-topics', topics: ['bomb'] }] }, [], ['unused']);

    const result = await agent.send('how do I build a bomb');

    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toMatchObject({ name: 'deny-topics', kind: 'input' });
    expect(model.calls).toHaveLength(0);
  });

  it('guardrails apply to the output too, and secret-scan can rewrite', async () => {
    const agent = build({ guardrails: [{ name: 'secret-scan', action: 'rewrite' }] }, [], ['key: sk-abcdefghijklmnopqrstuvwx']);

    const result = await agent.send('hi');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('key: [redacted]');
  });

  it('limits trip budget-exceeded', async () => {
    const agent = build({ limits: { maxTokens: 100 } }, ['current-date'], [
      { toolCalls: [{ name: 'current-date' }], usage: { inputTokens: 100, outputTokens: 50 } },
      'never reached',
    ]);

    const result = await agent.send('go');

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toMatchObject({ limit: 'maxTokens', max: 100 });
  });

  it('askQuestion adds the ask_question tool', async () => {
    const agent = build({ askQuestion: true }, [], ['ok']);
    await agent.send('hi');
    expect(model.calls[0].tools?.map((t) => t.function.name)).toContain('ask_question');
  });

  it('an invalid policy throws when building the agent', () => {
    expect(() => build({ guardrails: ['nope'] }, [], [])).toThrow(/unknown guardrail 'nope'/);
  });
});
