/**
 * Root confinement probe: calls the workspace tools' execute() directly (no
 * model) with hostile paths and reports which are refused.
 *   npx tsx coding-agent/repro/confinement.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFsTools, createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';

const base = mkdtempSync(path.join(tmpdir(), 'lousho-conf-'));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
mkdirSync(path.join(root, 'src'), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(root, 'src', 'a.txt'), 'inside\n');
writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
// a sibling dir whose name starts with the root's name: classic prefix-check bug
mkdirSync(path.join(base, 'root-evil'));
writeFileSync(path.join(base, 'root-evil', 'x.txt'), 'prefix sibling\n');

const links: string[] = [];
const tryLink = (label: string, fn: () => void) => { try { fn(); links.push(label); } catch (e) { console.log(`  (could not create ${label}: ${(e as Error).message.split('\n')[0]})`); } };
tryLink('junction', () => symlinkSync(outside, path.join(root, 'junc'), 'junction'));
tryLink('dir-symlink', () => symlinkSync(outside, path.join(root, 'dirlink'), 'dir'));
tryLink('file-symlink', () => symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'filelink.txt'), 'file'));
tryLink('dangling-symlink', () => symlinkSync(path.join(outside, 'nope.txt'), path.join(root, 'dangling.txt'), 'file'));
tryLink('hardlink', () => linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt')));

const ws = new NodeWorkspace({ root });
const tools = Object.fromEntries([...createFsTools(ws), createShellTool(ws, { needsApproval: false })].map((t) => [t.name, t]));
const ctx = { toolCallId: 't', abortSignal: new AbortController().signal } as never;

async function probe(tool: string, args: Record<string, unknown>, expectRefused = true) {
  let outcome: string;
  let refused: boolean;
  try {
    const r = await (tools[tool] as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(args, ctx);
    outcome = JSON.stringify(r).slice(0, 110);
    refused = false;
  } catch (e) {
    outcome = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);
    refused = true;
  }
  const verdict = refused === expectRefused ? 'ok ' : 'BAD';
  console.log(`${verdict} ${tool} ${JSON.stringify(args).slice(0, 70)}\n      -> ${outcome}`);
}

const abs = path.join(outside, 'secret.txt');
console.log(`platform=${process.platform} links=${links.join(',')}`);
await probe('read_file', { path: 'src/a.txt' }, false);
await probe('read_file', { path: '../outside/secret.txt' });
await probe('read_file', { path: 'src/../../outside/secret.txt' });
await probe('read_file', { path: 'src\\..\\..\\outside\\secret.txt' });
await probe('read_file', { path: '../root-evil/x.txt' });
await probe('read_file', { path: abs });
await probe('read_file', { path: path.join(root, 'src', 'a.txt') }); // absolute but inside
await probe('read_file', { path: abs.replace(/^([A-Za-z]):\\/, '$1:') }); // C:Users\... drive-relative
await probe('read_file', { path: '/' + abs.replace(/\\/g, '/') });
await probe('read_file', { path: '\\\\?\\' + abs });
await probe('read_file', { path: '\\\\localhost\\c$\\Windows\\win.ini' });
await probe('read_file', { path: 'file:///' + abs.replace(/\\/g, '/') }); // URL form: harmless (no such file) but how is it reported?
await probe('read_file', { path: '.. /outside/secret.txt' });
await probe('read_file', { path: 'src/a.txt::$DATA' });
await probe('read_file', { path: 'NUL' });
await probe('read_file', { path: 'src/con.txt' });
await probe('read_file', { path: '~/.ssh/id_rsa' }); // literal "~" dir: not found inside root
await probe('read_file', { path: '%USERPROFILE%\\.ssh\\id_rsa' });
if (links.includes('junction')) {
  await probe('read_file', { path: 'junc/secret.txt' });
  await probe('write_file', { path: 'junc/new.txt', content: 'pwned' });
  await probe('list_dir', { path: 'junc' });
  await probe('grep', { pattern: 'SECRET' }, false); // must not descend into the junction
  await probe('glob', { pattern: '**/*.txt' }, false);
}
if (links.includes('dir-symlink')) await probe('read_file', { path: 'dirlink/secret.txt' });
if (links.includes('file-symlink')) {
  await probe('read_file', { path: 'filelink.txt' });
  await probe('edit_file', { path: 'filelink.txt', old_string: 'TOP', new_string: 'PWNED' });
}
if (links.includes('dangling-symlink')) await probe('write_file', { path: 'dangling.txt', content: 'created outside?' });
if (links.includes('hardlink')) await probe('read_file', { path: 'hard.txt' }, false); // documented: undetectable
await probe('write_file', { path: '../outside/written.txt', content: 'x' });
await probe('write_file', { path: '.', content: 'x' });
await probe('edit_file', { path: '../outside/secret.txt', old_string: 'TOP', new_string: 'X' });
await probe('list_dir', { path: '..' });
await probe('glob', { pattern: '../**/*.txt' });
await probe('glob', { pattern: '../outside/*.txt' });
await probe('grep', { pattern: 'SECRET', path: '..' });
await probe('grep', { pattern: 'SECRET', glob: '../outside/*' });
// The shell is documented as NOT confined; show how far it reaches with an innocent-looking allowlisted command.
const allowShell = createShellTool(ws, { needsApproval: false, allow: ['node --test', 'dir', 'ls'] });
const sx = (a: unknown) => (allowShell as unknown as { execute: (a: unknown, c: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }> }).execute(a, ctx);
for (const command of ['dir ..\\outside', 'ls ../outside', 'node --test ..\\outside', `dir "${outside}"`]) {
  try { const r = await sx({ command }); console.log(`shell allow-list passed ${JSON.stringify(command)} exit=${r.exitCode} sees secret=${/secret\.txt/.test(r.stdout)}`); }
  catch (e) { console.log(`shell refused ${JSON.stringify(command)}: ${(e as Error).message.slice(0, 120)}`); }
}
console.log('outside files after probes:', existsSync(path.join(outside, 'written.txt')), existsSync(path.join(outside, 'nope.txt')), readFileSync(path.join(outside, 'secret.txt'), 'utf8').trim());
rmSync(base, { recursive: true, force: true });
