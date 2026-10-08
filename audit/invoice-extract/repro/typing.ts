// Compile-only (npx tsc --noEmit -p .): what the TS types say about structured output, approvals and flows.
import { createAgent, type LLMProvider } from '@lousho/build-ai-agent';
import { FlowExecutor, type FlowExecutionResult } from '@lousho/build-ai-agent/flows';
import { z } from 'zod';
import { Extraction, type ExtractionT } from '../schema.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare const provider: LLMProvider;
const agent = createAgent({ provider, output: Extraction });

export async function checks() {
  const r = await agent.send('x');
  const ok1: Equal<typeof r.object, ExtractionT | undefined> = true; // PASS expected
  if (r.object?.document.kind === 'invoice') {
    const total: string = r.object.document.total; // discriminated union narrows
    void total;
  }
  const s = await agent.session().send('x');
  const ok2: Equal<typeof s.object, ExtractionT | undefined> = true;
  const run = agent.stream('x');
  const sr = await run.result;
  const ok3: Equal<typeof sr.object, ExtractionT | undefined> = true;

  // approvals.resolve() continues a run of the same agent - is its object still typed?
  const resumed = await agent.approvals.resolve({ id: 'a', approved: true });
  const ok4: Equal<typeof resumed.object, unknown> = true; // ACTUAL: unknown (asserting ExtractionT | undefined fails) - see FINDINGS

  // flows: output and variables are unknown, no generics
  const fr: FlowExecutionResult = await FlowExecutor.execute({} as any, { agent: { name: 'a' }, provider, variables: {} });
  const ok5: Equal<typeof fr.output, unknown> = true;
  void [ok1, ok2, ok3, ok4, ok5];
}
