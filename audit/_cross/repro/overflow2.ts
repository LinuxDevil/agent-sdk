import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../_shared/local';
const big = 'word '.repeat(20000);
const agent = createAgent({ provider: localProvider(), instructions: 'Be terse.' });
const t0 = Date.now();
try { await agent.send(big); } catch (e: any) {
  const plain: Record<string, unknown> = {};
  for (const k of Object.keys(e)) plain[k] = typeof e[k] === 'object' ? JSON.stringify(e[k])?.slice(0, 200) : e[k];
  console.log("compacted:", JSON.stringify(e.compacted)); console.log(`elapsed ${Date.now() - t0}ms`, plain);
}
