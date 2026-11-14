import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceRuntime, memorySource, resolveCheck, type PageResult, type WorkspaceRuntime } from '@linuxdevil/lousho/workspaces';
import { marketingChecks, marketingHost, PAGES, readWorkspaceFiles, scriptedMarketingModel, WORKSPACE_ID } from './host';
import { runMarketing } from './run';
import { jsonSchemaToStandardSchema } from '@linuxdevil/lousho/spec';

const dirs: string[] = [];
const runtimes: WorkspaceRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-marketing-test-'));
  dirs.push(dir);
  return dir;
}

const INPUT = { task: 'Make a short video about tea.', inputs: { topic: 'tea' } };

function build(files: Record<string, string> = readWorkspaceFiles()) {
  const model = scriptedMarketingModel();
  const host = marketingHost({ storageDir: storage(), provider: model });
  const source = memorySource(files);
  const runtime: WorkspaceRuntime = createWorkspaceRuntime(source, host);
  runtimes.push(runtime);
  return { model, host, source, runtime };
}

function systemPrompt(model: ReturnType<typeof scriptedMarketingModel>, call: number): string {
  const system = model.calls[call].messages.find((message) => message.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

function sections(prompt: string): Map<string, string> {
  const parts = prompt.split(/\n\n(?=## )/);
  return new Map(parts.map((part, index) => [part.startsWith('## ') ? part.split('\n')[0] : `intro-${index}`, part]));
}

async function runBoth(runtime: WorkspaceRuntime): Promise<Record<string, PageResult>> {
  const results: Record<string, PageResult> = {};
  for (const page of PAGES) results[page] = await runtime.runPage(page, INPUT);
  return results;
}

async function matchesSchema(schema: unknown, output: unknown): Promise<boolean> {
  const result = await jsonSchemaToStandardSchema(schema as Record<string, unknown>)['~standard'].validate(output);
  return result.issues === undefined;
}

describe('workspace-marketing', () => {
  it('instagram and facebook run with the same three agent dirs', async () => {
    const files = readWorkspaceFiles();
    const agentFiles = Object.keys(files).filter((path) => path.startsWith('agents/'));
    expect(new Set(agentFiles.map((path) => path.split('/')[1]))).toEqual(new Set(['script-maker', 'video-maker', 'voice-maker']));
    expect(Object.keys(files).filter((path) => /\/agents\/[^/]+\/agent\.json$/.test(path))).toEqual([]);
    const refs = PAGES.map((page) => (JSON.parse(files[`pages/${page}/agents.json`]) as { agents: { ref: string }[] }).agents.map((agent) => agent.ref));
    expect(refs[0]).toEqual(['workspace:script-maker', 'workspace:video-maker', 'workspace:voice-maker']);
    expect(refs[1]).toEqual(refs[0]);
    const { runtime } = build();
    const results = await runBoth(runtime);
    expect(Object.values(results).map((result) => result.status)).toEqual(['ok', 'ok']);
    await runtime.close();
  });

  it('their assembled prompts differ only in the task-environment section', async () => {
    const { model, runtime } = build();
    await runtime.runPage('instagram-videos', INPUT);
    const afterFirst = model.calls.length;
    await runtime.runPage('facebook-videos', INPUT);
    const instagram = sections(systemPrompt(model, 0));
    const facebook = sections(systemPrompt(model, afterFirst));
    expect([...instagram.keys()].filter((key) => key.startsWith('## ')).map((key) => key.replace(/: .*/, ''))).toEqual([...facebook.keys()].filter((key) => key.startsWith('## ')).map((key) => key.replace(/: .*/, '')));
    const differing = [...instagram.keys()].filter((key) => instagram.get(key) !== facebook.get(key));
    expect(differing).toEqual(['## Task environment: Instagram']);
    expect(instagram.get('## Task environment: Instagram')).not.toBe(facebook.get('## Task environment: Facebook'));
    expect(instagram.get('## Workspace rules')).toBe(facebook.get('## Workspace rules'));
    await runtime.close();
  });

  it("outputs validate against each page's outputs.schema", async () => {
    const { runtime } = build();
    const results = await runBoth(runtime);
    for (const page of PAGES) {
      const { harness } = await runtime.explain(page);
      expect(await matchesSchema(harness.outputs?.schema, results[page].output)).toBe(true);
      const criteria = (harness.evaluation?.criteria ?? []).filter((criterion) => criterion.check !== undefined);
      expect(criteria.length).toBeGreaterThan(0);
      for (const criterion of criteria) {
        const check = criterion.check === undefined ? undefined : resolveCheck(marketingChecks, criterion.check);
        expect(check, `${page}/${criterion.id}`).toBeDefined();
        expect(await check?.evaluate(results[page].output)).toMatchObject({ passed: true });
      }
    }
    await runtime.close();
  });

  it('artifacts land under each run', async () => {
    const { host, runtime } = build();
    const results = await runBoth(runtime);
    const runIds = Object.values(results).map((result) => result.runId);
    expect(new Set(runIds).size).toBe(2);
    for (const result of Object.values(results)) {
      expect(result.artifacts.map((ref) => ref.name).sort()).toEqual(['video', 'voice']);
      for (const ref of result.artifacts) {
        expect(ref.uri).toContain(result.runId);
        const stored = await host.stores.artifacts.get(ref.uri, { workspace: WORKSPACE_ID, runId: result.runId });
        expect(stored?.data.byteLength).toBe(ref.bytes);
        expect(stored?.data.byteLength).toBeGreaterThan(0);
      }
    }
    await runtime.close();
  });

  it("editing facebook's harness leaves instagram's harness.hash unchanged", async () => {
    const { source, runtime } = build();
    const before = { instagram: (await runtime.explain('instagram-videos')).hash, facebook: (await runtime.explain('facebook-videos')).hash };
    const revision = await source.revision();
    await source.write?.({ 'pages/facebook-videos/harness/task.md': 'Make a Facebook video that teaches the topic in two short sentences.\n' }, { expectedRevision: revision, by: 'person:test', message: 'shorten facebook' });
    const after = { instagram: (await runtime.explain('instagram-videos')).hash, facebook: (await runtime.explain('facebook-videos')).hash };
    expect(after.instagram).toBe(before.instagram);
    expect(after.facebook).not.toBe(before.facebook);
    await runtime.close();
  });

  it('with mainAgent null both pages run through runPage', async () => {
    const files = Object.fromEntries(Object.entries(readWorkspaceFiles()).filter(([path]) => !path.startsWith('main-agent/')));
    const manifest = JSON.parse(files['workspace.json']) as Record<string, unknown>;
    files['workspace.json'] = `${JSON.stringify({ ...manifest, mainAgent: null }, null, 2)}\n`;
    const { runtime, model } = build(files);
    const results = await runBoth(runtime);
    expect(Object.values(results).map((result) => result.status)).toEqual(['ok', 'ok']);
    const events = [];
    for await (const event of runtime.run('Make a video', { threadId: 'thread-1' })) events.push(event);
    const finished = events.at(-1);
    expect(finished).toMatchObject({ type: 'finished', status: 'failed' });
    expect(model.calls).toHaveLength(6);
    await runtime.close();
  });

  it('runs offline through run.ts with --mock', async () => {
    const results = await runMarketing({ mock: true, storageDir: storage() });
    expect(Object.keys(results)).toEqual([...PAGES]);
    expect(Object.values(results).every((result) => result.status === 'ok')).toBe(true);
    await expect(runMarketing({ mock: false })).rejects.toThrow('--mock');
  });
});
