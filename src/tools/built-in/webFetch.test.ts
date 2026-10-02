import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import { createWebFetchTool, webFetchTool, type WebFetchResult, type WebFetchToolOptions } from './webFetch';
import { htmlToText, decodeEntities } from './htmlToText';
import type { ToolExecutionContext } from '../../types';

const PAGE = `<!doctype html>
<html><head><title>Test &amp; Page</title><style>body { color: red }</style>
<script>window.secret = "do not show";</script></head>
<body>
<h1>Hello&nbsp;World</h1>
<p>Fish &amp; chips &lt;3 &#169; &#x2014; done.</p>
<p>See <a href="/docs?a=1&amp;b=2">the docs</a> and <a href="https://example.org/">https://example.org/</a>.</p>
<noscript>enable JS</noscript><template><p>hidden template</p></template><svg><text>svg text</text></svg>
<ul><li>one</li><li>two</li></ul>
line<br>break
</body></html>`;

let server: http.Server;
let port = 0;
let hits = 0;

/** Routes of the local test server. */
function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  hits++;
  const url = new URL(req.url ?? '/', 'http://localhost');
  switch (url.pathname) {
    case '/page':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      return;
    case '/json':
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"items":[1,2]}');
      return;
    case '/big':
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(10_000));
      return;
    case '/missing':
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not here</h1>');
      return;
    case '/latin1':
      res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      return;
    case '/image':
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    case '/redirect': {
      // /redirect?n=K redirects K more times, then lands on /json.
      const n = Number(url.searchParams.get('n') ?? '0');
      res.writeHead(302, { location: n > 1 ? `/redirect?n=${n - 1}` : '/json' }).end();
      return;
    }
    case '/to-ftp':
      res.writeHead(301, { location: 'ftp://example.com/file' }).end();
      return;
    case '/to-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      return;
    case '/hang':
      return; // never answers
    default:
      res.writeHead(200, { 'content-type': 'text/plain' }).end('internal');
  }
}

/** The unstubbed resolver (the spies below replace the properties it was read from). */
const realLookup = dns.promises.lookup.bind(dns.promises);

/** Stubs the resolver: `localhost` is 127.0.0.1 (where the server listens), anything in `extra` as given. */
function stubResolver(extra: Record<string, () => string> = {}) {
  return vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string, options?: dns.LookupOptions) => {
    const address = hostname === 'localhost' ? '127.0.0.1' : extra[hostname]?.();
    if (!address) return realLookup(hostname, options ?? {});
    const entry = { address, family: address.includes(':') ? 6 : 4 };
    return options?.all ? [entry] : entry;
  }) as unknown as typeof dns.promises.lookup);
}

const LOCAL: WebFetchToolOptions = { allowPrivate: ['localhost'] };

async function fetchWith(options: WebFetchToolOptions, url: string, ctx: Partial<ToolExecutionContext> = {}): Promise<WebFetchResult> {
  return createWebFetchTool(options).execute({ url }, ctx as ToolExecutionContext) as Promise<WebFetchResult>;
}

beforeAll(async () => {
  server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web_fetch tool', () => {
  it('is a read-only, open-world tool named web_fetch that warns the content is untrusted', () => {
    expect(webFetchTool.name).toBe('web_fetch');
    expect(webFetchTool.description).toMatch(/untrusted/);
    expect(webFetchTool.metadata?.mcp?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(webFetchTool.needsApproval).toBeFalsy();
  });

  it('converts HTML to text: scripts and styles removed, entities decoded, links kept', async () => {
    stubResolver();
    const result = await fetchWith(LOCAL, `http://localhost:${port}/page`);
    expect(result).toMatchObject({ status: 200, finalUrl: `http://localhost:${port}/page`, truncated: false });
    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.content).toContain('Test & Page');
    expect(result.content).toContain('# Hello World');
    expect(result.content).toContain('Fish & chips <3 © — done.');
    expect(result.content).toContain(`the docs (http://localhost:${port}/docs?a=1&b=2)`);
    expect(result.content).toContain('- one\n- two');
    expect(result.content).toContain('line\nbreak');
    for (const hidden of ['window.secret', 'color: red', 'enable JS', 'hidden template', 'svg text', '<p>', 'https://example.org/ (']) {
      expect(result.content).not.toContain(hidden);
    }
  });

  it('passes JSON through', async () => {
    stubResolver();
    const result = await fetchWith(LOCAL, `http://localhost:${port}/json`);
    expect(result.content).toBe('{"ok":true,"items":[1,2]}');
    expect(result.contentType).toBe('application/json');
  });

  it('stops reading at maxBytes and sets truncated', async () => {
    stubResolver();
    const result = await fetchWith({ ...LOCAL, maxBytes: 1000 }, `http://localhost:${port}/big`);
    expect(result.content).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('cuts the text at maxChars and sets truncated', async () => {
    stubResolver();
    const result = await fetchWith({ ...LOCAL, maxChars: 25 }, `http://localhost:${port}/big`);
    expect(result.content).toBe('x'.repeat(25));
    expect(result.truncated).toBe(true);
  });

  it('returns a 404 with its body instead of failing', async () => {
    stubResolver();
    const result = await fetchWith(LOCAL, `http://localhost:${port}/missing`);
    expect(result.status).toBe(404);
    expect(result.content).toBe('# Not here');
  });

  it('decodes the response charset', async () => {
    stubResolver();
    expect((await fetchWith(LOCAL, `http://localhost:${port}/latin1`)).content).toBe('café');
  });

  it('does not return unsupported content types', async () => {
    stubResolver();
    const result = await fetchWith(LOCAL, `http://localhost:${port}/image`);
    expect(result.content).toMatch(/content type image\/png is not supported/);
    expect(result.contentType).toBe('image/png');
  });

  it('follows 10 redirects by default and fails on the 11th', async () => {
    stubResolver();
    const ok = await fetchWith(LOCAL, `http://localhost:${port}/redirect?n=10`);
    expect(ok.finalUrl).toBe(`http://localhost:${port}/json`);
    await expect(fetchWith(LOCAL, `http://localhost:${port}/redirect?n=11`)).rejects.toThrow(/too many redirects \(more than 10\)/);
    await expect(fetchWith({ ...LOCAL, maxRedirects: 0 }, `http://localhost:${port}/redirect?n=1`)).rejects.toThrow(/too many redirects/);
  });

  it('refuses a redirect to a non-http protocol', async () => {
    stubResolver();
    await expect(fetchWith(LOCAL, `http://localhost:${port}/to-ftp`)).rejects.toThrow(/only http: and https: .*redirect pointed to ftp:/);
  });

  it('re-checks every redirect hop (a redirect to the metadata address is refused before connecting)', async () => {
    stubResolver();
    await expect(fetchWith(LOCAL, `http://localhost:${port}/to-metadata`)).rejects.toThrow(/refused 169\.254\.169\.254/);
  });

  it('applies allowedHosts and blockedHosts before DNS', async () => {
    const spy = stubResolver();
    await expect(fetchWith({ ...LOCAL, allowedHosts: ['docs.example.com'] }, `http://localhost:${port}/json`)).rejects.toThrow(
      /localhost is not on the allowed host list/
    );
    await expect(fetchWith({ ...LOCAL, blockedHosts: ['*.example.com'] }, 'http://evil.example.com/')).rejects.toThrow(
      /evil\.example\.com is on the blocked host list/
    );
    expect(spy).not.toHaveBeenCalled();
    const allowed = await fetchWith({ ...LOCAL, allowedHosts: ['localhost'] }, `http://localhost:${port}/json`);
    expect(allowed.status).toBe(200);
  });

  it('refuses the local server by default and allows it with allowPrivate', async () => {
    stubResolver();
    const before = hits;
    await expect(fetchWith({}, `http://localhost:${port}/json`)).rejects.toThrow(/refused localhost: it is or resolves to a loopback/);
    await expect(fetchWith({}, `http://127.0.0.1:${port}/json`)).rejects.toThrow(/refused 127\.0\.0\.1/);
    await expect(fetchWith({}, `http://[::1]:${port}/json`)).rejects.toThrow(/refused ::1/);
    expect(hits).toBe(before);
    expect((await fetchWith(LOCAL, `http://localhost:${port}/json`)).status).toBe(200);
  });

  it('DNS rebinding: a name that answers public first and 127.0.0.1 second never reaches the local server', async () => {
    // Both resolver entry points share one answer sequence, so an
    // implementation that resolves once to check and again to connect would
    // check 203.0.113.10 and connect to 127.0.0.1.
    let answers = 0;
    const next = () => (answers++ === 0 ? '203.0.113.10' : '127.0.0.1');
    stubResolver({ 'rebind.test': next });
    const actualLookup = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback?: unknown) => {
      const cb = (typeof options === 'function' ? options : callback) as (e: Error | null, a: unknown, f?: number) => void;
      if (hostname !== 'rebind.test') return (actualLookup as (...a: unknown[]) => void)(hostname, options, callback);
      const address = next();
      if ((options as dns.LookupOptions | undefined)?.all) cb(null, [{ address, family: 4 }]);
      else cb(null, address, 4);
    }) as unknown as typeof dns.lookup);
    const before = hits;
    await expect(fetchWith({ timeoutMs: 1500 }, `http://rebind.test:${port}/`)).rejects.toThrow(/web_fetch/);
    expect(hits).toBe(before);
    expect(answers).toBe(1);
  });

  it('times out', async () => {
    stubResolver();
    const start = Date.now();
    await expect(fetchWith({ ...LOCAL, timeoutMs: 300 }, `http://localhost:${port}/hang`)).rejects.toThrow(/timed out after 300ms fetching localhost/);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('reports a cancelled run as an AbortError', async () => {
    stubResolver();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(fetchWith(LOCAL, `http://localhost:${port}/hang`, { abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses non-http URLs, URLs with credentials and invalid URLs', async () => {
    await expect(fetchWith({}, 'file:///etc/passwd')).rejects.toThrow(/only http: and https:/);
    await expect(fetchWith({}, 'ftp://example.com/')).rejects.toThrow(/only http: and https:/);
    await expect(fetchWith({}, 'https://user:pass@example.com/')).rejects.toThrow(/credentials/);
    await expect(fetchWith({}, 'not a url')).rejects.toThrow(/not a valid URL/);
  });

  it('validates its options', () => {
    expect(() => createWebFetchTool({ allowedHosts: ['not a host'] })).toThrow(/allowedHosts/);
    expect(() => createWebFetchTool({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => createWebFetchTool({ maxRedirects: -1 })).toThrow(/maxRedirects/);
  });

  it('uses a supplied transport instead of the network, with the host checks still applied', async () => {
    const transport = vi.fn(async () => new Response('<p>from transport</p>', { headers: { 'content-type': 'text/html' } }));
    const result = await fetchWith({ transport, userAgent: 'test-agent' }, 'https://example.com/');
    expect(result.content).toBe('from transport');
    expect(transport).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({ method: 'GET', redirect: 'manual', headers: expect.objectContaining({ 'user-agent': 'test-agent' }) }));
    await expect(fetchWith({ transport }, 'http://10.0.0.1/')).rejects.toThrow(/refused 10\.0\.0\.1/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('htmlToText', () => {
  it('handles unclosed skipped elements, stray < and comments', () => {
    expect(htmlToText('a < b <!-- hidden --> c<script>never closed')).toBe('a < b c');
    expect(htmlToText('<p title="x > y">quoted</p>')).toBe('quoted');
    expect(htmlToText('<head><meta charset="utf-8"><p>no closing head')).toBe('no closing head');
  });

  it('drops javascript: links and keeps text', () => {
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  it('decodes numeric entities safely', () => {
    expect(decodeEntities('&#0;&#xD800;&#x1F600;&unknown;')).toBe('��\u{1F600}&unknown;');
  });
});
