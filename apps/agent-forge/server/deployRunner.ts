/**
 * LOU-R2: "Deploy this agent" action - actually shells out to the existing
 * `lousho build` CLI command (src/cli/build.ts, invoked via `bin/lousho.js`)
 * against the currently-selected agent's saved `AgentSpec` file, rather than
 * reimplementing scaffold/build/describe against the `DeploymentAdapter`
 * registry a second time in this server.
 *
 * Kept deliberately simple per the epic brief: buffers the child process's
 * stdout/stderr and returns them once it exits, rather than reusing LOU-O's
 * full log-streaming infrastructure - a build is a one-shot action the user
 * triggers and waits on, not a long-lived run with its own status pills.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { DeployResult } from '../shared/wireTypes';
import { agentSpecFilePath } from '../src/persistence/fsAgentStore';

/**
 * Deploy target names this app offers in the Settings dropdown. Mirrors
 * `registerBuiltInAdapters()`'s registration list in `src/deploy/index.ts`
 * (`node-server`, `cloudflare-worker`, `docker`) - hand-kept in sync rather
 * than imported, because that function (and the adapter registry it
 * populates) is an internal wiring helper the SDK's public
 * `@lousho/build-ai-agent` entrypoint doesn't re-export (only the
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
 * Runs `node <repoRoot>/bin/lousho.js build --target=<adapter> --agent=<agentId's saved spec> --out=<repoRoot>/.lousho/build/<adapter>/<agentId>`
 * and resolves once it exits (never rejects - a failing build is a normal,
 * displayable outcome, not an exceptional one, matching `runBuild()`'s own
 * "never throws" contract in src/cli/build.ts).
 *
 * Requires the SDK to have been built (`npm run build` at the repo root, so
 * `dist/cli/build.js` exists) - same prerequisite the `lousho` CLI itself
 * has outside this dev environment.
 */
export function runDeploy(baseDir: string, agentId: string, adapter: string): Promise<DeployResult> {
  const cliEntry = path.join(baseDir, 'bin', 'lousho.js');
  const agentPath = agentSpecFilePath(baseDir, agentId);
  const outDir = path.join(baseDir, '.lousho', 'build', adapter, agentId);
  const args = ['build', `--target=${adapter}`, `--agent=${agentPath}`, `--out=${outDir}`];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd: baseDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, command: `node ${cliEntry} ${args.join(' ')}` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr, command: `node ${cliEntry} ${args.join(' ')}` });
    });
  });
}
