/**
 * Template routes - `GET /templates` and `GET /templates/:id`
 * (server/templates/templateCatalog.ts), driven against a temp
 * templates dir through `createApp`'s `templateCatalog` option; the last
 * test runs against the SDK's real shipped `templates/` folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentStore } from '../../src/persistence/AgentStore';
import { sdkRootDir } from '../sdkRoot';
import { TemplateCatalog } from '../templates/templateCatalog';
import type { TemplateDetail, TemplateSummary } from '../../shared/wireTypes';

const SPEC_YAML = ['version: 2', 'name: Fixture agent', 'model: mock/mock-1', 'instructions: Do fixture things.', ''].join(
  '\n'
);

interface TemplateFixtureOptions {
  /** Raw template.json content (defaults to `JSON.stringify(json)`). */
  templateJson?: string;
  /** spec.yaml content (defaults to {@link SPEC_YAML}). */
  specYaml?: string;
  /** README.md content; absent means no README file is written. */
  readme?: string;
}

/** A valid-by-default template.json body; `over` overrides or adds keys. */
function templateJson(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Template ${id}`,
    description: 'A fixture template.',
    category: 'testing',
    tags: ['one'],
    requires: ['provider_key'],
    ...over,
  };
}

/** Writes `dir/<id>/{template.json,spec.yaml,README.md}` - README and spec per `options`. */
function writeTemplate(
  dir: string,
  id: string,
  json: Record<string, unknown>,
  options: TemplateFixtureOptions = {}
): void {
  const folder = path.join(dir, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'template.json'), options.templateJson ?? JSON.stringify(json));
  fs.writeFileSync(path.join(folder, 'spec.yaml'), options.specYaml ?? SPEC_YAML);
  if (options.readme !== undefined) fs.writeFileSync(path.join(folder, 'README.md'), options.readme);
}

describe('/templates routes', () => {
  let baseDir: string;
  let templatesDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;
  let catalog: TemplateCatalog;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d17-ws-'));
    templatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d17-tpl-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    catalog = new TemplateCatalog(templatesDir);

    writeTemplate(templatesDir, 'zebra', templateJson('zebra', { title: 'Zebra', category: 'animals' }), {
      readme: '# Zebra\n\nReads like a zebra.\n',
    });
    writeTemplate(templatesDir, 'aardvark', templateJson('aardvark', { title: 'Aardvark', category: 'animals' }));
    writeTemplate(templatesDir, 'newbie', templateJson('newbie', { title: 'Zzz last title', category: 'aaa' }));
    // A folder that looks like a template but has a broken template.json
    // must be skipped, not take the list down.
    fs.mkdirSync(path.join(templatesDir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'broken', 'template.json'), '{ not json');
    fs.writeFileSync(path.join(templatesDir, 'broken', 'spec.yaml'), SPEC_YAML);
    // A folder whose name can never be a template id is not a template at all.
    fs.mkdirSync(path.join(templatesDir, 'Not A Template'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(templatesDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir, templateCatalog: catalog });

  it('GET /templates lists valid summaries sorted by category then title, skipping invalid folders', async () => {
    const res = await request(app()).get('/templates');
    expect(res.status).toBe(200);
    const list = res.body as TemplateSummary[];
    // 'aaa' category first, then 'animals' sorted by title; 'broken' and
    // 'Not A Template' do not appear.
    expect(list.map((t) => t.id)).toEqual(['newbie', 'aardvark', 'zebra']);
    expect(list[0]).toEqual({
      id: 'newbie',
      title: 'Zzz last title',
      description: 'A fixture template.',
      category: 'aaa',
      tags: ['one'],
      requires: ['provider_key'],
    });
  });

  it('GET /templates answers [] when the templates dir is missing', async () => {
    const missing = createApp({
      agentStore,
      runManager,
      baseDir,
      templateCatalog: new TemplateCatalog(path.join(templatesDir, 'does-not-exist')),
    });
    const res = await request(missing).get('/templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /templates/:id returns the summary, the parsed v2 spec and the README', async () => {
    const res = await request(app()).get('/templates/zebra');
    expect(res.status).toBe(200);
    const detail = res.body as TemplateDetail;
    expect(detail.summary).toMatchObject({ id: 'zebra', title: 'Zebra', category: 'animals' });
    expect(detail.spec).toMatchObject({ version: 2, name: 'Fixture agent', model: 'mock/mock-1' });
    expect(detail.readme).toBe('# Zebra\n\nReads like a zebra.\n');
  });

  it("GET /templates/:id answers readme '' when the template ships no README.md", async () => {
    const res = await request(app()).get('/templates/aardvark');
    expect(res.status).toBe(200);
    expect((res.body as TemplateDetail).readme).toBe('');
  });

  it('GET /templates/:id 404s LOUSHO_TEMPLATE_NOT_FOUND for a missing or invalid template', async () => {
    const res = await request(app()).get('/templates/ghost');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No template 'ghost'", code: 'LOUSHO_TEMPLATE_NOT_FOUND' });

    // A folder present on disk but invalid is a 404 too.
    const broken = await request(app()).get('/templates/broken');
    expect(broken.status).toBe(404);
    expect(broken.body.code).toBe('LOUSHO_TEMPLATE_NOT_FOUND');
  });

  it.each([['/templates/Bad_Id'], ['/templates/a..b'], ['/templates/-lead'], [`/templates/${encodeURIComponent('../x')}`]])(
    'GET %s 400s LOUSHO_TEMPLATE_ID_INVALID',
    async (path0) => {
      const res = await request(app()).get(path0);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid template id', code: 'LOUSHO_TEMPLATE_ID_INVALID' });
    }
  );

  it('GET /templates/../x 400s - the id never reaches the filesystem', async () => {
    const res = await request(app()).get('/templates/../x');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid template id', code: 'LOUSHO_TEMPLATE_ID_INVALID' });
  });
});

describe('the SDK shipped templates', () => {
  it('lists the six shipped templates and reads pr-reviewer (skips when templates/ is absent)', (ctx) => {
    const dir = path.join(sdkRootDir(), 'templates');
    if (!fs.existsSync(dir)) return ctx.skip();
    return (async () => {
      const catalog = new TemplateCatalog();
      const list = await catalog.list();
      expect(list.map((t) => t.id).sort()).toEqual([
        'docs-qa',
        'inbox-triage',
        'incident-responder',
        'pr-reviewer',
        'research-assistant',
        'support-triage',
      ]);
      const detail = await catalog.get('pr-reviewer');
      expect(detail?.summary.title).toBe('Pull request reviewer');
      expect(detail?.spec.version).toBe(2);
      expect(detail?.spec.model).toBe('anthropic/claude-sonnet-5-5');
      expect(detail?.readme.length).toBeGreaterThan(0);
    })();
  });
});
