/**
 * Tiny logging proxy in front of LM Studio, so repros can show the exact
 * wire requests the SDK sends. Start: `npx tsx invoice-extract/repro/proxy.ts`
 * (port 1239 -> localhost:1234). Logs to invoice-extract/out/proxy.log.
 * Also importable: startProxy() returns { url, close, log }.
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ProxyEntry { path: string; body: any; status?: number; responseText?: string }

export function startProxy(port = 1239, opts: { logFile?: string; keepResponses?: boolean } = {}) {
  const log: ProxyEntry[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = raw;
      try { body = JSON.parse(raw); } catch {}
      const entry: ProxyEntry = { path: req.url ?? '', body };
      log.push(entry);
      try {
        const upstream = await fetch('http://localhost:1234' + req.url, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json', authorization: 'Bearer lm-studio' },
          body: req.method === 'GET' ? undefined : raw,
        });
        const text = await upstream.text();
        entry.status = upstream.status;
        if (opts.keepResponses) entry.responseText = text;
        if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify({ path: entry.path, status: entry.status, body: summarize(body), response: text.slice(0, 600) }) + '\n');
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(text);
      } catch (e) {
        res.writeHead(502); res.end(String(e));
      }
    });
  });
  return new Promise<{ url: string; log: ProxyEntry[]; close: () => void }>((resolve) =>
    server.listen(port, () => resolve({ url: `http://localhost:${port}/v1`, log, close: () => server.close() })));
}

/** Request body without the long message contents. */
export function summarize(body: any) {
  if (typeof body !== 'object' || !body) return body;
  const { messages, input, tools, ...rest } = body;
  return {
    ...rest,
    messages: Array.isArray(messages) ? messages.map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 120) : m.content })) : undefined,
    input: Array.isArray(input) ? input.map((m: any) => ({ role: m.role, type: m.type, content: typeof m.content === 'string' ? m.content.slice(0, 120) : m.content })) : undefined,
    tools: Array.isArray(tools) ? tools.map((t: any) => t.function?.name ?? t.name) : undefined,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await startProxy(1239, { logFile: 'invoice-extract/out/proxy.log' });
  console.log('proxy on', p.url);
}
