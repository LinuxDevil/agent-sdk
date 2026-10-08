import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

describe('ops-pipeline entry point (DUI-F6)', () => {
  it('binds MONITOR_PORT/SLACK_PORT so the documented trigger script reaches it', async () => {
    const monitorPort = await freePort();
    const slackPort = await freePort();
    const env = { ...process.env, MONITOR_PORT: String(monitorPort), SLACK_PORT: String(slackPort) };
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, 'examples/ops-pipeline/index.ts'], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      let out = '';
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`entry did not start: ${out}`)), 30000);
        child.stdout!.on('data', (d) => {
          out += String(d);
          if (out.includes('Trigger a synthetic error')) {
            clearTimeout(t);
            res();
          }
        });
        child.once('exit', () => rej(new Error(`entry exited early: ${out}`)));
      });
      expect(out).toContain(`127.0.0.1:${monitorPort}/webhook`);
      expect(out).toContain(`127.0.0.1:${slackPort}/slack/interactions`);

      // Same script as `npm run pipeline:demo:trigger`, port from the env.
      const trigger = spawn(process.execPath, [tsx, 'examples/ops-pipeline/mocks/sendSyntheticError.ts'], { env });
      let tout = '';
      trigger.stdout.on('data', (d) => (tout += String(d)));
      const code = await new Promise((res) => trigger.once('exit', res));
      expect(code).toBe(0);
      expect(tout).toContain('Response 202');
    } finally {
      child.kill();
    }
  }, 60000);
});
