// What prompt size fits right now? Binary-ish scan over prompt sizes with a tiny answer.
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../../_shared/local.js';
for (const n of (process.argv[2] ?? '10,40,80,120').split(',').map(Number)) {
  const t0 = Date.now();
  const r = await fetch(`${LOCAL_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_MODEL, messages: [{ role: 'user', content: 'Invoice line: copy paper 4 x 42.50 = 170.00. '.repeat(n) + '\nReply with just OK, no thinking.' }], max_tokens: 400 }) });
  const t = await r.text();
  let usage = ''; try { usage = JSON.stringify(JSON.parse(t).usage); } catch {}
  console.log(n, r.status, Date.now() - t0, 'ms', usage || t.slice(0, 100));
}
