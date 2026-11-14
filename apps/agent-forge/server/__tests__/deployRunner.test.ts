/**
 * X05 unit coverage for deployRunner: `publishedSpecPath`/`writePublishedSpec`
 * own `.lousho/agents/<id>/published.yaml`, and `runDeploy` spawns
 * `lousho build --agent=<published snapshot>` with an injectable `spawn`.
 * The snapshot file holds the spec's v1 projection (`toLegacySpec`) because
 * `lousho build`/`lousho mcp` still load spec files through the v1
 * `loadSpec`, which rejects `version: 2` documents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { publishedSpecPath, runDeploy, writePublishedSpec, DEPLOY_ADAPTERS, isDeployAdapter } from '../deployRunner';
import { mergeLegacySave } from '../storage/legacySpec';
import type { AgentSpec } from '@linuxdevil/lousho';

const V1_SPEC: AgentSpec = {
  name: 'deploy-me',
  prompt: 'You are a deployable agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['web-fetch'],
};

/** A spawn double that closes successfully and records its argv. */
function fakeSpawn(calls: string[][]) {
  return ((_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as ChildProcess['stdout'];
    child.stderr = new EventEmitter() as ChildProcess['stderr'];
    process.nextTick(() => child.emit('close', 0));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('publishedSpecPath / writePublishedSpec', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x05-runner-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes the published snapshot inside the agent sidecar folder as v1 YAML', async () => {
    const spec = mergeLegacySave(undefined, V1_SPEC);
    const filePath = await writePublishedSpec(baseDir, 'deploy-me', spec);
    expect(filePath).toBe(publishedSpecPath(baseDir, 'deploy-me'));
    expect(filePath).toBe(path.join(baseDir, '.lousho', 'agents', 'deploy-me', 'published.yaml'));
    const fed = parseYaml(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(fed).toMatchObject({
      name: 'deploy-me',
      prompt: 'You are a deployable agent.',
      provider: { type: 'mock', model: 'mock-1' },
    });
    expect(fed['version']).toBeUndefined();
    // The sidecar folder keeps published.yaml out of AgentRepo.list()'s scan.
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'agents', 'deploy-me.yaml'))).toBe(false);
  });
});

describe('runDeploy', () => {
  let baseDir: string;
  let calls: string[][];

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x05-runner-'));
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('spawns `lousho build` against the published snapshot and reports its version', async () => {
    const specPath = path.join(baseDir, '.lousho', 'agents', 'ops', 'published.yaml');
    const result = await runDeploy(baseDir, 'ops', 'node-server', { version: 3, specPath }, { spawn: fakeSpawn(calls) });
    expect(result.exitCode).toBe(0);
    expect(result.version).toBe(3);
    expect(calls).toHaveLength(1);
    const args = calls[0];
    // argv[0] is the lousho.js entry; the build flags follow it.
    expect(args.slice(1)).toEqual(['build', '--target=node-server', `--agent=${specPath}`, `--out=${path.join(baseDir, '.lousho', 'build', 'node-server', 'ops')}`]);
    expect(result.command).toContain(`--agent=${specPath}`);
  });

  it('resolves a non-zero exit as a failed DeployResult, still carrying the version', async () => {
    const spawn = (() => {
      const child = new EventEmitter() as ChildProcess;
      const stderr = new EventEmitter();
      child.stdout = new EventEmitter() as ChildProcess['stdout'];
      child.stderr = stderr as unknown as ChildProcess['stderr'];
      process.nextTick(() => {
        stderr.emit('data', Buffer.from('build exploded'));
        child.emit('close', 2);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const result = await runDeploy(
      baseDir,
      'ops',
      'docker',
      { version: 7, specPath: path.join(baseDir, 'published.yaml') },
      { spawn }
    );
    expect(result).toMatchObject({ exitCode: 2, version: 7 });
    expect(result.stderr).toContain('build exploded');
  });
});

describe('deploy adapter names', () => {
  it('knows the three built-in adapters', () => {
    expect(DEPLOY_ADAPTERS).toEqual(['node-server', 'cloudflare-worker', 'docker']);
    expect(isDeployAdapter('node-server')).toBe(true);
    expect(isDeployAdapter('carrier-pigeon')).toBe(false);
  });
});
