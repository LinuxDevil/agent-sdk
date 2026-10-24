import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptsScreen } from '../PromptsScreen';
import { parsePromptParam, parseDiff, promptPath } from '../promptsUrl';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import { parsePromptParam as parsePlaygroundPrompt } from '../../playground/prefill';
import type { ObservePromptVersion } from '../../../observe/types';

const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();

const version = (v: number, text: string, labels: string[], uses: number): ObservePromptVersion => ({
  prompt_id: `p-${v}`,
  name: 'mira',
  version: v,
  labels,
  variables: v === 3 ? ['customer'] : null,
  hash: `h${v}`,
  text,
  created_at: T0 + v * 60_000,
  uses,
});

const V1 = version(1, 'You are Mira.\nBe brief.', [], 4);
const V2 = version(2, 'You are Mira.\nBe brief.\nCite the order id.', ['prod'], 3);
const V3 = version(3, 'You are Mira, a support agent.\nCite the order id.', ['staging'], 0);

let history: ObservePromptVersion[];
let fetchFn: ReturnType<typeof vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>>;

/** Daemon stub: healthy; one prompt `mira` (v1..v3, prod on v2, staging on v3); a label PUT moves the label in `history`. */
function stubDaemon() {
  history = [V3, V2, V1].map((v) => ({ ...v, labels: [...v.labels] }));
  fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
    const move = /\/api\/v1\/prompts\/mira\/labels\/([^/]+)$/.exec(url.pathname);
    if (move && init?.method === 'PUT') {
      const label = decodeURIComponent(move[1]);
      const { version: to } = JSON.parse(String(init.body)) as { version: number };
      const previous = history.find((v) => v.labels.includes(label))?.version ?? null;
      for (const v of history) v.labels = v.labels.filter((l) => l !== label);
      history.find((v) => v.version === to)!.labels.push(label);
      for (const v of history) v.labels.sort();
      return json({ name: 'mira', label, version: to, previous_version: previous });
    }
    if (url.pathname.endsWith('/api/v1/prompts/mira')) return json({ name: 'mira', versions: history });
    if (url.pathname.includes('/api/v1/prompts/')) return json({ error: "No prompt 'x'.", code: 'LOUSHO_REQUEST_INVALID' }, 404);
    if (url.pathname.endsWith('/api/v1/prompts')) return json({ prompts: [{ ...history[0], versions: 3, uses: 7 }] });
    return json({ error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchFn);
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <PromptsScreen />
    </ToastProvider>
  );
  await flush();
  return container;
}

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('promptsUrl', () => {
  it('splits name@ref out of the :name param and round-trips the path', () => {
    expect(parsePromptParam('mira@2')).toEqual({ name: 'mira', ref: '2' });
    expect(parsePromptParam('mira@prod')).toEqual({ name: 'mira', ref: 'prod' });
    expect(parsePromptParam('mira')).toEqual({ name: 'mira', ref: undefined });
    expect(parseDiff(new URLSearchParams('diff=1,3'))).toEqual([1, 3]);
    expect(parseDiff(new URLSearchParams('diff=1'))).toBeUndefined();
    expect(parseDiff(new URLSearchParams('diff=a,b'))).toBeUndefined();
    expect(promptPath('mira', 2, [1, 2])).toBe('/prompts/mira@2?diff=1,2');
    expect(promptPath('support-v2')).toBe('/prompts/support-v2');
  });
});

describe('PromptsScreen', () => {
  it('lists prompts with latest version, label chips, version count and uses', async () => {
    const container = await mountAt('#/prompts');
    const row = container.querySelector('tbody tr')!;
    expect(row.textContent).toContain('mira');
    expect(row.textContent).toContain('v3');
    expect(row.querySelector('.prompt-label')?.textContent).toBe('staging');
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('3');
    expect(cells).toContain('7');
  });

  it('#/prompts/mira@2 selects version 2 on load, and a label ref selects its version', async () => {
    let container = await mountAt('#/prompts/mira@2');
    expect(container.querySelector('.prompt-version-title')?.textContent).toContain('Version 2');
    expect(container.querySelector('.prompt-text')?.textContent).toBe(V2.text);
    expect(container.querySelector('tr[aria-current="true"]')?.textContent).toContain('v2');

    container = await mountAt('#/prompts/mira@staging');
    expect(container.querySelector('.prompt-version-title')?.textContent).toContain('Version 3');

    container = await mountAt('#/prompts/mira');
    expect(container.querySelector('.prompt-version-title')?.textContent).toContain('Version 3');
  });

  it('links the selected version to its runs in Traces and to the Playground', async () => {
    const container = await mountAt('#/prompts/mira@2');
    const runs = [...container.querySelectorAll('a')].find((a) => a.textContent?.startsWith('Runs using this version'));
    expect(runs?.getAttribute('href')).toBe('#/traces?prompt=mira@2');
    const playground = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Open in Playground');
    expect(playground?.getAttribute('href')).toBe('#/playground?prompt=mira@2');
    // ...in the shape the Playground's prefill actually reads.
    const query = new URLSearchParams(playground!.getAttribute('href')!.split('?')[1]);
    expect(parsePlaygroundPrompt(query.get('prompt'))).toEqual({ name: 'mira', ref: '2' });
  });

  it('renders a side-by-side diff of the two versions in ?diff=a,b, marking added and removed lines', async () => {
    const container = await mountAt('#/prompts/mira?diff=2,3');
    const diff = container.querySelector('.prompt-diff')!;
    expect(diff).not.toBeNull();
    const removed = [...diff.querySelectorAll('.prompt-diff-removed')].map((c) => c.textContent);
    const added = [...diff.querySelectorAll('.prompt-diff-added')].map((c) => c.textContent);
    expect(removed).toEqual(['-You are Mira.', '-Be brief.']);
    expect(added).toEqual(['+You are Mira, a support agent.']);
    // Colour is not the only signal: each changed cell names its change for screen readers.
    expect(diff.querySelector('.prompt-diff-removed')?.getAttribute('aria-label')).toBe('Removed line 1: You are Mira.');
    expect(diff.querySelector('.prompt-diff-added')?.getAttribute('aria-label')).toBe('Added line 1: You are Mira, a support agent.');
    expect(diff.textContent).toContain('Cite the order id.');
    // The compare pickers show A and B.
    expect((container.querySelector('select[aria-label="Compare version A"]') as HTMLSelectElement).value).toBe('2');
    expect((container.querySelector('select[aria-label="Compare version B"]') as HTMLSelectElement).value).toBe('3');
  });

  it('picking versions writes ?diff=a,b to the URL', async () => {
    const container = await mountAt('#/prompts/mira@2');
    act(() => buttonNamed(container, 'Compare')!.click());
    await flush();
    expect(window.location.hash).toBe('#/prompts/mira@2?diff=1,2');
    const b = container.querySelector('select[aria-label="Compare version B"]') as HTMLSelectElement;
    act(() => {
      b.value = '3';
      b.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe('#/prompts/mira@2?diff=1,3');
  });

  it('"Move prod here" PUTs {version} for the selected version, toasts, and refreshes the history', async () => {
    const container = await mountAt('#/prompts/mira@3');
    // staging already sits on v3, so only prod is offered.
    expect(buttonNamed(container, 'Move staging here')).toBeUndefined();
    act(() => buttonNamed(container, 'Move prod here')!.click());
    await flush();
    const put = fetchFn.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(String(put[0])).toBe('/observe/api/v1/prompts/mira/labels/prod');
    expect(JSON.parse(String(put[1]!.body))).toEqual({ version: 3 });
    expect(document.querySelector('.toast-success')?.textContent).toContain('Moved prod to version 3 (was version 2)');
    // The detail refetched: prod now shows on v3 and the move button is gone.
    const chips = [...container.querySelectorAll('.prompt-version-head .prompt-label')].map((c) => c.textContent);
    expect(chips).toEqual(['prod', 'staging']);
    expect(buttonNamed(container, 'Move prod here')).toBeUndefined();
  });

  it('a failed label move shows an error toast', async () => {
    const container = await mountAt('#/prompts/mira@1');
    fetchFn.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "No prompt 'mira@1'." }), { status: 404 }));
    act(() => buttonNamed(container, 'Move prod here')!.click());
    await flush();
    expect(document.querySelector('.toast-error')?.textContent).toContain("Could not move prod: No prompt 'mira@1'.");
  });

  it('an unknown prompt shows an empty state with the way back', async () => {
    const container = await mountAt('#/prompts/nope');
    expect(container.textContent).toContain('Prompt not found');
    expect(container.querySelector('a[href="#/prompts"]')).not.toBeNull();
  });
});
