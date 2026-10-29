import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvaluatorsScreen } from '../EvaluatorsScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveEvaluator, ObserveScoreRow } from '../../../observe/types';
import type { ProviderKeyStatus } from '../../../../shared/wireTypes';

const NOW = Date.now();

const CODE_RULE: ObserveEvaluator = {
  rule_id: 'r1',
  name: 'answered',
  enabled: true,
  filter: { agent_id: 'support-bot', status: 'ok' },
  sample_rate: 0.5,
  kind: 'code',
  config: { source: '(trace) => 1' },
  created_at: NOW - 86_400_000,
  updated_at: NOW - 86_400_000,
};
const JUDGE_RULE: ObserveEvaluator = {
  rule_id: 'r2',
  name: 'polite',
  enabled: false,
  filter: {},
  sample_rate: 1,
  kind: 'judge',
  config: { model: 'openai/gpt-4o-mini', rubric: 'Is the reply polite?' },
  created_at: NOW - 3_600_000,
  updated_at: NOW - 3_600_000,
};

const score = (name: string, ageMs: number, source = 'online'): ObserveScoreRow => ({
  score_id: `${name}-${ageMs}`,
  trace_id: 't1',
  obs_id: null,
  name,
  value: 1,
  source,
  comment: null,
  agent_id: null,
  created_at: NOW - ageMs,
});

type Call = { path: string; query: URLSearchParams; method: string; body: unknown };

let rules: ObserveEvaluator[];
let keys: ProviderKeyStatus[];
let calls: Call[];
let putStatus: number;
let testStatus: number;

const NO_KEYS: ProviderKeyStatus[] = [
  { provider: 'openai', hasKey: false, masked: null, envKey: false },
  { provider: 'anthropic', hasKey: false, masked: null, envKey: false },
];
const OPENAI_KEY: ProviderKeyStatus[] = [{ provider: 'openai', hasKey: true, masked: '••••abcd', envKey: false }, NO_KEYS[1]];
/** Only `ANTHROPIC_API_KEY` in the server's environment: nothing stored in Settings. */
const ANTHROPIC_ENV_ONLY: ProviderKeyStatus[] = [NO_KEYS[0], { ...NO_KEYS[1], envKey: true }];

/** Daemon stub behind `/observe`, plus the Studio's `/settings/providers`. */
function stubDaemon() {
  rules = [CODE_RULE, JUDGE_RULE];
  keys = NO_KEYS;
  calls = [];
  putStatus = 200;
  testStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      const p = url.pathname.replace(/^\/observe/, '');
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path: p, query: url.searchParams, method, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (p === '/settings/providers') return json(keys);
      if (p === '/health') return json({ service: 'lousho-observe', ok: true });
      if (p === '/__target') return json({ url: 'http://127.0.0.1:7777' });
      if (p === '/api/v1/agents') return json({ agents: [{ agent_id: 'support-bot', name: 'Support bot' }] });
      if (p === '/api/v1/scores')
        return json({ scores: [score('answered', 60_000), score('answered', 3_600_000), score('answered', 2 * 86_400_000), score('polite', 5 * 86_400_000)] });
      if (p === '/api/v1/evaluators' && method === 'POST') {
        if (rules.some((r) => r.name === body.name)) return json({ error: 'taken', code: 'LOUSHO_REQUEST_INVALID' }, 409);
        const created = { ...CODE_RULE, ...body, rule_id: 'r3' } as ObserveEvaluator;
        rules = [...rules, created];
        return json({ evaluator: created }, 201);
      }
      if (p === '/api/v1/evaluators') return json({ evaluators: rules, total: rules.length, limit: 50, offset: 0 });
      const test = /^\/api\/v1\/evaluators\/([^/]+)\/test$/.exec(p);
      if (test && method === 'POST') {
        if (testStatus === 404) return json({ error: 'No trace.', code: 'LOUSHO_REQUEST_INVALID' }, 404);
        if (testStatus !== 200) return json({ error: 'isolate exploded' }, testStatus);
        return json({ result: { value: 0.75, comment: '3 tool call(s)' } });
      }
      const one = /^\/api\/v1\/evaluators\/([^/]+)$/.exec(p);
      if (one) {
        const rule = rules.find((r) => r.rule_id === one[1]);
        if (!rule) return json({ error: 'No evaluator.', code: 'LOUSHO_REQUEST_INVALID' }, 404);
        if (method === 'PUT') {
          if (putStatus !== 200) return json({ error: 'Name taken.', code: 'LOUSHO_REQUEST_INVALID' }, putStatus);
          const updated = { ...rule, ...body, updated_at: rule.updated_at + 1 } as ObserveEvaluator;
          rules = rules.map((r) => (r.rule_id === rule.rule_id ? updated : r));
          return json({ evaluator: updated });
        }
        if (method === 'DELETE') {
          rules = rules.filter((r) => r.rule_id !== rule.rule_id);
          return new Response(null, { status: 204 });
        }
        return json({ evaluator: rule });
      }
      return json({ error: 'unexpected' }, 500);
    }),
  );
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <EvaluatorsScreen />
    </ToastProvider>,
  );
  await flush();
  return container;
}

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

const field = <T extends Element>(container: HTMLElement, name: string) => container.querySelector(`[name="${name}"]`) as unknown as T;
const writes = (method: string) => calls.filter((c) => c.method === method);

async function openNewForm() {
  const container = await mountAt('#/evals/evaluators');
  await click(buttonNamed(container, 'New evaluator')!);
  return container;
}

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('EvaluatorsScreen list', () => {
  it('renders one card per rule with its kind, target filter, sample rate, switch and last-run counts', async () => {
    const container = await mountAt('#/evals/evaluators');
    const cards = [...container.querySelectorAll('.ds-grid .ev-card')];
    expect(cards).toHaveLength(2);
    const text = (card: Element, selector: string) => card.querySelector(selector)?.textContent;
    const facts = (card: Element) => [
      text(card, '.ev-card-name'),
      text(card, '.ev-card-kind'),
      text(card, '.ev-card-target dd'),
      text(card, '.ev-card-sample dd'),
    ];
    const [first, second] = cards;
    expect(facts(first)).toEqual(['answered', 'Code', 'agent=support-bot, status=ok', '0.5']);
    expect(text(first, '.ev-runs-count')).toBe('2');
    expect(text(first, '.ev-card-last')).toMatch(/^Last run /);
    expect(first.querySelector('.ev-icon-code')).not.toBeNull();
    expect(facts(second)).toEqual(['polite', 'LLM judge', 'All traces', '1']);
    expect(text(second, '.ev-runs-count')).toBe('0');
    expect(text(second, '.ev-card-last')).toMatch(/^Last run /);
    expect(second.querySelector('.ev-icon-judge')).not.toBeNull();
    const switches = [...container.querySelectorAll('input[role="switch"]')] as HTMLInputElement[];
    expect(switches.map((s) => [s.getAttribute('aria-label'), s.checked])).toEqual([
      ['answered enabled', true],
      ['polite enabled', false],
    ]);
    // The switch is never inside the card's link.
    expect(switches.every((s) => s.closest('a') === null)).toBe(true);
    expect(container.querySelector('nav[aria-label="Evaluations"] [aria-current="page"]')?.textContent).toBe('Evaluators');
  });

  it('shows the empty state with New evaluator when there are no rules', async () => {
    rules = [];
    const container = await mountAt('#/evals/evaluators');
    expect(container.querySelector('.empty-state')?.textContent).toContain('No evaluators yet');
    expect(buttonNamed(container.querySelector('.empty-state') as HTMLElement, 'New evaluator')).toBeDefined();
  });

  it('reads the last-run counts in one online-score request, not one per rule', async () => {
    await mountAt('#/evals/evaluators');
    const reads = calls.filter((c) => c.path === '/api/v1/scores');
    expect(reads).toHaveLength(1);
    expect(reads[0].query.get('source')).toBe('online');
    expect(reads[0].query.get('limit')).toBe('1000');
  });

  it('sends the URL filters to the daemon and writes a changed filter to the URL', async () => {
    const container = await mountAt('#/evals/evaluators?kind=judge&enabled=false');
    const list = calls.find((c) => c.path === '/api/v1/evaluators')!;
    expect(list.query.get('kind')).toBe('judge');
    expect(list.query.get('enabled')).toBe('false');
    const [kind, state] = [...container.querySelectorAll('[aria-label="Filters"] select')] as HTMLSelectElement[];
    expect(kind.value).toBe('judge');
    expect(state.value).toBe('false');
    choose(kind, '');
    expect(window.location.hash).toBe('#/evals/evaluators?enabled=false');
  });

  it('links each card to the edit view, carrying the list filters', async () => {
    const container = await mountAt('#/evals/evaluators?kind=code');
    const link = container.querySelector('.ev-card-name') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/evals/evaluators/r1?kind=code');
  });

  it('toggles a rule with PUT {enabled}, optimistically', async () => {
    const container = await mountAt('#/evals/evaluators');
    const toggle = container.querySelector('input[aria-label="polite enabled"]') as HTMLInputElement;
    await click(toggle);
    expect(toggle.checked).toBe(true);
    expect(writes('PUT')).toEqual([expect.objectContaining({ path: '/api/v1/evaluators/r2', body: { enabled: true } })]);
  });

  it('rolls the switch back with an error toast when the PUT fails', async () => {
    putStatus = 500;
    const container = await mountAt('#/evals/evaluators');
    const toggle = container.querySelector('input[aria-label="answered enabled"]') as HTMLInputElement;
    await click(toggle);
    expect(writes('PUT')[0].body).toEqual({ enabled: false });
    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not disable answered');
  });
});

describe('New evaluator', () => {
  it('creates a code rule, prefilled with the sample function', async () => {
    const container = await openNewForm();
    const source = field<HTMLTextAreaElement>(container, 'evaluator-source');
    expect(source.value).toMatch(/^\(trace\) =>/);
    expect(source.value).toContain('trace.observations');
    type(field(container, 'evaluator-name'), 'tool-user');
    type(field(container, 'evaluator-sample-rate'), '0.25');
    choose(field(container, 'evaluator-agent'), 'support-bot');
    choose(field(container, 'evaluator-status'), 'error');
    type(field(container, 'evaluator-name-contains'), ' turn ');
    await click(buttonNamed(container, 'Create evaluator')!);
    expect(writes('POST')).toEqual([
      expect.objectContaining({
        path: '/api/v1/evaluators',
        body: {
          name: 'tool-user',
          enabled: true,
          filter: { agent_id: 'support-bot', status: 'error', name_contains: 'turn' },
          sample_rate: 0.25,
          kind: 'code',
          config: { source: source.value },
        },
      }),
    ]);
    expect(container.querySelector('form[aria-label="New evaluator"]')).toBeNull();
    expect(container.querySelectorAll('.ds-grid .ev-card')).toHaveLength(3);
  });

  it('creates a judge rule with provider/model and rubric when Studio has a provider key', async () => {
    keys = OPENAI_KEY;
    const container = await openNewForm();
    const judge = container.querySelector('input[name="evaluator-kind"][value="judge"]') as HTMLInputElement;
    expect(judge.disabled).toBe(false);
    await click(judge);
    expect(field<HTMLSelectElement>(container, 'evaluator-provider').value).toBe('openai');
    type(field(container, 'evaluator-name'), 'helpful');
    type(field(container, 'evaluator-model'), 'gpt-4o-mini');
    type(field(container, 'evaluator-rubric'), 'Score 1 if helpful.');
    act(() => field<HTMLInputElement>(container, 'evaluator-enabled').click());
    await click(buttonNamed(container, 'Create evaluator')!);
    expect(writes('POST')[0].body).toEqual({
      name: 'helpful',
      enabled: false,
      filter: {},
      sample_rate: 1,
      kind: 'judge',
      config: { model: 'openai/gpt-4o-mini', rubric: 'Score 1 if helpful.' },
    });
  });

  it('enables the judge option, on that provider, when the only key is a provider env var', async () => {
    keys = ANTHROPIC_ENV_ONLY;
    const container = await openNewForm();
    const judge = container.querySelector('input[name="evaluator-kind"][value="judge"]') as HTMLInputElement;
    expect(judge.disabled).toBe(false);
    expect(container.querySelector('#evaluator-judge-hint')).toBeNull();
    await click(judge);
    expect(field<HTMLSelectElement>(container, 'evaluator-provider').value).toBe('anthropic');
  });

  it('disables the judge option with a Settings hint when Studio has no provider key', async () => {
    const container = await openNewForm();
    const judge = container.querySelector('input[name="evaluator-kind"][value="judge"]') as HTMLInputElement;
    expect(judge.disabled).toBe(true);
    const hint = container.querySelector('#evaluator-judge-hint')!;
    expect(hint.textContent).toBe('Add a provider key in Settings to use judge evaluators.');
    expect(hint.querySelector('a')?.getAttribute('href')).toBe('#/settings');
    expect(judge.getAttribute('aria-describedby')).toBe('evaluator-judge-hint');
  });

  it('keeps Create disabled until the draft is valid', async () => {
    const container = await openNewForm();
    const create = buttonNamed(container, 'Create evaluator')!;
    expect(create.disabled).toBe(true);
    type(field(container, 'evaluator-name'), 'x');
    expect(create.disabled).toBe(false);
    type(field(container, 'evaluator-sample-rate'), '2');
    expect(create.disabled).toBe(true);
    expect(container.textContent).toContain('Sample rate is a number from 0 to 1.');
  });

  it('shows a taken name (409) inline', async () => {
    const container = await openNewForm();
    type(field(container, 'evaluator-name'), 'answered');
    await click(buttonNamed(container, 'Create evaluator')!);
    expect(container.querySelector('form[aria-label="New evaluator"] [role="alert"]')?.textContent).toBe(
      'Could not save: an evaluator with that name exists.',
    );
  });
});

describe('EvaluatorsScreen edit view', () => {
  it('loads the rule into the form and PUTs only the changed fields', async () => {
    const container = await mountAt('#/evals/evaluators/r1');
    expect(container.querySelector('h2')?.textContent).toBe('Evaluator answered');
    expect(field<HTMLInputElement>(container, 'evaluator-name').value).toBe('answered');
    expect(field<HTMLSelectElement>(container, 'evaluator-status').value).toBe('ok');
    type(field(container, 'evaluator-sample-rate'), '0.1');
    choose(field(container, 'evaluator-status'), '');
    await click(buttonNamed(container, 'Save changes')!);
    expect(writes('PUT')).toEqual([
      expect.objectContaining({ path: '/api/v1/evaluators/r1', body: { sample_rate: 0.1, filter: { agent_id: 'support-bot' } } }),
    ]);
  });

  it('sends no PUT when nothing changed', async () => {
    const container = await mountAt('#/evals/evaluators/r1');
    await click(buttonNamed(container, 'Save changes')!);
    expect(writes('PUT')).toEqual([]);
    expect(container.textContent).toContain('No changes to save.');
  });

  it('edits a judge rule (provider and model split back out) and shows a 409 inline', async () => {
    putStatus = 409;
    const container = await mountAt('#/evals/evaluators/r2');
    expect(field<HTMLSelectElement>(container, 'evaluator-provider').value).toBe('openai');
    expect(field<HTMLInputElement>(container, 'evaluator-model').value).toBe('gpt-4o-mini');
    type(field(container, 'evaluator-rubric'), 'Polite and kind?');
    await click(buttonNamed(container, 'Save changes')!);
    expect(writes('PUT')[0].body).toEqual({ config: { model: 'openai/gpt-4o-mini', rubric: 'Polite and kind?' } });
    expect(container.querySelector('form[aria-label="Edit evaluator"] [role="alert"]')?.textContent).toBe(
      'Could not save: an evaluator with that name exists.',
    );
  });

  it('deletes after a confirm and returns to the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const container = await mountAt('#/evals/evaluators/r1?kind=code');
    await click(buttonNamed(container, 'Delete')!);
    expect(writes('DELETE').map((c) => c.path)).toEqual(['/api/v1/evaluators/r1']);
    expect(window.location.hash).toBe('#/evals/evaluators?kind=code');
  });

  it('shows "Evaluator not found" for an unknown id', async () => {
    const container = await mountAt('#/evals/evaluators/nope');
    expect(container.textContent).toContain('Evaluator not found');
  });

  it('tests the rule on a trace through the Studio path and shows value and comment', async () => {
    const container = await mountAt('#/evals/evaluators/r1?trace=t-prefill');
    const input = field<HTMLInputElement>(container, 'test-trace-id');
    expect(input.value).toBe('t-prefill');
    type(input, 't1');
    await click(buttonNamed(container, 'Test')!);
    const post = writes('POST')[0];
    expect(post).toMatchObject({ path: '/api/v1/evaluators/r1/test', body: { trace_id: 't1' } });
    const fetchMock = vi.mocked(fetch);
    const testUrl = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.endsWith('/test'));
    expect(testUrl).toBe('/observe/api/v1/evaluators/r1/test');
    const result = container.querySelector('[aria-label="Test result"]')!;
    expect([...result.querySelectorAll('dd')].map((d) => d.textContent)).toEqual(['0.75', '3 tool call(s)']);
  });

  it('says "Trace not found" on a 404 and toasts any other failure', async () => {
    testStatus = 404;
    const container = await mountAt('#/evals/evaluators/r1?trace=missing');
    await click(buttonNamed(container, 'Test')!);
    expect(container.querySelector('form[aria-label="Test on trace"] [role="alert"]')?.textContent).toBe('Trace not found');
    testStatus = 500;
    await click(buttonNamed(container, 'Test')!);
    expect(container.querySelector('form[aria-label="Test on trace"] [role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Test failed: isolate exploded');
  });
});
