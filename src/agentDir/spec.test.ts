import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { agentDirToSpec, specToAgentDir } from './spec';
import { importModule } from './importModule';
import type { AgentSpecV2 } from '../spec/v2/types';

vi.mock('./importModule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./importModule')>()),
  importModule: vi.fn(async () => {
    throw new Error('agentDirToSpec must never import a file');
  }),
}));

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);
const registryDir = (name: string): string => path.join(__dirname, '..', '..', 'registry', name);

/** A fresh temp directory. */
function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lousho-spec-dir-'));
}

/** Writes `files` under `dir` (creating parent folders) and returns `dir`. */
function writeFiles(dir: string, files: readonly { path: string; content: string }[]): string {
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return dir;
}

/** Writes `files` under a fresh temp directory and returns the directory. */
function writeDir(files: readonly { path: string; content: string }[]): string {
  return writeFiles(tmpDir(), files);
}

const MODEL = 'openai/gpt-4o-mini';

describe('specToAgentDir / agentDirToSpec', () => {
  it('round-trips a minimal spec (name, model, instructions)', async () => {
    const spec: AgentSpecV2 = { version: 2, name: 'mini', model: MODEL, instructions: 'You are minimal.' };
    const { files, dropped } = specToAgentDir(spec);
    expect(dropped).toEqual([]);
    const result = await agentDirToSpec(writeDir(files));
    expect(result).toEqual({ spec, dropped: [] });
  });

  it('round-trips a rich spec: every directory-expressible key', async () => {
    const spec: AgentSpecV2 = {
      version: 2,
      name: 'rich',
      description: 'Exercises every directory-expressible key',
      model: MODEL,
      instructions: 'You are the rich fixture.',
      instructionsByFamily: { openai: 'Work one tool call at a time.' },
      maxSteps: 7,
      permissionMode: 'plan',
      permissions: [
        { id: 'p1', tool: 'shell', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No deletes' },
        { id: 'p2', tool: ['write_file', 'edit_file'], when: { lines: { lte: 200 } }, action: 'ask', ttlMs: 30_000 },
      ],
      hooks: [{ id: 'h1', file: 'hooks.ts' }],
      approvalTtlMs: 60_000,
      limits: { maxCostUsd: 0.05 },
      modelSettings: { temperature: 0.2, maxTokens: 1024 },
      retry: { maxRetries: 4, backoff: { initialMs: 1000 }, timeoutMs: 30_000 },
      compaction: { thresholdPercent: 0.8 },
      skills: [
        { inline: { name: 'alpha', description: 'First skill', content: '# Alpha\nDo alpha things.' } },
        { inline: { name: 'beta', description: 'Second skill', content: 'Beta steps.' } },
      ],
      tools: [{ file: 'tools/lookup.ts' }],
      subagents: {
        helper: {
          inline: { name: 'helper', description: 'Looks things up', model: MODEL, instructions: 'You look things up.' },
        },
      },
    };
    const dir = writeDir(specToAgentDir(spec).files);
    // A { file } tool ref writes nothing: the file is expected to exist in the directory.
    writeFiles(dir, [{ path: 'tools/lookup.ts', content: 'export default {};\n' }]);
    const result = await agentDirToSpec(dir);
    expect(result).toEqual({ spec, dropped: [] });
  });

  it('lists exactly the keys a directory cannot hold in dropped', () => {
    const spec: AgentSpecV2 = {
      version: 2,
      name: 'dropped',
      model: MODEL,
      instructions: 'x',
      guardrails: [{ id: 'g1', name: 'pii' }],
      mcpServers: { local: { command: 'run-it' } },
      tools: [{ builtin: 'web_fetch' }],
    };
    const { dropped } = specToAgentDir(spec);
    expect(dropped).toHaveLength(3);
    expect(dropped.map((d) => d.field).sort()).toEqual(['guardrails', 'mcpServers', 'tools.0']);
    expect(dropped.find((d) => d.field === 'tools.0')?.reason).toBe("agent directories cannot reference 'builtin' tools");
    expect(dropped.find((d) => d.field === 'guardrails')?.reason).toBe("agent directories have no 'guardrails' key");
  });

  it('reports the other non-directory rows: instructions file, skill dirs, bad tool paths, extra hooks, ref sub-agents', () => {
    const spec: AgentSpecV2 = {
      version: 2,
      name: 'more-drops',
      model: MODEL,
      instructions: { file: 'prompts/system.md' },
      skills: [{ dir: 'skills/pack' }, { registry: 'changelog' }],
      tools: [{ file: 'lib/tool.ts' }, { file: 'tools/ok.ts', approval: 'always' }, { hosted: 'web_search' }],
      hooks: [
        { id: 'h1', file: 'hooks.ts' },
        { id: 'h2', file: 'more-hooks.ts' },
        { id: 'h3', inline: { name: 'audit', point: 'preToolCall', code: 'return;' } },
      ],
      subagents: { remote: { remote: { url: 'https://agents.example.com/a', description: 'A deployed agent' } } },
      memory: [{ name: 'notes', scope: 'global', provider: { type: 'in-memory' } }],
    };
    const { files, dropped } = specToAgentDir(spec);
    // The one allowed hooks file still lands in agent.yaml.
    expect(files.find((f) => f.path === 'agent.yaml')?.content).toContain('hooks: hooks.ts');
    expect(dropped.map((d) => d.field).sort()).toEqual(
      [
        'instructions',
        'skills.0',
        'skills.1',
        'tools.0',
        'tools.1',
        'tools.2',
        'hooks.1',
        'hooks.2',
        'subagents.remote',
        'memory',
      ].sort()
    );
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED for a code config directory', async () => {
    const dir = writeDir([{ path: 'agent.ts', content: 'export default {};\n' }]);
    await expect(agentDirToSpec(dir)).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      message: expect.stringContaining('is a code config'),
    });
  });

  it('throws LOUSHO_SPEC_INVALID when the config has no model', async () => {
    const dir = writeDir([{ path: 'agent.json', content: '{ "instructions": "hi" }\n' }]);
    await expect(agentDirToSpec(dir)).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      message: expect.stringContaining("has no 'model'"),
    });
  });

  it('reads a YAML-config directory without importing anything', async () => {
    const spy = vi.mocked(importModule);
    spy.mockClear();
    const { spec, dropped } = await agentDirToSpec(fixture('yaml-inline'));
    expect(spy).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
    expect(spec).toMatchObject({
      version: 2,
      name: 'yaml-inline',
      description: 'Instructions live in the config, no other files',
      model: 'openai/gpt-4o-mini',
      instructions: 'You are the YAML fixture agent.',
      maxSteps: 2,
    });
  });

  it('reads registry/inbox-triage and names the files a spec cannot hold', async () => {
    const dir = path.join(tmpDir(), 'inbox-triage');
    // Copy first: a test never writes into registry/.
    cpSync(registryDir('inbox-triage'), dir, { recursive: true });
    const { spec, dropped } = await agentDirToSpec(dir);
    expect(dropped.map((d) => d.field).sort()).toEqual([
      'approve.ts',
      'channels/inbound.ts',
      'memory/senders.ts',
      'schedules/poll-inbox.ts',
    ]);
    expect(spec).toMatchObject({
      version: 2,
      name: 'inbox-triage',
      model: 'openrouter/openai/gpt-4o-mini',
      maxSteps: 15,
      permissionMode: 'default',
      tools: [{ file: 'tools/inbox.ts' }, { file: 'tools/replies.ts' }],
      hooks: [{ id: 'h1', file: 'hooks.ts' }],
      limits: { maxCostUsd: 0.05 },
      compaction: { thresholdPercent: 0.8 },
      permissions: [
        { id: 'p1', tool: 'delete_message', action: 'deny' },
        { id: 'p2', tool: 'send_reply', action: 'ask' },
        { id: 'p3', action: 'allow' },
      ],
    });
    expect(spec.instructionsByFamily?.openai).toContain('Work the loop one tool call at a time');
  });

  it('lists config keys a spec cannot hold in dropped', async () => {
    const dir = writeDir([
      {
        path: 'agent.json',
        content: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          instructions: 'hi',
          approve: 'approve.ts',
          store: { dir: './.lousho' },
          toolConcurrency: 2,
          projectInstructions: true,
          engine: 'pi',
        }),
      },
    ]);
    const { dropped } = await agentDirToSpec(dir);
    expect(dropped.map((d) => d.field)).toEqual(['approve', 'store', 'toolConcurrency', 'projectInstructions', 'engine']);
    expect(dropped[0].reason).toContain('approver');
  });

  it('reads a skill folder with extra files back as { dir }', async () => {
    const dir = writeDir([
      { path: 'agent.yaml', content: 'model: openai/gpt-4o-mini\n' },
      { path: 'instructions.md', content: 'hi\n' },
      { path: 'skills/my-skill/SKILL.md', content: '---\nname: my-skill\ndescription: Has extras\n---\n\nContent.\n' },
      { path: 'skills/my-skill/cheatsheet.md', content: 'extra\n' },
    ]);
    const { spec, dropped } = await agentDirToSpec(dir);
    expect(dropped).toEqual([]);
    expect(spec.skills).toEqual([{ dir: 'skills/my-skill' }]);
  });
});
