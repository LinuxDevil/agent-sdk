// Typecheck-only repro (npx tsc --noEmit -p . from audit/ PASSES): t.result.object is `any`, so a wrong type and a non-existent field both compile.
import { z } from 'zod';
import { createAgent, defineEval } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const agent = createAgent({ provider: mockModel(['{"a":1}']), output: z.object({ a: z.number() }) });
const direct: number | undefined = (await agent.send('x')).object?.a; // OK: typed
defineEval({ name: 'typed', agent, async test(t) { await t.send('x'); const a: string = t.result?.object?.a; const b: string = t.result?.object?.doesNotExist; void a; void b; } });
void direct;
