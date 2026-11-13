import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import type { ApiClient } from '../workspaces/client/apiClient';
import { mockModel } from '../testing';
import { fixtureClient } from '../workspaces/client/__fixtures__/fixtureClient';
import { cliHost } from './workspaceHostCli';
import { isWorkspaceCommand, runWorkspace, type WorkspaceIo } from './workspace';
import { OUTPUT_CHECK_NAME, WORKSPACE_TEMPLATES } from './workspaceTemplates';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-workspace-cli-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function capture(extra: Partial<WorkspaceIo> = {}): { io: WorkspaceIo; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, cwd: root, ...extra }, out: () => out.join(''), err: () => err.join('') };
}

async function created(template: string): Promise<string> {
  const dir = path.join(root, `${template}-ws`);
  expect(await runWorkspace(['init', dir, '--template', template], capture().io)).toBe(0);
  return dir;
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((entry) => fs.statSync(path.join(dir, entry)).isFile());
}

describe('lousho workspace init', () => {
  it.each(WORKSPACE_TEMPLATES)('the %s template validates and gives every page an executable criterion', async (template) => {
    const dir = await created(template);
    const run = capture();
    expect(await runWorkspace(['validate', '--source', dir], run.io)).toBe(0);
    for (const file of listFiles(dir).filter((entry) => /pages\/[^/]+\/harness\/harness\.json$/.test(entry))) {
      const harness = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { evaluation: { criteria: { check?: string }[] } };
      expect(harness.evaluation.criteria.some((criterion) => criterion.check)).toBe(true);
    }
  });

  it('writes no UI file', async () => {
    const dir = await created('marketing');
    expect(listFiles(dir).filter((entry) => entry.includes('ui/'))).toEqual([]);
  });

  it('refuses to overwrite an existing workspace and writes nothing', async () => {
    const dir = await created('blank');
    const before = listFiles(dir).sort();
    const run = capture();
    expect(await runWorkspace(['init', dir], run.io)).toBe(1);
    expect(run.err()).toContain('already has');
    expect(listFiles(dir).sort()).toEqual(before);
  });

  it('rejects an unknown template as a usage error', async () => {
    expect(await runWorkspace(['init', '--template', 'nope'], capture().io)).toBe(2);
  });
});

describe('lousho workspace ls, show and validate', () => {
  it('ls lists the pages', async () => {
    const dir = await created('coding');
    const run = capture();
    expect(await runWorkspace(['ls', '--source', dir], run.io)).toBe(0);
    expect(run.out()).toContain('investigate');
    expect(run.out()).toContain('review');
  });

  it('show prints the manifest and, with --page, the explanation', async () => {
    const dir = await created('blank');
    const manifest = capture();
    expect(await runWorkspace(['show', '--source', dir], manifest.io)).toBe(0);
    expect(manifest.out()).toContain('hello');
    const page = capture();
    expect(await runWorkspace(['show', '--source', dir, '--page', 'hello'], page.io)).toBe(0);
    expect(page.out().length).toBeGreaterThan(0);
  });

  it('validate prints problems with codes and fails', async () => {
    const dir = await created('blank');
    fs.rmSync(path.join(dir, 'pages/hello/agents.json'));
    const run = capture();
    expect(await runWorkspace(['validate', '--source', dir], run.io)).toBe(1);
    expect(run.out()).toMatch(/error\tPRD\d+/);
  });
});

describe('lousho workspace run', () => {
  it('runs one page with a scripted model and prints the result', async () => {
    const dir = await created('blank');
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({ request: 'hi' }));
    const run = capture({ providers: { resolve: () => mockModel(['{"reply":"hello there"}'], { onExhausted: 'repeat-last' }) } });
    const code = await runWorkspace(['run', '--source', dir, '--page', 'hello', '--inputs', 'inputs.json', '--model', 'mock/mock-model'], run.io);
    expect(run.err()).toContain('finished ok');
    expect(run.out()).toContain('hello there');
    expect(code).toBe(0);
  });

  it('fails with a message when no model is set', async () => {
    const dir = await created('blank');
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({ request: 'hi' }));
    const run = capture({ providers: { resolve: () => mockModel(['x']) } });
    expect(await runWorkspace(['run', '--source', dir, '--page', 'hello', '--inputs', 'inputs.json'], run.io)).not.toBe(0);
    expect(run.out() + run.err()).toContain('has no model');
  });

  it('needs a message or a page', async () => {
    const dir = await created('blank');
    expect(await runWorkspace(['run', '--source', dir, '--model', 'mock/mock-model'], capture().io)).toBe(2);
  });
});

describe('lousho workspace --service', () => {
  it('lists workspaces and pages through the typed client', async () => {
    const list = capture({ client: fixtureClient() });
    expect(await runWorkspace(['ls', '--service', 'http://svc'], list.io)).toBe(0);
    expect(list.out()).toContain('marketing');
    const pages = capture({ client: fixtureClient() });
    expect(await runWorkspace(['ls', '--service', 'http://svc', '--workspace', 'marketing'], pages.io)).toBe(0);
    expect(pages.out()).toContain('instagram-videos');
  });

  it('needs --workspace for show and refuses --source with --service', async () => {
    expect(await runWorkspace(['show', '--service', 'http://svc'], capture({ client: fixtureClient() }).io)).toBe(2);
    expect(await runWorkspace(['ls', '--service', 'http://svc', '--source', '.'], capture({ client: fixtureClient() }).io)).toBe(2);
  });
});

describe('lousho workspace usage', () => {
  it('knows its subcommands and rejects others', async () => {
    expect(isWorkspaceCommand('run')).toBe(true);
    expect(isWorkspaceCommand('nope')).toBe(false);
    expect(await runWorkspace(['nope'], capture().io)).toBe(2);
    expect(await runWorkspace([], capture().io)).toBe(2);
    expect(await runWorkspace(['--help'], capture().io)).toBe(0);
  });
});

describe('lousho workspace run, more', () => {
  it('runs the main agent on a message, prints its reply and exits 0', async () => {
    const dir = await created('blank');
    const run = capture({ providers: { resolve: () => mockModel(['hi from main'], { onExhausted: 'repeat-last' }) } });
    expect(await runWorkspace(['run', 'say hi', '--source', dir, '--model', 'mock/mock-model'], run.io)).toBe(0);
    expect(run.out()).toContain('hi from main');
  });

  it('lets a model set on an agent beat --model', async () => {
    const dir = await created('blank');
    const file = path.join(dir, 'agents/helper/agent.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), model: 'mock/agent-model' }));
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({ request: 'hi' }));
    const asked: string[] = [];
    const run = capture({ providers: { resolve: (ref) => (asked.push(ref), mockModel(['{"reply":"ok"}'], { onExhausted: 'repeat-last' })) } });
    await runWorkspace(['run', '--source', dir, '--page', 'hello', '--inputs', 'inputs.json', '--model', 'mock/flag-model'], run.io);
    expect(asked).toContain('mock/agent-model');
    expect(asked).not.toContain('mock/flag-model');
  });

  it('leaves a malformed workspace.json to the loader', async () => {
    const dir = await created('blank');
    fs.writeFileSync(path.join(dir, 'workspace.json'), '{ nope');
    const run = capture();
    expect(await runWorkspace(['run', 'hi', '--source', dir, '--model', 'mock/mock-model'], run.io)).toBe(1);
    expect(run.err()).toContain('PRD');
  });

  it('refuses flags that would be ignored', async () => {
    const dir = await created('blank');
    expect(await runWorkspace(['run', 'hi', '--service', 'http://svc', '--workspace', 'm', '--model', 'x/y'], capture({ client: fixtureClient() }).io)).toBe(2);
    expect(await runWorkspace(['run', 'hi', '--source', dir, '--inputs', 'inputs.json'], capture().io)).toBe(2);
  });
});

describe('lousho workspace --host', () => {
  it('imports the host module and passes its ceiling and bindTool to the host', async () => {
    const file = path.join(root, 'host.mjs');
    fs.writeFileSync(file, "export const policyCeiling = { permissions: [], tools: { allow: ['only'] }, secrets: [] };\nexport const bindTool = (descriptor) => descriptor;\n");
    const host = await cliHost(root, { cwd: root, hostModule: 'host.mjs' });
    expect(host.policyCeiling.tools.allow).toEqual(['only']);
    expect(typeof host.bindTool).toBe('function');
  });

  it('registers an output-present check that passes only when the output has non-empty text', async () => {
    const check = (await cliHost(root, { cwd: root })).checks?.get(OUTPUT_CHECK_NAME);
    expect(check?.evaluate({ script: 'Hello' })).toMatchObject({ passed: true, score: 1 });
    expect(check?.evaluate('plain text')).toMatchObject({ passed: true });
    expect(check?.evaluate({ script: '   ', count: 3 })).toMatchObject({ passed: false, score: 0, message: 'output has no non-empty text field' });
    expect(check?.evaluate(null)).toMatchObject({ passed: false });
  });

  it('reports a host module that cannot be imported', async () => {
    const dir = await created('blank');
    const run = capture({ providers: { resolve: () => mockModel(['x']) } });
    expect(await runWorkspace(['run', 'hi', '--source', dir, '--host', 'missing.mjs', '--model', 'mock/mock-model'], run.io)).toBe(1);
    expect(run.err()).toContain('missing.mjs');
  });
});

describe('lousho workspace --service, more', () => {
  it('shows, validates and runs through the typed client', async () => {
    const show = capture({ client: fixtureClient() });
    expect(await runWorkspace(['show', '--service', 'http://svc', '--workspace', 'marketing'], show.io)).toBe(0);
    expect(show.out()).toContain('marketing');
    const page = capture({ client: fixtureClient() });
    expect(await runWorkspace(['show', '--service', 'http://svc', '--workspace', 'marketing', '--page', 'instagram-videos'], page.io)).toBe(0);
    const validate = capture({ client: fixtureClient() });
    expect(await runWorkspace(['validate', '--service', 'http://svc', '--workspace', 'marketing'], validate.io)).toBe(0);
    expect(validate.out()).toBe('');
    const run = capture({ client: fixtureClient() });
    await runWorkspace(['run', 'go', '--service', 'http://svc', '--workspace', 'marketing', '--page', 'instagram-videos'], run.io);
    expect(run.out()).toContain('finished');
  });
});

describe('lousho workspace --service problems', () => {
  it('prints each problem with its code and exits 1 on an error', async () => {
    const base = fixtureClient();
    const client: ApiClient = {
      ...base,
      call: (async (name: string, input: never) =>
        name === 'getProblems'
          ? [{ severity: 'error', code: 'PRD001', file: 'workspace.json', path: 'pages', message: 'bad pages' }]
          : (base.call as (n: string, i: never) => Promise<unknown>)(name, input)) as ApiClient['call'],
    };
    const run = capture({ client });
    expect(await runWorkspace(['validate', '--service', 'http://svc', '--workspace', 'marketing'], run.io)).toBe(1);
    expect(run.out()).toBe('error\tPRD001\tworkspace.json#pages\tbad pages\n');
  });
});

describe('lousho workspace run with host tools', () => {
  it('runs a page whose agent calls a host tool through the host module bindTool', async () => {
    const dir = await created('blank');
    fs.mkdirSync(path.join(dir, 'agents/helper/tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents/helper/tools/echo.ts'), 'export {};\n');
    fs.mkdirSync(path.join(dir, 'shared/policies'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shared/policies/policy.json'), JSON.stringify({ permissions: [], tools: { allow: ['echo'] }, secrets: [] }));
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({ request: 'hi' }));
    const execute = vi.fn(async () => 'echoed');
    const bound: unknown[] = [];
    const shared = globalThis as unknown as { __hostTools?: unknown; __bound?: unknown[] };
    shared.__hostTools = { echo: { descriptor: defineTool({ name: 'echo', description: 'Echoes.', input: z.object({}), execute }) } };
    shared.__bound = bound;
    fs.writeFileSync(path.join(root, 'host.mjs'), 'export const tools = globalThis.__hostTools;\nexport const bindTool = (descriptor, scope) => (globalThis.__bound.push(scope), descriptor);\n');
    const model = mockModel([{ toolCalls: [{ name: 'echo', args: {} }] }, '{"reply":"done"}']);
    const run = capture({ providers: { resolve: () => model } });
    const code = await runWorkspace(['run', '--source', dir, '--page', 'hello', '--inputs', 'inputs.json', '--host', 'host.mjs', '--model', 'mock/mock-model'], run.io);
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bound).toEqual([expect.objectContaining({ name: 'echo', page: 'hello' })]);
    delete shared.__hostTools;
    delete shared.__bound;
  });
});
