import { createAgent, defineTool, FileSessionStore, fileStore, memoryStore, PropagatingToolError } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const T = (label: string, v: unknown) => console.log(label, v);
const err = async (p: Promise<unknown>) => { try { await p; return 'no throw'; } catch (e: any) { return `${e?.name} ${e?.code ?? ''} ${String(e?.message).slice(0, 110)}`; } };
// id + snapshot
{ const a = createAgent({ provider: mockModel(['a', 'b']) }); const s = a.session(); T('id uuid?', /^[0-9a-f-]{36}$/.test(s.id));
  await s.send('hi'); const snap: any = s.messages; try { snap.push({ role: 'user', content: 'x' }); } catch (e: any) { T('snapshot push threw', e.constructor.name); } T('after edit len', s.messages.length); }
// queue ordering of concurrent sends (wait policy)
{ const a = createAgent({ provider: mockModel(['r1', 'r2', 'r3']) }); const s = a.session();
  const [x, y, z2] = await Promise.all([s.send('one'), s.send('two'), s.send('three')]);
  T('wait order', [x.text, y.text, z2.text].join(','), s.messages.map((m: any) => m.role[0] + ':' + String(m.content)).join(' ')); }
// turnPolicy queue: second === first?
{ const slow = defineTool({ name: 'slow', description: 's', input: z.object({}), execute: async () => { await new Promise((r) => setTimeout(r, 50)); return 'done'; } });
  const m = mockModel([{ toolCalls: [{ name: 'slow', args: {} }] }, 'final answer', 'extra']);
  const a = createAgent({ provider: m, tools: [slow] }); const s = a.session({ id: 'q1', turnPolicy: 'queue' });
  const first = s.send('Find flights to Rome.'); await new Promise((r) => setTimeout(r, 5)); const second = s.send('Only direct ones, please.');
  const [f, sec] = await Promise.all([first, second]);
  T('queue same object?', f === sec); T('queue texts', [f.text, sec.text]); T('model calls', m.calls.length, ); T('transcript', s.messages.map((x: any) => x.role).join(','));
  // and doc snippet ordering: second issued synchronously right after first (no tool, no delay)
  const m2 = mockModel(['A', 'B']); const s2 = createAgent({ provider: m2 }).session({ id: 'q2', turnPolicy: 'queue' });
  const f2 = s2.send('Find flights to Rome.'); const g2 = s2.send('Only direct ones, please.');
  const rf = await f2, rg = await g2; T('doc snippet (sync, no tools): same?', rf === rg, rf.text, rg.text, 'calls', m2.calls.length); }
// failing send leaves transcript unchanged
{ const boom = defineTool({ name: 'boom', description: 'b', input: z.object({}), execute: async () => { throw new PropagatingToolError('stop'); } });
  const a = createAgent({ provider: mockModel(['ok', { toolCalls: [{ name: 'boom', args: {} }] }]), tools: [boom] }); const s = a.session();
  await s.send('one'); const before = s.messages.length; T('propagating throw', await err(s.send('two'))); T('transcript unchanged', before === s.messages.length, s.messages.length); }
// aborted send keeps executed tool calls
{ const ac = new AbortController(); const t1 = defineTool({ name: 'refund', description: 'r', input: z.object({}), execute: async () => { ac.abort(); return 'refunded'; } });
  const a = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'refund', args: {} }] }, 'never']), tools: [t1] }); const s = a.session();
  const r = await s.send('refund me', { signal: ac.signal }).catch((e) => e); T('aborted finish', r?.finishReason ?? r?.code); T('aborted transcript', s.messages.map((x: any) => x.role + ':' + String(x.content).slice(0, 20)).join(' | ')); }
// clear while busy
{ const slow = defineTool({ name: 'slow', description: 's', input: z.object({}), execute: async () => { await new Promise((r) => setTimeout(r, 50)); return 'ok'; } });
  const a = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow', args: {} }] }, 'fin']), tools: [slow] }); const s = a.session();
  const p = s.send('x'); await new Promise((r) => setTimeout(r, 10)); T('clear busy', await err(s.clear() as any)); await p; }
// ids
{ const a = createAgent({ provider: mockModel(['a']) }); for (const id of ['../x', 'a/b', 'x'.repeat(129), 'ok.id']) T(`id ${id.slice(0, 10)}`, await err((async () => { const s = a.session({ id }); await s.send('h'); })())); }
// FileSessionStore & fileStore layout
{ const d = join(process.cwd(), 'eve/docs-ui/docs-a/.tmp-store'); rmSync(d, { recursive: true, force: true });
  const a = createAgent({ provider: mockModel(['Hi Ali', 'Ali']) }); const store = new FileSessionStore(join(d, 'fss'));
  await a.session({ id: 'user-42', store }).send('My name is Ali.'); const r = await a.session({ id: 'user-42', store }).send('What is my name?');
  T('FileSessionStore files', readdirSync(join(d, 'fss')), 'turn2 saw history msgs', 'n/a');
  const send = defineTool({ name: 'send_email', description: 's', input: z.object({ to: z.string() }), needsApproval: true, execute: async () => 'ok' });
  const b = createAgent({ provider: mockModel(['Hello', { toolCalls: [{ name: 'send_email', args: { to: 'x' } }] }, 'done']), tools: [send], store: fileStore(join(d, 'fs')) });
  await b.session({ id: 'user-42' }).send('Hello'); const s2 = b.session({ id: 'u2' }); const pr = await s2.send('mail');
  const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(p, e.name)).map((x) => e.name + '/' + x) : [e.name]);
  T('fileStore layout while paused', walk(join(d, 'fs')));
  T('pending()', JSON.stringify(await s2.pending()));
  T('send while awaiting', await err(s2.send('again')));
  T('clear while awaiting', await err(s2.clear()));
  await b.approvals.resolve({ id: pr.approvalId!, approved: true });
  T('fileStore layout after', walk(join(d, 'fs')));
}
