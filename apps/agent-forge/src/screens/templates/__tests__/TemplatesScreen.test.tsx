import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createAgentRecord: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import type { AgentRecord, TemplateDetail, TemplateSummary } from '../../../../shared/wireTypes';
import { TemplatesScreen } from '../TemplatesScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const TEMPLATES: TemplateSummary[] = [
  {
    id: 'pr-reviewer',
    title: 'PR reviewer',
    description: 'Reviews each pull request and posts one comment.',
    category: 'Engineering',
    tags: ['github', 'review'],
    requires: ['provider_key', 'mcp'],
  },
  {
    id: 'code-architect',
    title: 'Code architect',
    description: 'Proposes designs for a change before it is built.',
    category: 'Engineering',
    tags: ['design'],
    requires: [],
  },
  {
    id: 'incident-responder',
    title: 'Incident responder',
    description: 'Summarises each firing alert.',
    category: 'Operations',
    tags: ['alerts'],
    requires: ['secret'],
  },
  {
    id: 'support-triage',
    title: 'Support triage',
    description: 'Sorts each new ticket by type and urgency.',
    category: 'Support',
    tags: ['email'],
    requires: ['provider_key'],
  },
  {
    id: 'docs-qa',
    title: 'Docs Q&A',
    description: 'Answers questions about the docs.',
    category: 'Support',
    tags: ['docs'],
    requires: [],
  },
  {
    id: 'research-assistant',
    title: 'Research assistant',
    description: 'Answers a question with cited sources.',
    category: 'Research',
    tags: ['web'],
    requires: ['provider_key'],
  },
];

const PR_README = '# PR reviewer\n\nReviews pull requests and posts one review comment.';

const PR_DETAIL = {
  summary: TEMPLATES[0],
  spec: { name: 'PR reviewer' },
  readme: PR_README,
} as unknown as TemplateDetail;

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash = '#/templates') {
  window.history.replaceState(null, '', `/${hash}`);
  const host = render(
    <ToastProvider>
      <TemplatesScreen />
    </ToastProvider>
  );
  await flush();
  return host;
}

const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

const pillNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button.templates-pill')].find((b) =>
    b.textContent?.startsWith(name)
  );

/** The sheet portals to document.body, outside the render host. */
const sheet = () => document.body.querySelector('.sheet') as HTMLElement;

const toastTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  api.listTemplates.mockResolvedValue(TEMPLATES);
  api.getTemplate.mockResolvedValue(PR_DETAIL);
  api.createAgentRecord.mockResolvedValue({ id: 'new-agent', spec: { name: 'New agent' } } as AgentRecord);
  window.history.replaceState(null, '', '/#/templates');
});

describe('TemplatesScreen', () => {
  it('shows six skeleton cards while the list is pending', async () => {
    api.listTemplates.mockReturnValue(new Promise(() => {}));
    const host = render(
      <ToastProvider>
        <TemplatesScreen />
      </ToastProvider>
    );
    await flush();
    expect(host.querySelectorAll('.template-card-skeleton')).toHaveLength(6);
    const grid = host.querySelector('ul.templates-grid')!;
    expect(grid.getAttribute('aria-busy')).toBe('true');
    expect(grid.querySelector('[role="status"]')?.textContent).toBe('Loading templates');
  });

  it('renders one card per template and the category pills, All pressed first', async () => {
    const host = await mountAt();
    expect(host.querySelectorAll('article.template-card')).toHaveLength(6);
    const pills = [...host.querySelectorAll<HTMLButtonElement>('button.templates-pill')];
    expect(pills).toHaveLength(5);
    expect(pills.map((p) => p.textContent)).toEqual([
      'All6',
      'Engineering2',
      'Operations1',
      'Research1',
      'Support2',
    ]);
    expect(pills[0].getAttribute('aria-pressed')).toBe('true');
    expect(pills.slice(1).every((p) => p.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('filters the grid by category and writes ?category= to the hash', async () => {
    const host = await mountAt();
    await act(async () => pillNamed(host, 'Support')!.click());
    await flush();
    expect(window.location.hash).toBe('#/templates?category=Support');
    expect(host.querySelectorAll('article.template-card')).toHaveLength(2);
    expect(host.textContent).toContain('Support triage');
    expect(host.textContent).toContain('Docs Q&A');
    expect(host.textContent).not.toContain('PR reviewer');
    expect(pillNamed(host, 'Support')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens the detail sheet from a card: requirements and the README as text', async () => {
    const host = await mountAt();
    const open = [...host.querySelectorAll<HTMLButtonElement>('button.template-card-open')].find(
      (b) => b.textContent === 'PR reviewer'
    )!;
    await act(async () => open.click());
    await flush();

    expect(window.location.hash).toBe('#/templates?template=pr-reviewer');
    expect(api.getTemplate).toHaveBeenCalledWith('pr-reviewer');

    const el = sheet();
    expect(el.querySelector('.sheet-title')?.textContent).toBe('PR reviewer');
    expect(el.querySelector('.sheet-description')?.textContent).toBe('Engineering');
    const requirements = [...el.querySelectorAll('.template-requirements li')].map((li) => li.textContent);
    expect(requirements).toEqual(['a model API key', 'an MCP server']);
    expect(el.querySelector('pre.template-readme')?.textContent).toBe(PR_README);
  });

  it('deep-links the sheet through ?template= and Use template creates, toasts and opens the canvas', async () => {
    let resolveCreate!: (record: AgentRecord) => void;
    api.createAgentRecord.mockReturnValue(
      new Promise<AgentRecord>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const host = await mountAt('#/templates?template=pr-reviewer');
    await flush();
    expect(api.getTemplate).toHaveBeenCalledWith('pr-reviewer');

    // The footer's primary button reads "Use template", then "Creating…" while pending.
    const useButton = () => document.body.querySelector<HTMLButtonElement>('.sheet-footer .btn-primary')!;
    await act(async () => useButton().click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith({ from: { template: 'pr-reviewer' } });
    expect(useButton().textContent).toBe('Creating…');
    expect(useButton().disabled).toBe(true);

    await act(async () =>
      resolveCreate({ id: 'pr-reviewer-2', spec: { name: 'PR reviewer' } } as AgentRecord)
    );
    await flush();
    expect(toastTexts(host)).toContain('Created “PR reviewer” from PR reviewer');
    expect(window.location.hash).toBe('#/agents/pr-reviewer-2/canvas');
  });

  it('toasts the server message and keeps the sheet open when the create fails', async () => {
    api.createAgentRecord.mockRejectedValue(new Error('template spec is invalid'));
    const host = await mountAt('#/templates?template=pr-reviewer');
    await flush();

    await act(async () => buttonNamed(document.body, 'Use template')!.click());
    await flush();
    expect(toastTexts(host)).toContain('template spec is invalid');
    expect(window.location.hash).toBe('#/templates?template=pr-reviewer');
    expect(sheet()).not.toBeNull();
  });

  it('shows the error state with Retry, then the empty state when the list is empty', async () => {
    api.listTemplates.mockRejectedValueOnce(new Error('boom'));
    const host = await mountAt();
    expect(host.textContent).toContain('Could not load templates');
    expect(host.textContent).toContain('boom');

    api.listTemplates.mockResolvedValueOnce([]);
    await act(async () => buttonNamed(host, 'Retry')!.click());
    await flush();
    expect(api.listTemplates).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('No templates found');
    expect(host.textContent).toContain('The SDK ships six templates');
  });

  it('shows the sheet error with Retry when the detail fetch fails', async () => {
    api.getTemplate.mockRejectedValueOnce(new Error('spec missing'));
    await mountAt('#/templates?template=pr-reviewer');
    await flush();

    const alert = document.body.querySelector('.template-sheet-error[role="alert"]');
    expect(alert?.textContent).toContain('spec missing');
    expect(buttonNamed(document.body, 'Retry')).toBeDefined();
  });

  it('falls back to All for an unknown ?category= and clears the filter from the All pill', async () => {
    const host = await mountAt('#/templates?category=Nope');
    expect(pillNamed(host, 'All')!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelectorAll('article.template-card')).toHaveLength(6);

    await act(async () => pillNamed(host, 'Research')!.click());
    await flush();
    expect(host.querySelectorAll('article.template-card')).toHaveLength(1);

    await act(async () => pillNamed(host, 'All')!.click());
    await flush();
    expect(window.location.hash).toBe('#/templates');
    expect(host.querySelectorAll('article.template-card')).toHaveLength(6);
  });

  it('shows the no-requirements note, an unknown id error with the id as title, and Cancel closes the sheet', async () => {
    api.getTemplate.mockResolvedValueOnce({ ...PR_DETAIL, summary: TEMPLATES[1] } as TemplateDetail);
    await mountAt('#/templates?template=code-architect');
    expect(sheet().querySelector('.sheet-title')?.textContent).toBe('Code architect');
    expect(sheet().querySelector('.template-sheet-note')?.textContent).toBe(
      'Nothing extra. It runs with your default model.'
    );
    expect(sheet().querySelector('.template-requirements')).toBeNull();

    await act(async () => buttonNamed(document.body, 'Cancel')!.click());
    await flush();
    expect(window.location.hash).toBe('#/templates');

    api.getTemplate.mockResolvedValueOnce(undefined);
    window.history.replaceState(null, '', '/#/templates?template=ghost');
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await flush();
    expect(sheet().querySelector('.sheet-title')?.textContent).toBe('ghost');
    expect(sheet().querySelector('.sheet-description')).toBeNull();
    expect(document.body.querySelector('.template-sheet-error[role="alert"]')?.textContent).toBe(
      "No template 'ghost'."
    );
  });

  it('retries the detail fetch from the sheet', async () => {
    api.getTemplate.mockRejectedValueOnce(new Error('spec missing'));
    await mountAt('#/templates?template=pr-reviewer');
    await flush();

    await act(async () => buttonNamed(document.body, 'Retry')!.click());
    await flush();
    expect(api.getTemplate).toHaveBeenCalledTimes(2);
    expect(sheet().querySelector('pre.template-readme')?.textContent).toBe(PR_README);
  });
});
