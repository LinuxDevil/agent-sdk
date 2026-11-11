import { describe, it, expect } from 'vitest';
import { resolvePageModel } from './models';
import { workspaceManifestSchema } from './workspace';
import { pageSchema } from './page';

const workspace = {
  schema: 'lousho.workspace/1',
  id: 'marketing',
  name: 'Marketing',
  version: '1.0.0',
  description: 'Plans and writes social content.',
  mainAgent: null,
  pages: ['instagram'],
};

const page = {
  schema: 'lousho.page/1',
  id: 'instagram',
  name: 'Instagram',
  description: 'Writes Instagram posts.',
  harness: { extends: [] },
  execution: { type: 'single', single: { agent: 'writer' } },
};

const all = {
  attachmentModel: 'anthropic/a',
  pageDefault: 'anthropic/p',
  agentDefault: 'anthropic/g',
  workspaceDefault: 'anthropic/w',
};

describe('models.provider schema', () => {
  it('workspace.json accepts models.provider and null', () => {
    expect(workspaceManifestSchema.safeParse({ ...workspace, models: { provider: 'pi' } }).success).toBe(true);
    expect(workspaceManifestSchema.safeParse({ ...workspace, models: { provider: null } }).success).toBe(true);
    expect(workspaceManifestSchema.safeParse({ ...workspace, models: {} }).success).toBe(true);
  });

  it('page.json accepts models.provider and null', () => {
    expect(pageSchema.safeParse({ ...page, models: { provider: 'pi' } }).success).toBe(true);
    expect(pageSchema.safeParse({ ...page, models: { provider: null } }).success).toBe(true);
  });

  it('rejects a bad provider name with its path', () => {
    for (const provider of ['Pi', 'pi/x', '', '9pi', 'p i']) {
      const result = workspaceManifestSchema.safeParse({ ...workspace, models: { provider } });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['models', 'provider']);
    }
    const onPage = pageSchema.safeParse({ ...page, models: { provider: 'PI' } });
    expect(onPage.success).toBe(false);
  });

  it('rejects an unknown key under models', () => {
    const result = pageSchema.safeParse({ ...page, models: { provider: 'pi', model: 'anthropic/x' } });
    expect(result.success).toBe(false);
  });

  it('proposerModel stays as written in a parsed manifest (R8)', () => {
    const parsed = workspaceManifestSchema.parse({ ...workspace, models: { provider: 'pi' }, improve: { proposerModel: 'openai/gpt-5' } });
    expect(parsed.improve?.proposerModel).toBe('openai/gpt-5');
  });
});

describe('resolvePageModel', () => {
  it('attachment model wins over every other level', () => {
    expect(resolvePageModel(all)).toEqual({ model: 'anthropic/a', source: 'attachment' });
  });

  it('page default wins over agent and workspace', () => {
    expect(resolvePageModel({ ...all, attachmentModel: undefined })).toEqual({ model: 'anthropic/p', source: 'page' });
  });

  it('agent default wins over workspace', () => {
    expect(resolvePageModel({ agentDefault: 'anthropic/g', workspaceDefault: 'anthropic/w' })).toEqual({ model: 'anthropic/g', source: 'agent' });
  });

  it('workspace default is the last resort', () => {
    expect(resolvePageModel({ workspaceDefault: 'anthropic/w' })).toEqual({ model: 'anthropic/w', source: 'workspace' });
  });

  it('missing model resolves to none', () => {
    expect(resolvePageModel({ workspaceProvider: 'pi' })).toEqual({ model: undefined, source: 'none' });
    expect(resolvePageModel({})).toEqual({ model: undefined, source: 'none' });
  });

  it('wraps with the workspace provider', () => {
    expect(resolvePageModel({ pageDefault: 'anthropic/p', workspaceProvider: 'pi' })).toEqual({ model: 'pi/anthropic/p', source: 'page' });
  });

  it('page provider overrides the workspace provider', () => {
    expect(resolvePageModel({ pageDefault: 'anthropic/p', pageProvider: 'openrouter', workspaceProvider: 'pi' }).model).toBe('openrouter/anthropic/p');
  });

  it('page provider null opts the page out of the workspace wrapper', () => {
    expect(resolvePageModel({ pageDefault: 'anthropic/p', pageProvider: null, workspaceProvider: 'pi' }).model).toBe('anthropic/p');
  });

  it('workspace provider null and no page key leaves the model unwrapped', () => {
    expect(resolvePageModel({ pageDefault: 'anthropic/p', workspaceProvider: null })).toEqual({ model: 'anthropic/p', source: 'page' });
  });

  it('page null and an absent workspace provider both leave the model unwrapped', () => {
    expect(resolvePageModel({ agentDefault: 'anthropic/g', pageProvider: null }).model).toBe('anthropic/g');
    expect(resolvePageModel({ agentDefault: 'anthropic/g' }).model).toBe('anthropic/g');
    expect(resolvePageModel({ agentDefault: 'anthropic/g', pageProvider: 'pi' }).model).toBe('pi/anthropic/g');
  });

  it('never double-wraps', () => {
    expect(resolvePageModel({ attachmentModel: 'pi/anthropic/a', workspaceProvider: 'pi' }).model).toBe('pi/anthropic/a');
  });

  it('wraps every precedence level the same way', () => {
    expect(resolvePageModel({ agentDefault: 'anthropic/g', workspaceProvider: 'pi' })).toEqual({ model: 'pi/anthropic/g', source: 'agent' });
    expect(resolvePageModel({ workspaceDefault: 'anthropic/w', workspaceProvider: 'pi' })).toEqual({ model: 'pi/anthropic/w', source: 'workspace' });
  });
});
