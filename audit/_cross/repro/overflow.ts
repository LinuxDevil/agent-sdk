import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local';
const big = Array.from({ length: 2500 }, (_, i) => `line ${i}: GET /api/orders/${i} 200 12ms upstream=app-${i % 7}`).join('\n');
const agent = createAgent({ provider: localProvider(), instructions: 'Be terse.', compaction: { thresholdPercent: 0.8 } as any });
try {
  const r = await agent.send(`Count the lines below.\n${big}`);
  console.log('OK?!', r.text.slice(0, 200), r.usage);
} catch (e: any) {
  console.log('category:', e?.category, e?.error?.category, Object.keys(e ?? {}));
  console.log('name:', e?.name, '| code:', e?.code, '| retryable:', e?.retryable, '\nmessage:', String(e?.message).slice(0, 600));
  console.log('cause:', String(e?.cause?.message ?? e?.cause).slice(0, 300));
}
