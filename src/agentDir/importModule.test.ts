/**
 * `withFreshImports` re-evaluates the local files a reloaded file imports
 * (`lousho dev` hot reload). The resolve hook it installs is a Node loader
 * hook, which vitest's own module runner bypasses, so this bundles
 * importModule.ts and runs it in a plain `node` process, as the CLI does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-fresh-imports-'));
  const { build } = await import('esbuild');
  await build({
    entryPoints: [path.join(__dirname, 'importModule.ts')],
    outfile: path.join(dir, 'importModule.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('withFreshImports', () => {
  it('re-evaluates the local helpers of a reloaded file, not only the file itself', () => {
    const agent = path.join(dir, 'agent');
    fs.mkdirSync(path.join(agent, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(agent, 'tool.ts'), "import { version } from './lib/helper.ts';\nexport const seen: string = version;\n");
    const helper = path.join(agent, 'lib', 'helper.ts');
    const script = `
      import * as fs from 'node:fs';
      import { importModule, withFreshImports } from ${JSON.stringify(pathToFileURL(path.join(dir, 'importModule.mjs')).href)};
      const seen = [];
      for (const [i, v] of ['v1', 'v2', 'v3'].entries()) {
        fs.writeFileSync(${JSON.stringify(helper)}, 'export const version: string = ' + JSON.stringify(v) + ';\\n');
        const mod = await withFreshImports('1-' + i, () => importModule(${JSON.stringify(path.join(agent, 'tool.ts'))}));
        seen.push(mod.seen);
      }
      console.log(seen.join(','));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('v1,v2,v3');
  });
});
