import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sendFetchResponse, toFetchRequest } from '../serve/fetchBridge';
import type { Request as ExpressRequest } from 'express';

describe('toFetchRequest', () => {
  it('builds an absolute URL from Host + originalUrl, preserving method, headers and raw body', async () => {
    let seen: Request | undefined;
    const app = express();
    app.use((req, _res, next) => {
      // Raw stream like the /serve mount sees it - before express.json().
      seen = toFetchRequest(req as ExpressRequest);
      next();
    });
    // Drain the bridged body inside the route: once the response ends the
    // request stream may already be gone, so read it before answering.
    app.post('/serve/ops/chat', async (_req, res) => {
      res.json({ echo: await seen!.text() });
    });

    const res = await request(app)
      .post('/serve/ops/chat?x=1')
      .set('host', '127.0.0.1:4750')
      .set('authorization', 'Bearer t0k')
      .set('content-type', 'application/json')
      .send('{"sessionId":"s1","input":"hi"}');

    expect(seen).toBeDefined();
    expect(seen!.url).toBe('http://127.0.0.1:4750/serve/ops/chat?x=1');
    expect(seen!.method).toBe('POST');
    expect(seen!.headers.get('authorization')).toBe('Bearer t0k');
    expect(res.body.echo).toBe('{"sessionId":"s1","input":"hi"}');
  });

  it('carries no body for GET', async () => {
    let seen: Request | undefined;
    const app = express();
    app.use((req, _res, next) => {
      seen = toFetchRequest(req as ExpressRequest);
      next();
    });
    app.get('/serve/ops/chat', (_req, res) => res.end('ok'));
    await request(app).get('/serve/ops/chat');
    expect(seen!.method).toBe('GET');
    expect(seen!.body).toBeNull();
  });
});

describe('sendFetchResponse', () => {
  function appReturning(response: Response) {
    const app = express();
    app.get('/x', async (_req, res) => {
      await sendFetchResponse(res, response);
    });
    return app;
  }

  it('writes status, headers and the streamed body; skips hop-by-hop headers', async () => {
    const response = new Response('hello', {
      status: 201,
      headers: {
        'content-type': 'text/plain',
        'x-custom': 'yes',
        // A hop-by-hop header Node won't auto-generate: the bridge must drop it.
        'proxy-authorization': 'Basic abc',
      },
    });
    const res = await request(appReturning(response)).get('/x');
    expect(res.status).toBe(201);
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.headers['proxy-authorization']).toBeUndefined();
    expect(res.text).toBe('hello');
  });

  it('ends cleanly for a null-body response', async () => {
    const res = await request(appReturning(new Response(null, { status: 204 }))).get('/x');
    expect(res.status).toBe(204);
  });

  it('streams an SSE body to completion', async () => {
    const sse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: token\ndata: {"t":"hi"}\n\n'));
          controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
    const res = await request(appReturning(sse)).get('/x');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: done');
  });
});
