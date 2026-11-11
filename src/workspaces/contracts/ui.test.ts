import { describe, expect, it } from 'vitest';
import type { Harness } from './harness';
import { pageUiSchema, UI_COMPONENTS, validateUiBindings, type PageUi, type UiBindingTarget, type UiComponent } from './ui';

const composedInstagram: UiBindingTarget = {
  inputs: {
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            topic: { type: 'string', minLength: 3 },
            duration: { type: 'integer', minimum: 15, maximum: 90 },
            tone: { type: 'string', enum: ['playful', 'informative', 'bold'] },
          },
          required: ['topic', 'duration'],
        },
        {
          type: 'object',
          properties: {
            audience: { type: 'object', properties: { segment: { type: 'string' }, region: { type: 'string', default: 'global' } }, required: ['segment', 'region'] },
            draft: { type: 'boolean', default: false },
          },
          required: ['tone', 'audience', 'draft'],
        },
      ],
    },
  },
  outputs: {
    schema: { type: 'object', properties: { script: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } } },
    artifacts: [
      { name: 'video', mediaType: 'video/mp4', required: true },
      { name: 'cover', mediaType: 'image/png' },
    ],
  },
};

const instagramUi: PageUi = {
  schema: 'lousho.ui/1',
  title: 'Instagram reel',
  layout: {
    type: 'stack',
    children: [
      {
        type: 'section',
        label: 'Brief',
        children: [
          { type: 'text', bind: 'inputs.topic', label: 'Topic', placeholder: 'What is the reel about?' },
          { type: 'slider', bind: 'inputs.duration', label: 'Duration (seconds)', min: 15, max: 90, step: 5 },
          { type: 'select', bind: 'inputs.tone', label: 'Tone', options: [{ value: 'playful', label: 'Playful' }, { value: 'bold' }] },
          { type: 'text', bind: 'inputs.audience.segment', label: 'Audience' },
          { type: 'toggle', bind: 'inputs.draft', label: 'Draft only' },
        ],
      },
      { type: 'row', children: [{ type: 'runButton', label: 'Generate' }, { type: 'cancelButton' }, { type: 'runStatus' }, { type: 'progress' }] },
      {
        type: 'tabs',
        visibleWhen: "status == 'ok'",
        tabs: [
          { label: 'Script', children: [{ type: 'markdown', source: 'outputs.script' }, { type: 'text', source: 'outputs.caption' }, { type: 'table', source: 'outputs.hashtags' }] },
          { label: 'Video', children: [{ type: 'artifact', artifact: 'video' }, { type: 'artifactGallery' }] },
        ],
      },
      { type: 'card', label: 'Run', children: [{ type: 'traceLink' }, { type: 'versionList' }, { type: 'compare' }, { type: 'reviseBox' }, { type: 'json', source: 'outputs' }] },
    ],
  },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = pageUiSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

function withLayout(layout: unknown): unknown {
  return { schema: 'lousho.ui/1', layout };
}

function inStack(...children: unknown[]): unknown {
  return withLayout({ type: 'stack', children });
}

function codes(ui: PageUi, harness: UiBindingTarget = composedInstagram): string[] {
  return validateUiBindings(ui, harness).map((problem) => problem.code);
}

function uiOf(...children: UiComponent[]): PageUi {
  return { schema: 'lousho.ui/1', layout: { type: 'stack', children: [{ type: 'schemaForm', bind: 'inputs' }, ...children] } };
}

describe('pageUiSchema', () => {
  it('the Instagram UI validates against the composed Instagram harness', () => {
    const parsed = pageUiSchema.safeParse(instagramUi);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(instagramUi);
    expect(validateUiBindings(instagramUi, composedInstagram)).toEqual([]);
  });

  it('an unknown component type is an error', () => {
    const issues = issuesOf(inStack({ type: 'iframe', label: 'x' }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toEqual(['layout', 'children', 0, 'type']);
    expect(issuesOf(withLayout({ type: 'stack', children: [{ type: 'card', children: [{ type: 'Html' }] }] }))[0].path).toEqual(['layout', 'children', 0, 'children', 0, 'type']);
  });

  it('html prop is rejected with R15', () => {
    expect(issuesOf(inStack({ type: 'markdown', source: 'outputs.script', html: '<b>x</b>' }))).toEqual([
      { path: ['layout', 'children', 0, 'html'], message: 'ui.layout.children[0].html: page UIs use only the catalog props; html is not allowed (R15)' },
    ]);
  });

  it('every forbidden prop is rejected with R15 at any depth and in any spelling', () => {
    const props = ['html', 'script', 'href', 'src', 'style', 'dangerouslySetInnerHTML', 'innerHTML', 'srcdoc', 'url', 'className', 'eval', 'inner_html', 'STYLE'];
    const listed: Record<string, string> = { inner_html: 'innerHTML', STYLE: 'style' };
    for (const prop of props) {
      const issues = issuesOf(withLayout({ type: 'stack', children: [{ type: 'tabs', tabs: [{ label: 'a', children: [{ type: 'runButton', [prop]: 'x' }] }] }] }));
      expect(issues.map((issue) => issue.message), prop).toEqual([`ui.layout.children[0].tabs[0].children[0]${/^\w+$/.test(prop) ? `.${prop}` : `[${JSON.stringify(prop)}]`}: page UIs use only the catalog props; ${listed[prop] ?? prop} is not allowed (R15)`]);
    }
  });

  it('any on* event handler prop is rejected with R15', () => {
    for (const prop of ['onClick', 'onload', 'onMouseOver', 'on_error', 'onChange', 'ON-CLICK']) {
      expect(issuesOf(inStack({ type: 'runButton', [prop]: 'alert(1)' })), prop).toEqual([
        { path: ['layout', 'children', 0, prop], message: `ui.layout.children[0]${/^\w+$/.test(prop) ? `.${prop}` : `[${JSON.stringify(prop)}]`}: event handlers are not allowed; page UIs are declarative (R15)` },
      ]);
    }
  });

  it('R13 keys in a UI are rejected', () => {
    expect(issuesOf(inStack({ type: 'runButton', tools: ['bash'] }))).toEqual([
      { path: ['layout', 'children', 0, 'tools'], message: 'ui.layout.children[0].tools: a page UI describes the screen; the runtime enforces tools (R13)' },
    ]);
  });

  it('javascript:, data: and remote URLs in text props are rejected', () => {
    for (const text of ['javascript:alert(1)', 'JavaScript :void(0)', 'data:text/html;base64,PHNjcmlwdD4=', 'https://evil.example/x.png', 'see http://x.io', '//cdn.example/a.js']) {
      const issues = issuesOf(inStack({ type: 'runButton', label: text }));
      expect(issues.map((issue) => issue.path), text).toEqual([['layout', 'children', 0, 'label']]);
    }
    expect(issuesOf(inStack({ type: 'runButton', label: 'Input data: topic and tone' }))).toEqual([]);
  });

  it('remote or inline assets are never an artifact name or media type', () => {
    expect(issuesOf(inStack({ type: 'artifact', artifact: 'https://evil.example/x.png' }))[0].path).toEqual(['layout', 'children', 0, 'artifact']);
    expect(issuesOf(inStack({ type: 'artifact', artifact: 'data:image/png;base64,AAAA' }))[0].path).toEqual(['layout', 'children', 0, 'artifact']);
    expect(issuesOf(inStack({ type: 'file', bind: 'inputs.x', accept: ['http://x/y'] }))[0].path).toEqual(['layout', 'children', 0, 'accept', 0]);
  });

  it('HTML and script in text props are rejected', () => {
    for (const text of ['<script>alert(1)</script>', 'a <img onerror=x>', '<!-- x -->', 'x</b>']) {
      expect(issuesOf(inStack({ type: 'section', label: text, children: [{ type: 'runStatus' }] })).map((issue) => issue.path), text).toEqual([['layout', 'children', 0, 'label']]);
    }
    expect(issuesOf({ schema: 'lousho.ui/1', title: '<svg/onload=x>', layout: { type: 'runStatus' } }).map((issue) => issue.path)).toEqual([['title']]);
    expect(issuesOf(inStack({ type: 'runButton', label: '2 < 3 and 5 > 4' }))).toEqual([]);
  });

  it('prototype keys are rejected', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const doc = JSON.parse(`{"schema":"lousho.ui/1","layout":{"type":"runStatus","${key}":{"polluted":true}}}`) as unknown;
      expect(issuesOf(doc).map((issue) => issue.path), key).toEqual([['layout', key]]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('prototype segments in bind, source and visibleWhen are rejected', () => {
    expect(issuesOf(inStack({ type: 'text', bind: 'inputs.__proto__.x' }))[0].path).toEqual(['layout', 'children', 0, 'bind']);
    expect(issuesOf(inStack({ type: 'json', source: 'outputs.constructor' }))[0].path).toEqual(['layout', 'children', 0, 'source']);
    expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: 'inputs.constructor == 1' }))[0].path).toEqual(['layout', 'children', 0, 'visibleWhen']);
  });

  it('getters and Proxies are scanned, never trusted', () => {
    const getter = { type: 'runStatus' } as Record<string, unknown>;
    Object.defineProperty(getter, 'label', { enumerable: true, get: () => 'x' });
    expect(issuesOf(inStack(getter))[0].path).toEqual(['layout', 'children', 0, 'label']);
    const hostile = new Proxy({ type: 'runStatus' }, { getOwnPropertyDescriptor: () => { throw new TypeError('no'); }, ownKeys: () => { throw new TypeError('no'); } });
    expect(issuesOf(inStack(hostile))[0].path).toEqual(['layout', 'children', 0]);
    let reads = 0;
    const flipping = new Proxy({ type: 'runButton', label: 'Go' }, { get: (target, key) => { reads += 1; return reads > 1 && key === 'label' ? '<script>x</script>' : Reflect.get(target, key); } });
    const parsed = pageUiSchema.safeParse(inStack(flipping));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.layout).toEqual({ type: 'stack', children: [{ type: 'runButton', label: 'Go' }] });
  });

  it('a class instance is not plain data', () => {
    class Button {
      type = 'runButton';
    }
    expect(issuesOf(inStack(new Button()))[0].path).toEqual(['layout', 'children', 0]);
  });

  it('visibleWhen uses the safe expression subset over inputs, outputs and status', () => {
    expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: "inputs.tone == 'bold' && outputs.hashtags.length > 0 && !inputs.topic.startsWith('x')" }))).toEqual([]);
    for (const expression of ['process.exit(1)', 'globalThis', 'inputs.topic.toString()', 'eval("1")', 'x = 1', 'inputs.topic ?']) {
      expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: expression })).map((issue) => issue.path), expression).toEqual([['layout', 'children', 0, 'visibleWhen']]);
    }
  });

  it('text needs exactly one of bind or source', () => {
    expect(issuesOf(inStack({ type: 'text' }))[0].path).toEqual(['layout', 'children', 0]);
    expect(issuesOf(inStack({ type: 'text', bind: 'inputs.a', source: 'outputs.a' }))[0].path).toEqual(['layout', 'children', 0]);
  });

  it('strict props: an unknown prop is an error', () => {
    expect(issuesOf(inStack({ type: 'runButton', color: 'red' }))[0].path).toEqual(['layout', 'children', 0]);
    expect(issuesOf({ schema: 'lousho.ui/1', layout: { type: 'runStatus' }, theme: 'x' })[0].path).toEqual([]);
    expect(issuesOf({ schema: 'lousho.ui/2', layout: { type: 'runStatus' } })[0].path).toEqual(['schema']);
  });

  it('UI_COMPONENTS is the closed catalog and every type parses', () => {
    expect(UI_COMPONENTS).toEqual({
      layout: ['stack', 'row', 'tabs', 'section', 'card'],
      inputs: ['text', 'textarea', 'number', 'select', 'radio', 'toggle', 'slider', 'file', 'schemaForm'],
      actions: ['runButton', 'cancelButton', 'reviseBox'],
      outputs: ['text', 'markdown', 'json', 'table', 'artifact', 'artifactGallery'],
      status: ['runStatus', 'progress', 'traceLink'],
      revisions: ['versionList', 'compare'],
    });
    const minimal: Record<string, unknown> = {
      stack: { children: [] },
      row: { children: [] },
      section: { children: [] },
      card: { children: [] },
      tabs: { tabs: [] },
      text: { source: 'outputs.a' },
      markdown: { source: 'outputs.a' },
      json: { source: 'outputs' },
      table: { source: 'outputs.a' },
      artifact: { artifact: 'a' },
    };
    for (const type of new Set(Object.values(UI_COMPONENTS).flat())) {
      const props = (minimal[type] as object | undefined) ?? (['runButton', 'cancelButton', 'reviseBox', 'artifactGallery', 'runStatus', 'progress', 'traceLink', 'versionList', 'compare'].includes(type) ? {} : { bind: 'inputs.a' });
      expect(issuesOf(withLayout({ type, ...props })), type).toEqual([]);
    }
  });
});

describe('validateUiBindings', () => {
  it('a bind to a missing input path is an error with the path', () => {
    expect(validateUiBindings(uiOf({ type: 'text', bind: 'inputs.audience.age' }), composedInstagram)).toEqual([
      { code: 'UI001', path: ['layout', 'children', 1, 'bind'], message: "inputs.audience.age: no such field in the harness's inputs.schema" },
    ]);
  });

  it('a bind to a field of the wrong type is an error', () => {
    expect(validateUiBindings(uiOf({ type: 'toggle', bind: 'inputs.topic' }), composedInstagram)).toEqual([
      { code: 'UI002', path: ['layout', 'children', 1, 'bind'], message: 'inputs.topic: toggle needs a boolean field, but the schema says string' },
    ]);
    expect(codes(uiOf({ type: 'number', bind: 'inputs.duration' }, { type: 'textarea', bind: 'inputs.topic' }))).toEqual([]);
  });

  it('select options outside the enum are an error', () => {
    expect(validateUiBindings(uiOf({ type: 'select', bind: 'inputs.tone', options: [{ value: 'playful' }, { value: 'sarcastic' }] }), composedInstagram)).toEqual([
      { code: 'UI003', path: ['layout', 'children', 1, 'options', 1, 'value'], message: "inputs.tone: option 'sarcastic' is not in the schema's enum" },
    ]);
    expect(codes(uiOf({ type: 'radio', bind: 'inputs.topic' }))).toEqual(['UI003']);
    expect(codes(uiOf({ type: 'radio', bind: 'inputs.tone' }))).toEqual([]);
  });

  it('a source must exist in outputs.schema with a compatible type', () => {
    expect(validateUiBindings(uiOf({ type: 'markdown', source: 'outputs.summary' }, { type: 'table', source: 'outputs.script' }), composedInstagram)).toEqual([
      { code: 'UI004', path: ['layout', 'children', 1, 'source'], message: "outputs.summary: no such field in the harness's outputs.schema" },
      { code: 'UI005', path: ['layout', 'children', 2, 'source'], message: 'outputs.script: table needs an array field, but the schema says string' },
    ]);
  });

  it('an artifact must be declared in outputs.artifacts', () => {
    expect(validateUiBindings(uiOf({ type: 'artifact', artifact: 'thumbnail' }), composedInstagram)).toEqual([
      { code: 'UI006', path: ['layout', 'children', 1, 'artifact'], message: "artifact 'thumbnail' is not declared in the harness's outputs.artifacts" },
    ]);
  });

  it('unbound required input is an error', () => {
    const ui: PageUi = { schema: 'lousho.ui/1', layout: { type: 'stack', children: [{ type: 'text', bind: 'inputs.topic' }, { type: 'text', bind: 'inputs.audience.segment' }] } };
    expect(validateUiBindings(ui, composedInstagram)).toEqual([
      { code: 'UI007', path: ['layout'], message: 'inputs.duration is required and has no default, but no input binds it' },
      { code: 'UI007', path: ['layout'], message: 'inputs.tone is required and has no default, but no input binds it' },
    ]);
    expect(codes(uiOf())).toEqual([]);
  });

  it('a schema given as a file path must be resolved first', () => {
    const unresolved: Pick<Harness, 'inputs' | 'outputs'> = { inputs: { schema: 'schemas/in.json' }, outputs: { schema: 'schemas/out.json' } };
    expect(validateUiBindings(uiOf({ type: 'text', source: 'outputs.a' }, { type: 'text', source: 'outputs.b' }), unresolved)).toEqual([
      { code: 'UI008', path: [], message: 'inputs.schema is a file path; resolve it before checking UI bindings' },
      { code: 'UI008', path: [], message: 'outputs.schema is a file path; resolve it before checking UI bindings' },
    ]);
  });

  it('a harness without inputs or outputs leaves every binding missing', () => {
    expect(codes(uiOf({ type: 'json', source: 'outputs' }, { type: 'artifactGallery' }), {})).toEqual(['UI001', 'UI004']);
    expect(codes({ schema: 'lousho.ui/1', layout: { type: 'runButton' } }, {})).toEqual([]);
  });

  it('is pure: the same input gives the same problems', () => {
    const ui = uiOf({ type: 'text', bind: 'inputs.nope' }, { type: 'artifact', artifact: 'nope' });
    expect(validateUiBindings(ui, composedInstagram)).toEqual(validateUiBindings(ui, composedInstagram));
  });
});
