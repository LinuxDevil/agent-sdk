// Does Qwen's "/no_think" soft switch keep the local reasoning model inside its 8k context for the invoice schema?
import { readFileSync } from 'node:fs';
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local.js';
import { Extraction } from '../schema.js';
import { EXTRACT_INSTRUCTIONS } from '../pipeline.js';

const doc = readFileSync(new URL('../fixtures/inv-01-acme-us.txt', import.meta.url), 'utf8');
for (const [label, instr, msg] of [
  ['no_think in system', EXTRACT_INSTRUCTIONS + '\n/no_think', 'Document id inv-01:\n\n' + doc],
  ['no_think in user', EXTRACT_INSTRUCTIONS, 'Document id inv-01:\n\n' + doc + '\n/no_think'],
] as const) {
  const t0 = Date.now();
  try {
    const r = await createAgent({ provider: localProvider(), instructions: instr, output: Extraction, retry: false }).send(msg);
    console.log(`[${label}] ${Date.now() - t0}ms finish=${r.finishReason} in=${r.usage.inputTokens} out=${r.usage.outputTokens} reasoning=${r.usage.reasoningTokens} object=${JSON.stringify(r.object)?.slice(0, 200)}`);
  } catch (e: any) {
    console.log(`[${label}] ${Date.now() - t0}ms THREW ${e.statusCode} ${e.message.slice(0, 120)}`);
  }
}
