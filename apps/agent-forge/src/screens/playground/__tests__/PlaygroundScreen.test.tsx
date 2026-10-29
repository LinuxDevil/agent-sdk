import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveObservationRow, ObserveTraceDetail } from '../../../observe/types';
import { PlaygroundRoute, PlaygroundScreen } from '../PlaygroundScreen';

vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

function gen(over: Partial<ObserveObservationRow> & { obs_id: string }): ObserveObservationRow {
  return {
    trace_id: 't1', session_id: null, agent_id: 'a1', parent_obs_id: null, kind: 'generation', name: 'llm',
    start: 0, end: 1, status: 'ok', input: null, output: null, model: null, usage_input_tokens: null,
    usage_output_tokens: null, usage_cached_tokens: null, usage_reasoning_tokens: null, cost_usd: null,
    cost_partial: null, usage_estimated: null, truncated: false, attrs: null, ...over,
  };
}

const TRACE: ObserveTraceDetail = {
  trace_id: 't1',
  observations: [
    gen({ obs_id: 'root', kind: 'span' }),
    gen({
      obs_id: 'g1',
      parent_obs_id: 'root',
      model: 'gpt-4o-mini',
      attrs: { 'gen_ai.provider.name': 'openai' },
      input: JSON.stringify([
        { role: 'system', content: 'You are {persona}.' },
        { role: 'user', content: 'Hi there' },
      ]),
    }),
  ],
  scores: [],
};

const PROMPT = {
  prompt_id: 'p1', name: 'greeter', version: 2, labels: ['prod'], variables: ['persona'], hash: 'h', text: 'You are {persona}.', created_at: 0,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A controllable SSE body: `send` enqueues one `data:` frame, `end` closes it. */
function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => controller.close(),
  };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Stubs fetch for the Studio server (agents, provider keys) and the observe proxy; `extra` answers first. */
function server(extra: Route = () => undefined) {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = await extra(url, init);
    if (answer) return answer;
    if (url === '/settings/providers') return json(200, [{ provider: 'openai', hasKey: true, masked: '••••1234', envKey: false }]);
    if (url === '/agents') return json(200, []);
    if (url.startsWith('/observe/api/v1/traces/t1')) return json(200, TRACE);
    if (url.startsWith('/observe/api/v1/traces/')) return json(404, { error: 'No trace.' });
    if (url === '/observe/api/v1/prompts/greeter/latest') return json(200, { prompt: PROMPT });
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function mount(hash = '#/playground') {
  window.history.replaceState(null, '', `/${hash}`);
  return render(
    <ToastProvider>
      <PlaygroundScreen />
    </ToastProvider>,
  );
}

const contents = (c: HTMLElement) => [...c.querySelectorAll<HTMLTextAreaElement>('.pg-content')].map((t) => t.value);
const roles = (c: HTMLElement) => [...c.querySelectorAll<HTMLSelectElement>('.pg-role')].map((s) => s.value);
const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('PlaygroundScreen', () => {
  it('shows one input per detected variable, in first-seen order', async () => {
    server();
    const c = mount();
    const [system, user] = [...c.querySelectorAll<HTMLTextAreaElement>('.pg-content')];
    typeInto(system!, 'You are {persona}, speaking {lang}.');
    typeInto(user!, 'Hi {name} in {lang}');
    const labels = [...c.querySelectorAll('.pg-variables .pg-field-label')].map((l) => l.textContent);
    expect(labels).toEqual(['{persona}', '{lang}', '{name}']);
  });

  it('pre-fills messages and model from ?trace=&fromObs=', async () => {
    const fetchFn = server();
    const c = mount('#/playground?trace=t1&fromObs=g1');
    await waitFor(() => contents(c)[0] === 'You are {persona}.');
    expect(contents(c)).toEqual(['You are {persona}.', 'Hi there']);
    expect(roles(c)).toEqual(['system', 'user']);
    expect((c.querySelector('.pg-model select') as HTMLSelectElement).value).toBe('openai');
    expect((c.querySelector('.pg-model input') as HTMLInputElement).value).toBe('gpt-4o-mini');
    expect(fetchFn.mock.calls.some(([u]) => String(u) === '/observe/api/v1/traces/t1')).toBe(true);
    expect(window.location.hash).toBe('#/playground?trace=t1&fromObs=g1');
  });

  it('shows a notice and an empty editor for a fromObs link without a trace, or a missing generation', async () => {
    server();
    let c = mount('#/playground?fromObs=g1');
    await waitFor(() => c.querySelector('.pg-notice') !== null);
    expect(c.querySelector('.pg-notice')!.textContent).toContain('no trace');
    expect(contents(c)).toEqual(['', '']);

    c = mount('#/playground?trace=t1&fromObs=nope');
    await waitFor(() => c.querySelector('.pg-notice') !== null);
    expect(c.querySelector('.pg-notice')!.textContent).toContain("'nope' was not found");
  });

  it('shows a daemon-down notice when the trace cannot be loaded, and can still run', async () => {
    const stream = sseStream();
    server((url) => {
      if (url.startsWith('/observe/')) return json(502, { error: 'down' });
      if (url === '/playground/run') return stream.response();
      return undefined;
    });
    const c = mount('#/playground?trace=t1&fromObs=g1');
    await waitFor(() => c.querySelector('.pg-notice') !== null);
    expect(c.querySelector('.pg-notice')!.textContent).toContain('lousho observe start');
    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!, 'hello');
    act(() => button(c, 'Run').click());
    stream.send({ type: 'done', finishReason: 'stop', text: 'ok' });
    stream.end();
    await waitFor(() => c.querySelector('.pg-output .status-pill')?.textContent === 'done');
  });

  it('renders streamed deltas incrementally, then links the trace', async () => {
    const stream = sseStream();
    let sent: Record<string, unknown> | undefined;
    server((url, init) => {
      if (url !== '/playground/run') return undefined;
      sent = JSON.parse(init!.body as string) as Record<string, unknown>;
      return stream.response();
    });
    const c = mount();
    const [system, user] = [...c.querySelectorAll<HTMLTextAreaElement>('.pg-content')];
    typeInto(system!, 'Be {tone}.');
    typeInto(user!, 'Hello');
    typeInto(c.querySelector('.pg-variables input') as HTMLInputElement, 'brief');
    await waitFor(() => (c.querySelector('.pg-model select') as HTMLSelectElement).value === 'openai');
    typeInto(c.querySelector('.pg-model input') as HTMLInputElement, 'gpt-4o-mini');
    act(() => button(c, 'Run').click());

    await waitFor(() => sent !== undefined);
    expect(sent).toEqual({
      messages: [
        { role: 'system', content: 'Be {tone}.' },
        { role: 'user', content: 'Hello' },
      ],
      variables: { tone: 'brief' },
      model: 'openai/gpt-4o-mini',
    });

    stream.send({ type: 'delta', text: 'Hel' });
    await waitFor(() => c.querySelector('.pg-stream')?.textContent === 'Hel');
    expect(c.querySelector('.pg-output .status-pill')?.textContent).toBe('running');
    stream.send({ type: 'delta', text: 'lo!' });
    await waitFor(() => c.querySelector('.pg-stream')?.textContent === 'Hello!');

    stream.send({ type: 'done', finishReason: 'stop', text: 'Hello!', traceId: 'tr-9' });
    stream.end();
    await waitFor(() => c.querySelector('a[href="#/traces/tr-9"]') !== null);
    expect(c.querySelector('.pg-output .status-pill')?.textContent).toBe('done');
    expect(c.querySelector('.pg-output .mv')?.textContent).toContain('Hello!');
  });

  it('shows an error event as an alert banner', async () => {
    const stream = sseStream();
    server((url) => (url === '/playground/run' ? stream.response() : undefined));
    const c = mount();
    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!, 'hi');
    act(() => button(c, 'Run').click());
    stream.send({ type: 'error', message: 'No key', code: 'LOUSHO_PROVIDER_MISSING_API_KEY' });
    stream.end();
    await waitFor(() => c.querySelector('.pg-output [role="alert"]') !== null);
    expect(c.querySelector('.pg-output [role="alert"]')!.textContent).toContain('No key');
    expect(c.querySelector('.pg-output')!.textContent).not.toContain('Latency');
  });

  it('Ctrl+Enter in a message runs it, and shows the shortcut beside Run', async () => {
    const stream = sseStream();
    let ran = 0;
    server((url) => {
      if (url !== '/playground/run') return undefined;
      ran += 1;
      return stream.response();
    });
    const c = mount();
    expect(c.querySelector('.pg-runbar kbd')).not.toBeNull();
    const user = c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!;
    typeInto(user, 'hi');
    act(() => {
      user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(ran).toBe(0);
    act(() => {
      user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true }));
      user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    });
    expect(ran).toBe(0);
    act(() => {
      user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => ran === 1);
    stream.end();
  });

  it('shows tool calls as collapsible cards with their args, and the token and latency metrics', async () => {
    const stream = sseStream();
    server((url) => (url === '/playground/run' ? stream.response() : undefined));
    const c = mount();
    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!, 'hi');
    act(() => button(c, 'Run').click());
    stream.send({ type: 'tool_call', id: 'c1', name: 'order-status', args: { orderId: '4512' } });
    await waitFor(() => c.querySelector('.pg-tool-call') !== null);
    const call = c.querySelector<HTMLDetailsElement>('[aria-label="Tool calls"] details.pg-tool-call')!;
    expect(call.querySelector('summary')!.textContent).toContain('order-status');
    expect(call.open).toBe(false);
    expect(call.textContent).toContain('4512');
    stream.send({
      type: 'done', finishReason: 'stop', text: 'ok',
      usage: { promptTokens: 412, completionTokens: 86, totalTokens: 498, inputTokens: 412, outputTokens: 86, estimated: false },
    });
    stream.end();
    await waitFor(() => c.querySelector('.pg-metrics') !== null);
    const metrics = c.querySelector('.pg-metrics')!.textContent!;
    expect(metrics).toContain('412');
    expect(metrics).toContain('86');
    expect(metrics).toMatch(/Latency/);
  });

  it('opens the save card from the header, and Escape closes it', () => {
    server();
    const c = mount();
    const trigger = button(c, 'Save prompt');
    const dialog = c.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(dialog.hidden).toBe(true);
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.hidden).toBe(false);
    expect(document.activeElement).toBe(dialog.querySelector('input'));
    // Escape closes it even once focus has left the card.
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('Stop aborts the stream', async () => {
    let signal: AbortSignal | undefined;
    server((url, init) => {
      if (url !== '/playground/run') return undefined;
      signal = init!.signal ?? undefined;
      return sseStream().response();
    });
    const c = mount();
    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!, 'hi');
    act(() => button(c, 'Run').click());
    await waitFor(() => signal !== undefined);
    act(() => button(c, 'Stop').click());
    expect(signal!.aborted).toBe(true);
    await waitFor(() => c.querySelector('.pg-output .status-pill')?.textContent === 'stopped');
  });

  it('loads ?prompt= as the system message, sends promptRef, and saves a new version', async () => {
    const stream = sseStream();
    let runBody: Record<string, unknown> | undefined;
    let pushed: unknown;
    server((url, init) => {
      if (url === '/playground/run') {
        runBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return stream.response();
      }
      if (url === '/observe/api/v1/prompts' && init?.method === 'POST') {
        pushed = JSON.parse(init.body as string);
        return json(201, { prompt: { ...PROMPT, version: 3 }, created: true, version: 3, unchanged: false });
      }
      return undefined;
    });
    const c = mount('#/playground?prompt=greeter');
    await waitFor(() => contents(c)[0] === 'You are {persona}.');
    expect(roles(c)).toEqual(['system', 'user']);
    expect((c.querySelector('.pg-save input') as HTMLInputElement).value).toBe('greeter');

    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[0]!, 'You are {persona}, {mood}.');
    typeInto(c.querySelectorAll<HTMLTextAreaElement>('.pg-content')[1]!, 'Hi {name}');
    act(() => button(c, 'Save as new prompt version').click());
    await waitFor(() => pushed !== undefined);
    expect(pushed).toEqual({ name: 'greeter', text: 'You are {persona}, {mood}.', variables: ['persona', 'mood'] });
    await waitFor(() => document.body.textContent!.includes('Saved greeter v3'));

    act(() => button(c, 'Run').click());
    await waitFor(() => runBody !== undefined);
    expect(runBody!.promptRef).toBe('greeter');
    stream.end();
  });

  it('disables save with a hint when there is no system message', () => {
    server();
    const c = mount();
    const save = button(c, 'Save as new prompt version');
    expect(save.disabled).toBe(true);
    expect(c.querySelector('.pg-save .pg-hint')?.textContent).toContain('system message');
  });
});

describe('PlaygroundRoute', () => {
  it('re-loads when the deep link changes while mounted (back/forward between links)', async () => {
    server((url) =>
      url === '/observe/api/v1/prompts/other/latest'
        ? json(200, { prompt: { ...PROMPT, name: 'other', text: 'Other prompt.' } })
        : undefined,
    );
    window.history.replaceState(null, '', '/#/playground?prompt=greeter');
    const c = render(
      <ToastProvider>
        <PlaygroundRoute />
      </ToastProvider>,
    );
    await waitFor(() => contents(c)[0] === 'You are {persona}.');
    act(() => {
      window.location.hash = '#/playground?prompt=other';
    });
    await waitFor(() => contents(c)[0] === 'Other prompt.');
    expect((c.querySelector('.pg-save input') as HTMLInputElement).value).toBe('other');
    act(() => {
      window.location.hash = '#/playground?trace=t1&fromObs=g1';
    });
    await waitFor(() => contents(c)[1] === 'Hi there');
  });
});
