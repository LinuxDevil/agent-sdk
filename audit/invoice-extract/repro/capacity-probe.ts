// Polls LM Studio with a ~2.5k-token prompt until a completion fits in the shared context (other agents use the server).
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
const filler = 'Invoice line: copy paper 4 x 42.50 = 170.00. '.repeat(180);
for (let i = 0; i < Number(process.argv[2] ?? 10); i++) {
  const t0 = Date.now();
  const r = await fetch(`${LOCAL_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_MODEL, messages: [{ role: 'user', content: filler + '\nReply OK.' }], max_tokens: 1500 }) });
  const t = await r.text();
  let usage = ''; try { usage = JSON.stringify(JSON.parse(t).usage); } catch {}
  console.log(new Date().toISOString(), r.status, Date.now() - t0, 'ms', usage || t.slice(0, 120));
  if (r.status === 200) break;
  await new Promise((res) => setTimeout(res, 20000));
}
