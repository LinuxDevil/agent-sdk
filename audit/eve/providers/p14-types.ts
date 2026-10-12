// P14 (tsc only): type-level checks for structured output + decide().
// Run: npx tsc --noEmit --skipLibCheck --strict --module nodenext --moduleResolution nodenext --target es2022 eve/providers/p14-types.ts
import { z } from 'zod';
import { createAgent, decide } from '@lousho/build-ai-agent';

const Ticket = z.object({ title: z.string(), n: z.number() });
const a = createAgent({ model: 'openai/gpt-4o-mini', output: Ticket });
const b = createAgent({ model: 'openai/gpt-4o-mini', output: { schema: Ticket, promptSchema: false } });
export async function check() {
  const r1 = await a.send('x');
  const t1: number | undefined = r1.object?.n;
  const r2 = await b.send('x');
  const t2: number | undefined = r2.object?.n; // OutputSpec form: still typed?
  const d = await decide({ input: 'x', questions: [{ type: 'choice', name: 'route', instructions: 'i', choices: [{ value: 'billing' }] }] });
  // @ts-expect-error - answers are not keyed by question name; this is what users want
  const route: string = d.answers.route.choice;
  return [t1, t2, route];
}
