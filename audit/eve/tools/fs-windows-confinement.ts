/* TOOLS: NodeWorkspace confinement probes specific to Windows: directory junctions, 8.3 short
   names, trailing dots/spaces, ADS, device names, case variations.
   Run: npx tsx eve/tools/fs-windows-confinement.ts */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsTools, NodeWorkspace } from '@lousho/build-ai-agent';

const base = mkdtempSync(join(tmpdir(), 'eve-win-'));
const root = join(base, 'ws');
mkdirSync(root);
mkdirSync(join(base, 'outside'));
writeFileSync(join(base, 'outside', 'secret.txt'), 'TOP-SECRET');
symlinkSync(join(base, 'outside'), join(root, 'jdir'), 'junction');

const tools: any[] = createFsTools(new NodeWorkspace({ root }));
const read = tools.find((t) => t.name === 'read_file');
const write = tools.find((t) => t.name === 'write_file');
async function t(label: string, fn: () => Promise<unknown>) {
  try { console.log(`ALLOWED  ${label} -> ${String(await fn()).slice(0, 50).replace(/\n/g, ' ')}`); }
  catch (e) { console.log(`refused  ${label} -> ${String((e as Error).message).slice(0, 80)}`); }
}
await t('read via junction jdir/secret.txt', () => read.execute({ path: 'jdir/secret.txt' }, {}));
await t('write via junction jdir/new.txt', () => write.execute({ path: 'jdir/new.txt', content: 'x' }, {}));
await t('read "... /secret" trailing', () => read.execute({ path: '.. ./outside/secret.txt' }, {}));
await t('ADS a.txt::$DATA', () => write.execute({ path: 'a.txt::$DATA', content: 'x' }, {}));
await t('device CON.txt', () => write.execute({ path: 'sub/CON.txt', content: 'x' }, {}));
await t('device "nul .txt"', () => write.execute({ path: 'nul .txt', content: 'x' }, {}));
await t('device CONIN$', () => read.execute({ path: 'CONIN$' }, {}));
await t('device CONOUT$', () => write.execute({ path: 'CONOUT$', content: 'x' }, {}));
await t('8.3 short name of root parent', () => read.execute({ path: 'JDIR~1/secret.txt' }, {}));
await t('\\\\?\\ prefix', () => read.execute({ path: '\\\\?\\C:\\Windows\\win.ini' }, {}));
await t('\\??\\ prefix', () => read.execute({ path: '\\??\\C:\\Windows\\win.ini' }, {}));
