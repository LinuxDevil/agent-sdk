import { createAgent } from '../../src/createAgent';
import { defineMemory, inMemoryMemory, fileMemory, memoryKey } from '../../src/memory/index';
import { mockModel } from '../../src/testing/index';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  // 1. Keyword recall: query words <3 chars -> returns ALL items unfiltered
  const provider = inMemoryMemory();
  for (const t of ['likes tea', 'hates coffee', 'lives in Oslo']) await provider.add('k', { text: t });
  console.log('query "AI" ->', (await provider.list('k', { query: 'AI' })).map(i => i.text));
  console.log('query "my id" ->', (await provider.list('k', { query: 'my id' })).map(i => i.text));
  // substring match: "cat" inside "education"
  const p2 = inMemoryMemory();
  await p2.add('k', { text: 'works in education' });
  await p2.add('k', { text: 'owns a dog' });
  console.log('query "cat" ->', (await p2.list('k', { query: 'cat' })).map(i => i.text));
  // OR-match noise: one common word floods results
  const p2b = inMemoryMemory();
  for (const t of ['the user likes tea', 'the cat is black', 'a user from Oslo']) await p2b.add('k', { text: t });
  console.log('query "user tea preference" ->', (await p2b.list('k', { query: 'user tea preference' })).map(i => i.text));

  // 2. scope fn returning non-strings: silent shared/garbage keys
  const weird = defineMemory({ name: 'w', scope: (() => ({ bad: true })) as never, provider: inMemoryMemory() });
  console.log('memoryKey(object) =', memoryKey(weird as never, {}));
  const num = defineMemory({ name: 'w', scope: (() => 42) as never, provider: inMemoryMemory() });
  console.log('memoryKey(number) =', memoryKey(num as never, {}));
  const nul = defineMemory({ name: 'w', scope: (() => null) as never, provider: inMemoryMemory() });
  console.log('memoryKey(null) =', memoryKey(nul as never, {}));

  // 3. invalid scope type passes defineMemory, crashes at send()
  try {
    const bad = defineMemory({ name: 'bad', scope: 'user' as never, provider: inMemoryMemory() });
    console.log('defineMemory accepted scope:"user"');
    await createAgent({ provider: mockModel(['hi']), memory: [bad] }).send('hello');
  } catch (e) {
    console.log('send() threw:', (e as Error).message);
  }

  // 4. provider.add(undefined) — silent write under key `undefined`
  const p3 = inMemoryMemory();
  const sessionSlot = defineMemory({ name: 's', scope: 'session', provider: p3 });
  const key = memoryKey(sessionSlot);
  console.log('memoryKey(session, no ctx) =', key);
  await p3.add(key as unknown as string, { text: 'oops' });
  console.log('listed under undefined key:', await p3.list(undefined as unknown as string));

  // 5. fileMemory case-insensitive filename collision (Windows/macOS)
  const dir = mkdtempSync(join(tmpdir(), 'lousho-eve-'));
  const fm = fileMemory({ dir });
  await fm.add('notes#user:Alice', { text: 'alice secret' });
  await fm.add('notes#user:ALICE', { text: 'ALICE other user' });
  console.log('files:', readdirSync(dir));
  console.log('user:Alice ->', (await fm.list('notes#user:Alice')).map(i => i.text));
  console.log('user:ALICE ->', (await fm.list('notes#user:ALICE')).map(i => i.text));

  // 6. two provider instances on the same dir racing on one key
  const a = fileMemory({ dir });
  const b = fileMemory({ dir });
  await Promise.all([a.add('k2', { text: 'from A' }), b.add('k2', { text: 'from B' })]);
  console.log('concurrent add across instances ->', (await a.list('k2')).map(i => i.text));

  // 7. recall failure kills the run (corrupt file)
  const badDir = mkdtempSync(join(tmpdir(), 'lousho-eve-bad-'));
  const fm2 = fileMemory({ dir: badDir });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(badDir, encodeURIComponent('notes#global') + '.json'), '{corrupt');
  const notes = defineMemory({ name: 'notes', scope: 'global', provider: fm2 });
  try {
    await createAgent({ provider: mockModel(['hi']), memory: [notes] }).send('hello');
    console.log('run survived corrupt memory');
  } catch (e) {
    console.log('RUN FAILED on corrupt memory file:', (e as Error).message.slice(0, 100));
  }
}
main().catch((e) => { console.error('FATAL', e); });
