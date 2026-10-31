/**
 * The dual-package hazard: a process that loads both the CJS (`dist/*.js`) and
 * the ESM (`dist/*.mjs`) build gets two copies of the SDK. A tool file written
 * as ESM imports `defineTool` from one copy while the agent directory may be
 * loaded by the other; the "made by defineX()" brands must hold across copies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const ROOT = path.resolve(__dirname, '..', '..');
const BUILT = existsSync(path.join(ROOT, 'dist', 'index.js')) && existsSync(path.join(ROOT, 'dist', 'cli', 'chat.mjs'));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('brands across two loaded copies of the SDK', () => {
  it('a tool, schedule and remote sub-agent made by one copy pass the other copy\'s check', async () => {
    const first = {
      tool: await import('../tools/defineTool'),
      schedule: await import('../schedules/defineSchedule'),
      remote: await import('../subagents/remoteAgent'),
    };
    vi.resetModules();
    const second = {
      tool: await import('../tools/defineTool'),
      schedule: await import('../schedules/defineSchedule'),
      remote: await import('../subagents/remoteAgent'),
    };
    expect(second.tool.defineTool).not.toBe(first.tool.defineTool);

    const tool = first.tool.defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });
    const schedule = first.schedule.defineSchedule({ cron: '0 9 * * *', prompt: 'hi' });
    const remote = first.remote.defineRemoteSubagent({ description: 'r', run: async () => 'ok' });

    expect(second.tool.isDefinedTool(tool)).toBe(true);
    expect(second.schedule.isDefinedSchedule(schedule)).toBe(true);
    expect(second.remote.isRemoteSubagent(remote)).toBe(true);
    expect(second.tool.isDefinedTool({ ...tool })).toBe(false);
    // Imports (and so transforms) these module graphs twice inside the test: ~3 s alone on Windows, more under a full parallel run.
  }, 30_000);
});

/** A project whose node_modules links this checkout, with an agent directory holding an ESM and a CJS tool file. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lousho-dual-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  // 'junction' makes a directory link without the symlink privilege on Windows; other platforms ignore the type.
  symlinkSync(ROOT, path.join(dir, 'node_modules', 'lousho'), 'junction');
  symlinkSync(path.join(ROOT, 'node_modules', 'zod'), path.join(dir, 'node_modules', 'zod'), 'junction');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dual', private: true }));
  const agent = path.join(dir, 'simple');
  mkdirSync(path.join(agent, 'tools'), { recursive: true });
  writeFileSync(path.join(agent, 'agent.json'), JSON.stringify({ name: 'simple', model: 'mock/mock-1' }));
  writeFileSync(path.join(agent, 'instructions.md'), 'You are simple.\n');
  writeFileSync(
    path.join(agent, 'tools', 'ping.mjs'),
    "import { z } from 'zod';\nimport { defineTool } from 'lousho';\n" +
      "export default defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });\n"
  );
  writeFileSync(
    path.join(agent, 'tools', 'pong.cjs'),
    "const { z } = require('zod');\nconst { defineTool } = require('lousho');\n" +
      "module.exports = defineTool({ name: 'pong', description: 'Pong', input: z.object({}), execute: () => 'ping' });\n"
  );
  return dir;
}

const LIST_TOOLS = `.then(async (r) => { const { manifest } = await r.resolveAgentDir('./simple'); console.log(manifest.tools.join(',')); })`;

describe.skipIf(!BUILT)('agent directory tools through both builds (needs npm run build)', () => {
  it('loads ESM and CJS tool files from the CJS build', () => {
    const cwd = project();
    const res = spawnSync(process.execPath, ['-e', `Promise.resolve(require('lousho'))${LIST_TOOLS}`], { cwd, encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.stdout.trim()).toBe('ping,pong');
  });

  it('loads ESM and CJS tool files from the ESM build', () => {
    const cwd = project();
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `import('lousho')${LIST_TOOLS}`], { cwd, encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.stdout.trim()).toBe('ping,pong');
  });

  it('lousho chat <agent-dir> runs a turn with the tools loaded', () => {
    const cwd = project();
    const bin = path.join(ROOT, 'bin', 'lousho.js');
    const res = spawnSync(process.execPath, [bin, 'chat', 'simple'], { cwd, input: 'hi\n', encoding: 'utf8' });
    expect(res.stderr).not.toMatch(/none of these is a defineTool/);
    expect(res.stdout).toContain('This is a mock response.');
    expect(res.status).toBe(0);
  });
});
