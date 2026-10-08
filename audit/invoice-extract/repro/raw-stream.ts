// Diagnose the context overflow: replay the SDK's exact extraction request (system prompt + json_schema) as a raw
// streaming Chat Completions call and watch where the tokens go (reasoning vs content).
import { readFileSync } from 'node:fs';
import { createAgent, type LLMProvider } from '@lousho/build-ai-agent';
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
import { Extraction } from '../schema.js';
import { EXTRACT_INSTRUCTIONS } from '../pipeline.js';

let captured: any;
const cap: LLMProvider = { name: 'cap', defaultModel: 'm', async generate(o: any) { captured = o; return { text: '{}', finishReason: 'stop' } as any; }, async stream() { throw 0; }, supportsTools: () => true, supportsStreaming: () => false, getModels: async () => [] };
const doc = 'Document id inv-01:\n\n' + readFileSync(new URL('../fixtures/inv-01-acme-us.txt', import.meta.url), 'utf8');
await createAgent({ provider: cap, instructions: EXTRACT_INSTRUCTIONS, output: Extraction, maxSteps: 1 }).send(doc);
const system = captured.messages[0].content as string;
console.log('system prompt chars', system.length, 'schema chars', JSON.stringify(captured.responseFormat.schema).length);

const useSchema = process.argv[2] !== 'noschema';
const res = await fetch(`${LOCAL_BASE_URL}/chat/completions`, {
  signal: AbortSignal.timeout(Number(process.env.CAP_MS ?? 600000)),
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: LOCAL_MODEL, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: doc }],
    ...(useSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: captured.responseFormat.schema } } } : {}),
  }),
});
let reasoning = '', content = '', usage: any, err = '';
const dec = new TextDecoder();
let buf = '';
const t0 = Date.now(); let lastLog = 0;
try { for await (const chunk of res.body as any) {
  if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`  +${Math.round((Date.now() - t0) / 1000)}s reasoning=${reasoning.length} content=${content.length} tail=${JSON.stringify((content || reasoning).slice(-80))}`); }
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('data:') || line === 'data: [DONE]') { if (line && !line.startsWith('data:')) err += line; continue; }
    try {
      const j = JSON.parse(line.slice(5));
      if (j.error) err += JSON.stringify(j.error);
      const d = j.choices?.[0]?.delta ?? {};
      reasoning += d.reasoning_content ?? d.reasoning ?? '';
      content += d.content ?? '';
      if (j.usage) usage = j.usage;
    } catch { err += line; }
  }
} } catch (e) { err += 'ABORTED ' + String(e); }
console.log('status', res.status, 'schema', useSchema, 'usage', JSON.stringify(usage), 'err', err.slice(0, 300));
console.log('reasoning chars', reasoning.length, 'content chars', content.length);
console.log('reasoning tail:', JSON.stringify(reasoning.slice(-600)));
console.log('content head:', JSON.stringify(content.slice(0, 300)));
console.log('content tail:', JSON.stringify(content.slice(-300)));
