import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { configureStudioHome, studioPaths, studioPathsFor } from '../studioPaths';

describe('studioPathsFor', () => {
  it('derives every Studio-global file under the home directory', () => {
    expect(studioPathsFor('/h')).toEqual({
      home: '/h',
      workspaces: path.join('/h', 'workspaces.json'),
      settings: path.join('/h', 'settings.json'),
      secrets: path.join('/h', 'secrets.json'),
      secretsKey: path.join('/h', 'secrets.key'),
      sessions: path.join('/h', 'assistant', 'sessions'),
      spend: path.join('/h', 'passes', 'spend.jsonl'),
      alerts: path.join('/h', 'inbox', 'alerts.json'),
      serve: path.join('/h', 'serve.json'),
    });
  });
});

describe('studioPaths', () => {
  it('throws before configureStudioHome runs', async () => {
    vi.resetModules();
    const fresh = await import('../studioPaths');
    expect(() => fresh.studioPaths()).toThrow('Studio home is not configured; createApp() sets it.');
  });

  it('returns the configured paths after configureStudioHome', () => {
    const configured = configureStudioHome('/h2');
    expect(studioPaths()).toEqual(configured);
    expect(studioPaths().home).toBe('/h2');
  });
});
