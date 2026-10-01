import { describe, it, expect, vi, afterEach } from 'vitest';
import prompts from 'prompts';
import { askMissing } from './prompts';

const defaults = { dir: 'my-agent', provider: 'openai', template: 'minimal' };

describe('askMissing', () => {
  it('asks every question when nothing is known (injected, non-interactive answers)', async () => {
    prompts.inject(['demo', 'anthropic', 'tools']);
    expect(await askMissing({ known: {}, defaults })).toEqual({
      dir: 'demo',
      provider: 'anthropic',
      template: 'tools',
    });
  });

  it('only asks for what the flags did not provide', async () => {
    prompts.inject(['ollama']);
    expect(await askMissing({ known: { dir: 'given', template: 'yaml' }, defaults })).toEqual({
      dir: 'given',
      provider: 'ollama',
      template: 'yaml',
    });
  });

  it('asks nothing when every answer is known', async () => {
    const known = { dir: 'a', provider: 'openrouter', template: 'minimal' };
    expect(await askMissing({ known, defaults })).toEqual(known);
  });

  it('rejects when the user cancels (Ctrl+C)', async () => {
    prompts.inject([new Error('cancel')]);
    await expect(askMissing({ known: {}, defaults })).rejects.toThrow('cancelled');
  });
});

describe('askMissing without the optional prompts peer (LOU-D40)', () => {
  afterEach(() => {
    vi.doUnmock('prompts');
    vi.resetModules();
  });

  it('rejects with the install hint (and a way around it) instead of failing at import time', async () => {
    vi.resetModules();
    vi.doMock('prompts', () => {
      throw Object.assign(new Error("Cannot find module 'prompts'"), { code: 'MODULE_NOT_FOUND' });
    });
    const { askMissing: ask } = await import('./prompts');
    const error = await ask({ known: {}, defaults }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'MissingPeerDependencyError', installCommand: 'npm install prompts@^2.4.2' });
    expect((error as Error).message).toContain('--yes');
  });

  it('importing the module does not load the peer', async () => {
    vi.resetModules();
    vi.doMock('prompts', () => {
      throw Object.assign(new Error("Cannot find module 'prompts'"), { code: 'MODULE_NOT_FOUND' });
    });
    await expect(import('./prompts')).resolves.toHaveProperty('askMissing');
  });
});
