import { describe, it, expect } from 'vitest';
import { FORBIDDEN_EXECUTION_KEYS, FORBIDDEN_HARNESS_KEYS } from './forbiddenKeys';
import { harnessProfileSchema, harnessSchema, hasExecutableCriterion, type Harness } from './harness';

const instagram: Harness = {
  schema: 'lousho.harness/1',
  extends: ['workspace:social-post'],
  instructions: ['harness/voice.md', 'harness/format.md'],
  audience: { description: 'Followers aged 18 to 34 who skim on mobile.', traits: { tone: 'playful', persona: 'creator' } },
  platform: { id: 'instagram', requirements: { aspectRatio: '4:5', captionMaxChars: 2200, hashtags: { max: 30 } } },
  inputs: {
    schema: {
      type: 'object',
      properties: { brief: { type: 'string' }, product: { type: 'object', properties: { model: { type: 'string' }, tools: { type: 'array' } } } },
      required: ['brief'],
    },
  },
  outputs: { schema: 'schemas/post.json', artifacts: [{ name: 'image', mediaType: 'image/png', required: true }, { name: 'caption', mediaType: 'text/plain' }] },
  capabilities: { require: ['image.generate', 'web.search'] },
  constraints: [{ id: 'no-competitors', text: 'Never name a competitor.' }],
  evaluation: {
    criteria: [
      { id: 'caption-length', description: 'The caption fits Instagram.', check: 'checks/caption-length.ts', weight: 2 },
      { id: 'on-brand', description: 'The voice matches the brand.', rubric: 'Playful, never sarcastic.' },
    ],
    threshold: 0.8,
  },
  runtime: { limits: { maxDurationMs: 120000, maxTurns: 20, maxCostUsd: 0.5 }, modelHints: { temperature: 0.7, reasoning: 'low' } },
  context: { resources: ['resources/brand-palette.md'] },
};

function issuesOf(value: unknown, schema = harnessSchema): { path: (string | number)[]; message: string }[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

const at = (path: string): string => (path.startsWith('[') ? `harness${path}` : `harness.${path}`);
const r13 = (path: string, key: string): string => `${at(path)}: harnesses describe the task; the runtime enforces ${key} (R13)`;
const r18 = (path: string): string => `${at(path)}: a harness says what, not how; execution lives in page.json (R18)`;

function placements(key: string): { doc: Record<string, unknown>; path: string }[] {
  return [
    { doc: { ...instagram, [key]: true }, path: key },
    { doc: { ...instagram, runtime: { limits: { [key]: 1 } } }, path: `runtime.limits.${key}` },
    { doc: { ...instagram, constraints: [{ id: 'a', text: 'b' }, { id: 'c', text: 'd', [key]: [] }] }, path: `constraints[1].${key}` },
    { doc: { ...instagram, audience: { description: 'x', traits: { [key]: 'y' } } }, path: `audience.traits.${key}` },
    { doc: { ...instagram, platform: { id: 'x', requirements: { nested: [{ deep: { [key]: {} } }] } } }, path: `platform.requirements.nested[0].deep.${key}` },
    { doc: { ...instagram, inputs: { schema: { type: 'object', [key]: {} } } }, path: `inputs.schema.${key}` },
    { doc: { ...instagram, outputs: { schema: { type: 'object', properties: { a: { type: 'object', [key]: 'x' } } } } }, path: `outputs.schema.properties.a.${key}` },
    { doc: { ...instagram, outputs: { schema: { type: 'object', properties: { a: { type: 'object', default: { [key]: 'x' } } } } } }, path: `outputs.schema.properties.a.default.${key}` },
  ];
}

describe('harnessSchema', () => {
  it('accepts the Instagram page harness', () => {
    const result = harnessSchema.safeParse(instagram);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(instagram);
  });

  it('accepts the smallest harness', () => {
    expect(issuesOf({ schema: 'lousho.harness/1' })).toEqual([]);
  });

  it('each forbidden key at any depth is an error naming R13', () => {
    expect(FORBIDDEN_HARNESS_KEYS).toEqual(['permissions', 'tools', 'secrets', 'sandbox', 'approvals', 'mcpServers', 'hooks', 'model', 'provider', 'network']);
    for (const key of FORBIDDEN_HARNESS_KEYS) {
      for (const { doc, path } of placements(key)) {
        expect(issuesOf(doc), `${key} at ${path}`).toEqual([{ path: path.replace(/\[(\d+)\]/g, '.$1').split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)), message: r13(path, key) }]);
      }
    }
  });

  it('each execution key at any depth is an error naming R18', () => {
    expect(FORBIDDEN_EXECUTION_KEYS).toEqual(['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates']);
    for (const key of FORBIDDEN_EXECUTION_KEYS) {
      for (const { doc, path } of placements(key)) {
        expect(issuesOf(doc).map((issue) => issue.message), `${key} at ${path}`).toEqual([r18(path)]);
      }
    }
  });

  it('matches forbidden keys ignoring case, whitespace, dashes, underscores and invisible characters', () => {
    expect(issuesOf({ ...instagram, Tools: [] }).map((i) => i.message)).toEqual([r13('Tools', 'tools')]);
    expect(issuesOf({ ...instagram, ' tools ': [] }).map((i) => i.message)).toEqual([r13('[" tools "]', 'tools')]);
    expect(issuesOf({ ...instagram, mcp_servers: {} }).map((i) => i.message)).toEqual([r13('mcp_servers', 'mcpServers')]);
    expect(issuesOf({ ...instagram, 'MCP-Servers': {} }).map((i) => i.message)).toEqual([r13('["MCP-Servers"]', 'mcpServers')]);
    expect(issuesOf({ ...instagram, 'mo​del': 'x' }).map((i) => i.message)).toEqual([r13('["mo\\u200bdel"]', 'model')]);
    expect(issuesOf({ ...instagram, audience: { description: 'x', traits: { WorkFlow: 'y' } } }).map((i) => i.message)).toEqual([r18('audience.traits.WorkFlow')]);
  });

  it('reports every forbidden key at once and nothing else', () => {
    const issues = issuesOf({ ...instagram, tools: [], steps: [], unknownKey: 1, platform: { network: {} } });
    expect(issues.map((i) => i.message)).toEqual([r13('platform.network', 'network'), r13('tools', 'tools'), r18('steps')]);
  });

  it('does not flag keys that only contain a forbidden word', () => {
    const doc = { ...instagram, audience: { description: 'x', traits: { 'role-model': 'y', toolset: 'z', goals: 'w' } } };
    expect(issuesOf(doc)).toEqual([]);
  });

  it('treats property names inside an embedded JSON Schema as data, not harness keys', () => {
    const schema = {
      type: 'object',
      properties: { model: { type: 'string' }, tools: { type: 'array', items: { type: 'object', properties: { steps: { type: 'integer' } } } } },
      patternProperties: { '^provider': { type: 'string' } },
      $defs: { goal: { type: 'string' } },
      definitions: { lead: { type: 'string' } },
      dependentSchemas: { secrets: { type: 'object' } },
      required: ['model', 'tools'],
    };
    expect(issuesOf({ ...instagram, inputs: { schema }, outputs: { schema } })).toEqual([]);
  });

  it('still flags a forbidden key in keyword position inside a property of an embedded JSON Schema', () => {
    const schema = { type: 'object', properties: { model: { type: 'string', tools: ['shell'] } } };
    expect(issuesOf({ ...instagram, inputs: { schema } }).map((i) => i.message)).toEqual([r13('inputs.schema.properties.model.tools', 'tools')]);
  });

  it('does not treat properties outside an embedded JSON Schema as data', () => {
    const doc = { ...instagram, platform: { id: 'x', requirements: { properties: { tools: 'y' } } } };
    expect(issuesOf(doc).map((i) => i.message)).toEqual([r13('platform.requirements.properties.tools', 'tools')]);
  });

  it('accepts dependentRequired names under an embedded JSON Schema', () => {
    const schema = { type: 'object', properties: { model: { type: 'string' }, brand: { type: 'string' } }, dependentRequired: { model: ['brand'] }, dependencies: { tools: ['brand'] } };
    expect(issuesOf({ ...instagram, inputs: { schema } })).toEqual([]);
  });

  it('scans a name-map entry whose value is not a schema', () => {
    const schema = { type: 'object', $defs: { tools: ['Bash'] } };
    expect(issuesOf({ ...instagram, inputs: { schema } }).map((i) => i.message)).toEqual([r13('inputs.schema.$defs.tools', 'tools')]);
    const required = { type: 'object', dependentRequired: { model: { type: 'string' } } };
    expect(issuesOf({ ...instagram, inputs: { schema: required } }).map((i) => i.message)).toEqual([r13('inputs.schema.dependentRequired.model', 'model')]);
  });

  it('reports deep nesting and cycles as issues instead of throwing', () => {
    let deep: unknown = ['x'];
    for (let level = 0; level < 2000; level++) deep = [deep];
    const deepIssues = issuesOf({ ...instagram, platform: { id: 'x', requirements: { deep } } });
    expect(deepIssues).toHaveLength(1);
    expect(deepIssues[0].message).toMatch(/^harness\.platform\.requirements\.deep(\[0\])+: nests deeper than 64 levels$/);
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic.requirements = { self: cyclic };
    const cyclicIssues = issuesOf({ ...instagram, platform: cyclic });
    expect(cyclicIssues).toHaveLength(1);
    expect(cyclicIssues[0].message).toContain('nests deeper than 64 levels');
  });

  it('rejects inherited properties, getters, Maps and class instances as not plain JSON data', () => {
    const inherited = Object.assign(Object.create({ platform: { id: 'x', requirements: { tools: ['Bash'] } } }) as object, { schema: 'lousho.harness/1' });
    expect(issuesOf(inherited)).toEqual([{ path: [], message: 'harness: must be plain JSON data: no class instances, Maps, inherited properties or getters' }]);
    let reads = 0;
    const getter = Object.defineProperty({ schema: 'lousho.harness/1' }, 'platform', { enumerable: true, get: () => (++reads > 1 ? { id: 'x', requirements: { tools: ['Bash'] } } : { id: 'x' }) });
    expect(issuesOf(getter).map((i) => i.path)).toEqual([['platform']]);
    const hidden = Object.defineProperty({ schema: 'lousho.harness/1' }, 'platform', { enumerable: false, value: { id: 'x', requirements: { tools: ['Bash'] } } });
    expect(issuesOf(hidden).map((i) => i.message)).toEqual([r13('platform.requirements.tools', 'tools')]);
    expect(issuesOf({ ...instagram, platform: { id: 'x', requirements: { map: new Map([['tools', ['Bash']]]) } } }).map((i) => i.path)).toEqual([['platform', 'requirements', 'map']]);
    const properties = Object.defineProperty({}, 'name', { enumerable: true, get: () => ({ type: 'string' }) });
    expect(issuesOf({ ...instagram, inputs: { schema: { type: 'object', properties } } }).map((i) => i.path)).toEqual([['inputs', 'schema', 'properties', 'name']]);
    class Requirements { tools = ['Bash']; }
    expect(issuesOf({ ...instagram, platform: { id: 'x', requirements: new Requirements() } }).map((i) => i.path)).toEqual([['platform', 'requirements']]);
  });

  it('validates the scanned copy, so a Proxy get trap cannot add keys after the scan', () => {
    const proxy = new Proxy(
      { schema: 'lousho.harness/1', platform: { id: 'x' } },
      { get: (target, key, receiver) => (key === 'platform' ? { id: 'x', requirements: { tools: ['Bash'] } } : Reflect.get(target, key, receiver)) }
    );
    const result = harnessSchema.safeParse(proxy);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ schema: 'lousho.harness/1', platform: { id: 'x' } });
  });

  it('reports a throwing Proxy trap as an issue instead of throwing', () => {
    const throwingGet = new Proxy({ id: 'x' }, { get: () => { throw new Error('boom'); } });
    expect(issuesOf({ schema: 'lousho.harness/1', platform: throwingGet })).toEqual([]);
    const throwingKeys = new Proxy({ schema: 'lousho.harness/1' }, { ownKeys: () => { throw new Error('boom'); } });
    expect(issuesOf(throwingKeys)).toEqual([{ path: [], message: 'harness: must be plain JSON data: it could not be read' }]);
    const nested = { ...instagram, platform: { id: 'x', requirements: { deep: new Proxy({}, { getPrototypeOf: () => { throw new Error('boom'); } }) } } };
    expect(issuesOf(nested)).toEqual([{ path: ['platform', 'requirements', 'deep'], message: 'harness.platform.requirements.deep: must be plain JSON data: it could not be read' }]);
  });

  it('a profile without id and version is an error', () => {
    const profile = { schema: 'lousho.harness/1', id: 'social-post', version: '2.0.1', instructions: ['social.md'] };
    expect(issuesOf(profile, harnessProfileSchema)).toEqual([]);
    const { id: _id, ...noId } = profile;
    const { version: _version, ...noVersion } = profile;
    expect(issuesOf(noId, harnessProfileSchema).map((issue) => issue.path)).toEqual([['id']]);
    expect(issuesOf(noVersion, harnessProfileSchema).map((issue) => issue.path)).toEqual([['version']]);
    expect(issuesOf({ ...profile, version: 'v2' }, harnessProfileSchema)[0].path).toEqual(['version']);
    expect(issuesOf({ ...profile, id: 'Social Post' }, harnessProfileSchema)[0].path).toEqual(['id']);
    expect(issuesOf({ ...profile, tools: [] }, harnessProfileSchema).map((i) => i.message)).toEqual([r13('tools', 'tools')]);
    expect(issuesOf(noId)).toEqual([]);
  });

  it('capabilities.require accepts dotted names', () => {
    expect(issuesOf({ schema: 'lousho.harness/1', capabilities: { require: ['image.generate', 'web.search.news', 'shell'] } })).toEqual([]);
    for (const bad of ['', '.web', 'web.', 'web..search', 'web search', 'web/search']) {
      expect(issuesOf({ schema: 'lousho.harness/1', capabilities: { require: [bad] } })[0].path, bad).toEqual(['capabilities', 'require', 0]);
    }
    expect(issuesOf({ schema: 'lousho.harness/1', capabilities: { grant: ['shell'] } })[0].path).toEqual(['capabilities']);
  });

  it('inputs.schema must be an object schema', () => {
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: 'schemas/input.json' } })).toEqual([]);
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: { type: 'string' } } })[0].path).toEqual(['inputs', 'schema']);
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: { properties: {} } } })[0].path).toEqual(['inputs', 'schema']);
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: [] } })[0].path).toEqual(['inputs', 'schema']);
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: { '~standard': {}, type: 'object' } } })[0].path).toEqual(['inputs', 'schema']);
    expect(issuesOf({ schema: 'lousho.harness/1', inputs: { schema: '../outside.json' } })[0].path).toEqual(['inputs', 'schema']);
    expect(issuesOf({ schema: 'lousho.harness/1', outputs: { schema: { type: 'string' } } })).toEqual([]);
  });

  it('a rubric-only evaluation has no executable criterion', () => {
    const rubricOnly: Harness = { schema: 'lousho.harness/1', evaluation: { criteria: [{ id: 'tone', description: 'Tone fits.', rubric: 'Warm.' }] } };
    expect(issuesOf(rubricOnly)).toEqual([]);
    expect(hasExecutableCriterion(rubricOnly)).toBe(false);
    expect(hasExecutableCriterion({ schema: 'lousho.harness/1' })).toBe(false);
    expect(hasExecutableCriterion(instagram)).toBe(true);
  });

  it('rejects a criterion with neither check nor rubric', () => {
    expect(issuesOf({ schema: 'lousho.harness/1', evaluation: { criteria: [{ id: 'x', description: 'y' }] } })[0].path).toEqual(['evaluation', 'criteria', 0]);
  });

  it('accepts plain artifact file names', () => {
    for (const name of ['image', 'caption.txt', 'final cut.mp4', 'rapport-été.pdf']) {
      expect(issuesOf({ schema: 'lousho.harness/1', outputs: { artifacts: [{ name, mediaType: 'text/plain' }] } }), name).toEqual([]);
    }
  });

  it('rejects artifact names a page UI could never reference: URLs, separators, colons, control characters, dots and markup', () => {
    const bad = ['https://example.com/a.png', 'a/b.png', 'a\\b.png', 'C:file', 'a\u0000b', 'a\u202eb', '.', '..', ' ', '<img src=x>', 'javascript:alert(1)', 'x'.repeat(201), '.env', '.hidden.txt', '\u5831'.repeat(150), '\u2028', 'a\u2029b'];
    for (const name of bad) {
      const found = issuesOf({ schema: 'lousho.harness/1', outputs: { artifacts: [{ name, mediaType: 'text/plain' }] } });
      expect(found.map((issue) => issue.path), JSON.stringify(name)).toEqual([['outputs', 'artifacts', 0, 'name']]);
    }
  });

  it('rejects duplicate constraint, criterion and artifact ids', () => {
    const doc = {
      schema: 'lousho.harness/1',
      constraints: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }],
      evaluation: { criteria: [{ id: 'c', description: 'x', check: 'c.ts' }, { id: 'c', description: 'y', rubric: 'r' }] },
      outputs: { artifacts: [{ name: 'image', mediaType: 'image/png' }, { name: 'image', mediaType: 'image/jpeg' }] },
    };
    expect(issuesOf(doc)).toEqual([
      { path: ['outputs', 'artifacts', 1, 'name'], message: "duplicate name 'image'" },
      { path: ['constraints', 1, 'id'], message: "duplicate id 'a'" },
      { path: ['evaluation', 'criteria', 1, 'id'], message: "duplicate id 'c'" },
    ]);
  });

  it('rejects unknown keys, instructions that are not relative .md paths, and out-of-range numbers', () => {
    expect(issuesOf({ ...instagram, unknownKey: 1 })[0].message).toContain('unknownKey');
    expect(issuesOf({ schema: 'lousho.harness/1', instructions: ['voice.txt'] })[0].path).toEqual(['instructions', 0]);
    expect(issuesOf({ schema: 'lousho.harness/1', instructions: ['/etc/voice.md'] })[0].path).toEqual(['instructions', 0]);
    expect(issuesOf({ schema: 'lousho.harness/1', evaluation: { criteria: [], threshold: 1.5 } })[0].path).toEqual(['evaluation', 'threshold']);
    expect(issuesOf({ schema: 'lousho.harness/1', runtime: { modelHints: { temperature: 3 } } })[0].path).toEqual(['runtime', 'modelHints', 'temperature']);
    expect(issuesOf({ schema: 'lousho.harness/1', runtime: { limits: { maxTurns: 0 } } })[0].path).toEqual(['runtime', 'limits', 'maxTurns']);
    expect(issuesOf({ schema: 'lousho.harness/2' })[0].path).toEqual(['schema']);
    expect(issuesOf('not an object')).toHaveLength(1);
  });
});
