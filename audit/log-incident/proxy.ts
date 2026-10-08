/**
 * A tiny fault-injecting proxy in front of LM Studio.
 *
 *   startProxy({ port, mode })  mode:
 *     'pass'        forward everything, log request sizes
 *     'fail500:N'   first N requests get HTTP 500, then pass
 *     'slow:MS'     delay response headers by MS (simulates a queued server)
 *     'hang'        never answer (until the client aborts)
 *     'badjson:N'   pass, but rewrite the first N final text answers to invalid JSON (non-stream only)
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface ProxyLog { n: number; path: string; bytes: number; items?: number; roles?: string; maxTokens?: unknown; status?: number; ms?: number; aborted?: boolean; note?: string }

export function startProxy(opts: { port: number; mode: string; upstream?: string; quiet?: boolean }) {
  const upstream = opts.upstream ?? 'http://localhost:1234';
  const log: ProxyLog[] = [];
  let n = 0;
  let mode = opts.mode;
  let base = 0; // request counter offset: modes count from the last setMode()
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const entry: ProxyLog = { n: ++n, path: req.url ?? '', bytes: body.length };
    const t0 = Date.now();
    let closed = false;
    res.on('close', () => { closed = true; if (!res.writableFinished) entry.aborted = true; });
    try {
      const j = JSON.parse(body.toString() || '{}');
      const items = j.input ?? j.messages;
      entry.items = Array.isArray(items) ? items.length : undefined;
      if (Array.isArray(items)) entry.roles = items.map((m: any) => (m.role ?? m.type ?? '?')[0]).join('');
      entry.maxTokens = j.max_output_tokens ?? j.max_tokens ?? j.max_completion_tokens;
    } catch {}
    log.push(entry);
    if (process.env.PROXY_DUMP) (await import('node:fs')).writeFileSync(`${process.env.PROXY_DUMP}-${entry.n}.json`, body);
    const [kind, arg] = mode.split(':');
    if (kind === 'fail500' && entry.n - base <= Number(arg)) {
      entry.status = 500; entry.note = 'injected 500';
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'injected upstream failure', type: 'server_error' } }));
      if (!opts.quiet) console.log('[proxy]', JSON.stringify(entry));
      return;
    }
    if (kind === 'sseerr' && entry.n - base <= Number(arg)) {
      // what LM Studio does under KV pressure: HTTP 200, a few events, then an error event
      entry.status = 200; entry.note = 'injected mid-stream error';
      const id = 'resp_injected' + entry.n;
      const ev = (o: Record<string, unknown>) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev({ type: 'response.created', sequence_number: 0, response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: 'qwen3.5-9b-uncensored-hauhaucs-aggressive', output: [] } }));
      res.write(ev({ type: 'response.output_item.added', output_index: 0, sequence_number: 1, item: { id: 'rs_x', type: 'reasoning', status: 'in_progress', summary: [], content: [] } }));
      res.write(ev({ type: 'response.reasoning_text.delta', item_id: 'rs_x', output_index: 0, content_index: 0, delta: 'Thinking', sequence_number: 2 }));
      res.end(ev({ type: 'error', sequence_number: 3, error: { type: 'internal_error', code: 'unknown', message: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}', param: null } }));
      if (!opts.quiet) console.log('[proxy]', JSON.stringify(entry));
      return;
    }
    if (kind === 'hang') { entry.note = 'hang'; if (!opts.quiet) console.log('[proxy]', JSON.stringify(entry)); return; }
    if (kind === 'slow') await new Promise((r) => setTimeout(r, Number(arg)));
    if (closed) { entry.note = 'client gone before upstream'; if (!opts.quiet) console.log('[proxy]', JSON.stringify(entry)); return; }
    try {
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const up = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: 'Bearer lm-studio' }, body: req.method === 'GET' ? undefined : body, signal: ac.signal });
      entry.status = up.status;
      const headers: Record<string, string> = {};
      up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) headers[k] = v; });
      res.writeHead(up.status, headers);
      if (up.body) for await (const c of up.body as any) { if (closed) break; res.write(c); }
      res.end();
    } catch (e) {
      entry.note = `upstream error: ${(e as Error).message}`;
      if (!res.headersSent) res.writeHead(502).end(); else res.end();
    }
    entry.ms = Date.now() - t0;
    if (!opts.quiet) console.log('[proxy]', JSON.stringify(entry));
  });
  return new Promise<{ log: ProxyLog[]; setMode: (m: string) => void; close: () => Promise<void>; url: string }>((resolve) =>
    server.listen(opts.port, () =>
      resolve({ log, setMode: (m) => { mode = m; base = n; }, url: `http://localhost:${opts.port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) })
    )
  );
}
