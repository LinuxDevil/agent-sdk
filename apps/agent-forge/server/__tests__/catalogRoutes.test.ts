import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { listBuiltinTools, listGuardrails, listModels, listTriggerTypes } from 'lousho';
import { registerCatalogRoutes } from '../routes/catalogRoutes';
import { SecretsStore } from '../secretsStore';
import { sdkRootDir } from '../sdkRoot';

/**
 * The catalog routes expose the SDK's catalogs (S06 tools, S07 models,
 * S11 guardrails, S22a trigger types) plus the registry index's skills and
 * kits, so the canvas pickers and the Author read the real lists instead of
 * hard-coding names. `registerCatalogRoutes` mounts on a bare Express app
 * here; the token gate that also covers `/catalog/**` is tokenGate.test.ts's.
 */
describe('catalog routes', () => {
  let baseDir: string;
  let secrets: SecretsStore;
  let app: Express;

  function mount(registryIndexPath?: string): Express {
    const mounted = express();
    registerCatalogRoutes(mounted, { secretsStore: secrets, ...(registryIndexPath ? { registryIndexPath } : {}) });
    return mounted;
  }

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-catalog-'));
    secrets = new SecretsStore(baseDir);
    app = mount();
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('GET /catalog/models returns the SDK catalog (deep-equal)', async () => {
    const res = await request(app).get('/catalog/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listModels());
  });

  it('GET /catalog/models?provider= filters to that provider', async () => {
    const res = await request(app).get('/catalog/models?provider=anthropic');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listModels({ provider: 'anthropic' }));
    expect(res.body.every((m: { provider: string }) => m.provider === 'anthropic')).toBe(true);
  });

  it('GET /catalog/models?provider= (empty) -> 400 LOUSHO_QUERY_INVALID', async () => {
    const res = await request(app).get('/catalog/models?provider=');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "'provider' must be a non-empty string", code: 'LOUSHO_QUERY_INVALID' });
  });

  it('a stored provider key makes its models available even with the env key unset', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    secrets.setKey('anthropic', 'k');
    try {
      const res = await request(app).get('/catalog/models?provider=anthropic');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((m: { available: boolean }) => m.available)).toBe(true);
    } finally {
      secrets.removeKey('anthropic');
    }
    // Without the stored key or env, the same models are unavailable.
    const res = await request(app).get('/catalog/models?provider=anthropic');
    expect(res.body.every((m: { available: boolean }) => !m.available)).toBe(true);
  });

  it('GET /catalog/tools returns listBuiltinTools() (deep-equal)', async () => {
    const res = await request(app).get('/catalog/tools');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listBuiltinTools());
  });

  it('GET /catalog/guardrails returns listGuardrails() (deep-equal)', async () => {
    const res = await request(app).get('/catalog/guardrails');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listGuardrails());
  });

  it('GET /catalog/triggers returns listTriggerTypes() (deep-equal)', async () => {
    const res = await request(app).get('/catalog/triggers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listTriggerTypes());
  });

  it("GET /catalog/skills lists the repo registry's skills as { registry } refs", async () => {
    const res = await request(app).get('/catalog/skills');
    expect(res.status).toBe(200);
    const names = res.body.map((s: { name: string }) => s.name);
    expect(names).toContain('changelog');
    expect(names).toContain('code-review');
    for (const skill of res.body as { name: string; description: string; ref: { registry: string } }[]) {
      expect(skill.description).toEqual(expect.any(String));
      expect(skill.ref).toEqual({ registry: skill.name });
    }
  });

  it("GET /catalog/kits lists the repo registry's four kits", async () => {
    const res = await request(app).get('/catalog/kits');
    expect(res.status).toBe(200);
    const names = res.body.map((k: { name: string }) => k.name);
    expect(names).toEqual(expect.arrayContaining(['coding-kit', 'coding-pi', 'inbox-triage', 'incident-response']));
  });

  it('a missing registry index -> [] with one console.warn, not 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = mount(path.join(baseDir, 'no-such-index.json'));
    const skills = await request(broken).get('/catalog/skills');
    const kits = await request(broken).get('/catalog/kits');
    expect(skills.status).toBe(200);
    expect(skills.body).toEqual([]);
    expect(kits.status).toBe(200);
    expect(kits.body).toEqual([]);
    // One warn for the whole registration, not one per request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unparsable registry index -> [] with one console.warn', async () => {
    const badIndex = path.join(baseDir, 'bad-index.json');
    fs.writeFileSync(badIndex, '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = mount(badIndex);
    const res = await request(broken).get('/catalog/skills');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('registry items without string name/type/description are filtered out', async () => {
    const custom = path.join(baseDir, 'custom-index.json');
    fs.writeFileSync(
      custom,
      JSON.stringify({
        items: [
          { name: 'good-skill', type: 'skill', description: 'fine' },
          { name: 'no-type', description: 'missing type' },
          { name: 42, type: 'skill', description: 'numeric name' },
          { type: 'kit', description: 'no name' },
        ],
      })
    );
    const mounted = mount(custom);
    const skills = await request(mounted).get('/catalog/skills');
    expect(skills.body).toEqual([{ name: 'good-skill', description: 'fine', ref: { registry: 'good-skill' } }]);
    expect((await request(mounted).get('/catalog/kits')).body).toEqual([]);
  });
});

describe('sdkRootDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the SDK package root (three levels above server/)', () => {
    // The registry index sits under it in the repo and in the shipped package.
    expect(fs.existsSync(path.join(sdkRootDir(), 'registry', 'dist', 'index.json'))).toBe(true);
  });

  it('honours LOUSHO_SDK_ROOT', () => {
    vi.stubEnv('LOUSHO_SDK_ROOT', '/tmp/elsewhere');
    expect(sdkRootDir()).toBe('/tmp/elsewhere');
  });
});
