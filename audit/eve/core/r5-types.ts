// CORE: TypeScript ergonomics probe. Run: npx tsc --noEmit -p eve/core/tsconfig.json
// Lines marked EXPECT-OK should compile; EXPECT-ERR lines document what the types allow/forbid.
import { z } from 'zod';
import { createAgent, defineTool, type SimpleAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const Out = z.object({ city: z.string(), tempC: z.number() });
const agent = createAgent({ provider: mockModel([]), output: Out });

async function probes() {
  // 1. send(): object typed  (EXPECT-OK)
  const r = await agent.send('x');
  const t1: number | undefined = r.object?.tempC;

  // 2. session().send(): object typed (EXPECT-OK)
  const s = await agent.session().send('x');
  const t2: number | undefined = s.object?.tempC;

  // 3. stream().result typed (EXPECT-OK)
  const st = await agent.stream('x').result;
  const t3: number | undefined = st.object?.tempC;

  // 4. approvals.resolve(): does `object` keep its type after an approval?
  const ap = await agent.approvals.resolve({ id: 'a', approved: true });
  const t4: number | undefined = ap.object?.tempC; // <- typed? (prints an error if `object` is unknown)

  // 5. approvals.streamResolve().result
  const ap2 = await agent.approvals.streamResolve({ id: 'a', approved: true }).result;
  const t5: number | undefined = ap2.object?.tempC;

  // 6. A typed agent where a plain SimpleAgent is expected (subagents, UI source)
  const plain: SimpleAgent = agent;

  // 7. modelSettings: nonsense values accepted at the type level
  createAgent({ provider: mockModel([]), modelSettings: { temperature: -10, maxTokens: -1, topP: 7 } });

  // 8. maxSteps: 0 compiles
  createAgent({ provider: mockModel([]), maxSteps: 0 });

  // 9. finishReason is a closed union? (typo should fail)
  if (r.finishReason === 'max_steps') {
  }

  // 10. toolCalls element shape: wire shape vs event shape
  const name: string = r.toolCalls[0].toolName;

  // 11. toolChoice is not an agent option
  createAgent({ provider: mockModel([]), modelSettings: { toolChoice: 'required' } });

  void [t1, t2, t3, t4, t5, plain, name];
}
void probes;
void defineTool;
