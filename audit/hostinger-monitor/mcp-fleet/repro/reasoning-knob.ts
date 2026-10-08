// Can the SDK make the local reasoning model think less? (affects fitting into an 8k context)
import { createAgent } from '@lousho/build-ai-agent';
import { localProvider } from '../../../_shared/local.js';
const q = 'A VM has 8192 MB RAM and uses 3404677120 bytes. Disk 102400 MB, uses 12512837632 bytes. Give RAM% and disk% to 1 decimal. Answer in one line.';
for (const [label, cfg, suffix] of [
  ['default', {}, ''],
  ['reasoning low+force', { reasoning: { effort: 'low', force: true } }, ''],
  ['/no_think in prompt', {}, ' /no_think'],
] as const) {
  const t0 = Date.now();
  const agent = createAgent({ provider: localProvider(), instructions: 'Be terse.', ...(cfg as any) });
  let r: any; try { r = await agent.send(q + suffix); } catch (e: any) { console.log(`[${label}] FAILED ${Date.now() - t0}ms ${e.code} category=${e.category ?? e.compacted?.category} retryable=${e.retryable ?? e.compacted?.retryable} attempts=${e.cause?.errors?.length}`); continue; }
  console.log(`[${label}] ${Date.now() - t0}ms usage=${JSON.stringify(r.usage)} reasoningChars=${(r as any).reasoning?.length ?? 0} text=${JSON.stringify(r.text.slice(0, 100))}`);
}
