/**
 * "Deploy this agent" action - actually shells out to the existing
 * `lousho build` CLI command (src/cli/build.ts, invoked via `bin/lousho.js`)
 * against the agent's PUBLISHED spec snapshot (X05), rather than
 * reimplementing scaffold/build/describe against the `DeploymentAdapter`
 * registry a second time in this server.
 *
 * Kept deliberately simple per the epic brief: buffers the child process's
 * stdout/stderr and returns them once it exits, rather than reusing the
 * full log-streaming infrastructure - a build is a one-shot action the user
 * triggers and waits on, not a long-lived run with its own status pills.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from 'lousho';
import type { DeployResult } from '../shared/wireTypes';
import { writeFileAtomic } from './storage/atomic';
import { toLegacySpec } from './storage/legacySpec';

/**
 * Deploy target names this app offers in the Settings dropdown. Mirrors
 * `registerBuiltInAdapters()`'s registration list in `src/deploy/index.ts`
 * (`node-server`, `cloudflare-worker`, `docker`) - hand-kept in sync rather
 * than imported, because that function (and the adapter registry it
 * populates) is an internal wiring helper the SDK's public
 * `lousho` entrypoint doesn't re-export (only the
 * `DeploymentAdapter`/`getAdapter`/`registerAdapter` TYPES are public, via
 * `src/deploy/types.ts`). `lousho build --target=<name>` is still the real
 * source of truth for what's actually buildable - an unknown/stale name
 * here just surfaces as that command's own "unknown target" error in the
 * deploy log panel rather than silently succeeding.
 */
export const DEPLOY_ADAPTERS = ['node-server', 'cloudflare-worker', 'docker'] as const;
export type DeployAdapter = (typeof DEPLOY_ADAPTERS)[number];

export function isDeployAdapter(value: string): value is DeployAdapter {
  return (DEPLOY_ADAPTERS as readonly string[]).includes(value);
}

/**
 * Path of the published snapshot file deploy and `lousho mcp` use: inside
 * the agent's sidecar folder `.lousho/agents/<id>/`, so `AgentRepo.list()`
 * never mistakes it for an agent spec.
 */
export function publishedSpecPath(baseDir: string, agentId: string): string {
  return path.join(baseDir, '.lousho', 'agents', agentId, 'published.yaml');
}

/**
 * Writes the published snapshot atomically and returns its path.
 *
 * The file holds the spec's v1 projection (`toLegacySpec`), not the raw v2
 * document: both consumers - `lousho build --agent=` and `lousho mcp` -
 * still load spec files through the v1 `loadSpec`, which rejects a
 * `version: 2` document outright. This is the same projection the deploy
 * path always used; only its source changed (the published snapshot rather
 * than the working copy). Secret refs stay refs - nothing is resolved here.
 */
export async function writePublishedSpec(baseDir: string, agentId: string, spec: AgentSpecV2): Promise<string> {
  const filePath = publishedSpecPath(baseDir, agentId);
  await writeFileAtomic(filePath, stringifyYaml(toLegacySpec(spec)));
  return filePath;
}

/** Test seam: `spawn` is injectable so tests never launch a real build. */
export interface DeployDeps {
  spawn?: typeof spawn;
}

/**
 * Runs `node <repoRoot>/bin/lousho.js build --target=<adapter> --agent=<published snapshot> --out=<repoRoot>/.lousho/build/<adapter>/<agentId>`
 * and resolves once it exits (never rejects - a failing build is a normal,
 * displayable outcome, not an exceptional one, matching `runBuild()`'s own
 * "never throws" contract in src/cli/build.ts). The result carries the
 * published `version` that was built.
 *
 * Requires the SDK to have been built (`npm run build` at the repo root, so
 * `dist/cli/build.js` exists) - same prerequisite the `lousho` CLI itself
 * has outside this dev environment.
 */
export async function runDeploy(
  baseDir: string,
  agentId: string,
  adapter: string,
  published: { version: number; specPath: string },
  deps: DeployDeps = {},
  // W11c: a bridge workspace deploys through ITS SDK's bin (the project's
  // installed `lousho`), not `<workspace>/bin/lousho.js` - the route passes
  // `hostSelector.current().sdk.binPath` on bridge mode.
  cliEntry: string = path.join(baseDir, 'bin', 'lousho.js')
): Promise<DeployResult> {
  const spawnFn = deps.spawn ?? spawn;
  const outDir = path.join(baseDir, '.lousho', 'build', adapter, agentId);
  const args = ['build', `--target=${adapter}`, `--agent=${published.specPath}`, `--out=${outDir}`];
  const command = `node ${cliEntry} ${args.join(' ')}`;

  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, [cliEntry, ...args], { cwd: baseDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, command, version: published.version });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr, command, version: published.version });
    });
  });
}
