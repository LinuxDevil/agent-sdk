/**
 * HTTP surface: the SDK's `createRouteHandler` (Fetch API) mounted on a plain
 * `node:http` server, the way a Hono/Bun/Next app would mount it.
 *
 *   PORT=4321 npx tsx support-desk/server.ts
 *
 * STAFF_GATE=1 adds the guard a real deployment needs: only the supervisor
 * principal may hit `/approvals/` routes (the SDK has no built-in option for it).
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createRouteHandler } from '@lousho/build-ai-agent';
import { buildDesk, supportAuth } from './agent.js';

const port = Number(process.env.PORT ?? 4321);
const { triage } = buildDesk();
const { handler } = createRouteHandler(triage, { basePath: '/api/support', auth: [supportAuth] });

async function gated(request: Request): Promise<Response> {
  if (process.env.STAFF_GATE === '1' && request.method === 'POST' && /\/approvals\//.test(new URL(request.url).pathname)) {
    const principal = await supportAuth(request);
    if (principal?.claims?.role !== 'supervisor') return new Response(JSON.stringify({ error: 'supervisors only' }), { status: 403 });
  }
  return handler(request);
}

createServer(async (req, res) => {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) for (const item of [v].flat()) if (item !== undefined) headers.append(k, item);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(new URL(req.url ?? '/', `http://localhost:${port}`), {
    method: req.method, headers, signal: abort.signal,
    ...(hasBody && { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }),
  } as RequestInit);
  try {
    const response = await gated(request);
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    const reader = response.body?.getReader();
    res.on('close', () => void reader?.cancel().catch(() => {}));
    for (let c = await reader?.read(); c && !c.done; c = await reader?.read()) res.write(c.value);
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
}).listen(port, () => console.log(`READY pid=${process.pid} port=${port}`));
