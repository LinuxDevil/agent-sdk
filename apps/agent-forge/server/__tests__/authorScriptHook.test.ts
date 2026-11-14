import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTHOR_SCRIPT_ENV, authorScriptActive, authorScriptProvider, loadAuthorScript } from '../author/authorScript';

const SCRIPT = [
  {
    text: '',
    toolCalls: [{ id: 'call_propose_1', name: 'proposeAgent', args: { draft: { name: 'Greeter' } } }],
  },
  { text: 'Done.' },
];

function scriptFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'author-script-')), 'script.json');
  fs.writeFileSync(file, JSON.stringify(SCRIPT));
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  loadAuthorScript({});
});

describe('loadAuthorScript (X08 e2e hook)', () => {
  it('is inert when the env var is unset', () => {
    expect(loadAuthorScript({})).toBeUndefined();
    expect(authorScriptProvider()).toBeUndefined();
    expect(authorScriptActive()).toBe(false);
  });

  it('installs a scripted provider whose first turn yields the tool call', async () => {
    const model = loadAuthorScript({ [AUTHOR_SCRIPT_ENV]: scriptFile() });
    expect(model).toBeDefined();
    expect(authorScriptActive()).toBe(true);
    expect(authorScriptProvider()).toBe(model);

    const result = await model!.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.toolCalls?.[0]?.function.name).toBe('proposeAgent');
    // repeat-last: a second turn does not exhaust the script.
    const second = await model!.generate({ messages: [{ role: 'user', content: 'again' }] });
    expect(second.text).toBe('Done.');
  });

  it('ignores the script under NODE_ENV=production without the e2e flag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = loadAuthorScript({
      NODE_ENV: 'production',
      [AUTHOR_SCRIPT_ENV]: scriptFile(),
    });
    expect(model).toBeUndefined();
    expect(authorScriptActive()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('honours the script under NODE_ENV=production with LOUSHO_STUDIO_E2E=1', () => {
    const model = loadAuthorScript({
      NODE_ENV: 'production',
      LOUSHO_STUDIO_E2E: '1',
      [AUTHOR_SCRIPT_ENV]: scriptFile(),
    });
    expect(model).toBeDefined();
  });

  it('throws a startup error naming the file on bad JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'author-script-')), 'bad.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => loadAuthorScript({ [AUTHOR_SCRIPT_ENV]: file })).toThrow(file);
  });

  it('throws a startup error naming the file when the JSON is not a turn array', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'author-script-')), 'shape.json');
    fs.writeFileSync(file, '{"nope": true}');
    expect(() => loadAuthorScript({ [AUTHOR_SCRIPT_ENV]: file })).toThrow(file);
  });
});
