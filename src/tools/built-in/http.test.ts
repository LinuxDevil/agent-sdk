import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { ToolExecutionOptions } from 'ai';
import http from 'http';
import https from 'https';
import dns from 'dns';
import selfsigned from 'selfsigned';
import type { AddressInfo } from 'net';
import { makeHttpRequest, createHttpTool } from './http';
import { NoopSandbox } from '../../security/sandboxCore';
import type { SandboxAdapter } from '../../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../../execution/sandboxGuard';

/** Lets the local test servers on 'localhost' through the SSRF check. */
const LOCAL = { allowPrivate: ['localhost'] } as const;

/** The unstubbed resolver (the spy below replaces the property it was read from). */
const realLookup = dns.promises.lookup.bind(dns.promises) as (hostname: string, options: dns.LookupOptions) => Promise<unknown>;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://localhost:${port}`);
    });
  });
}

function listenHttps(server: https.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`https://localhost:${port}`);
    });
  });
}

describe('makeHttpRequest', () => {
  let server: http.Server | undefined;
  let dnsLookupSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // The behavioral tests below (timeout / redirects / TLS) spin up a real
    // HTTP server bound to 'localhost' purely as test infrastructure - they
    // are not exercising SSRF behavior. 'localhost' resolves to a loopback
    // address the SSRF check refuses, and since N13a the connection goes to
    // exactly the address the check saw, so those tests opt in with
    // `allowPrivate: ['localhost']` (LOCAL). The resolver is spied on (and
    // passes through) so the SSRF tests can stub it.
    // Implemented through the plain MockInstance: lookup() is overloaded (one
    // address, or all of them with `all: true`), which one signature can't type.
    dnsLookupSpy = vi.spyOn(dns.promises, 'lookup');
    dnsLookupSpy?.mockImplementation(async (...args: unknown[]) => {
      const [hostname, opts] = args as [string, dns.LookupOptions | undefined];
      return realLookup(hostname, opts as dns.LookupOptions);
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    dnsLookupSpy?.mockRestore();
  });

  it('rejects near the configured timeout when the server never responds', async () => {
    // #324: this used to compare a real elapsed time against the real 500 ms
    // timeout (>= 450 and < 2000), which failed whenever a loaded machine
    // delayed the event loop. The request timer is now driven by a fake clock
    // (only setTimeout/clearTimeout are faked; the sockets stay real), so the
    // test pins the exact boundary: still pending 1 ms before the timeout,
    // aborted at the timeout, with the documented error.
    let serverSawRequest!: () => void;
    const requestArrived = new Promise<void>((resolve) => (serverSawRequest = resolve));
    let clientHungUp!: () => void;
    const connectionClosed = new Promise<void>((resolve) => (clientHungUp = resolve));
    server = http.createServer((req) => {
      // Never respond
      req.socket.once('close', clientHungUp);
      serverSawRequest();
    });
    const baseUrl = await listen(server);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const request = makeHttpRequest({
        url: baseUrl,
        method: 'GET',
        options: { timeout: 500, ...LOCAL },
      });
      const outcome = request.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );

      // The request is in flight (the server has it) and the 500 ms timer is armed.
      await requestArrived;

      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out after 500ms/i);

      // The abort tore the connection down rather than leaving it dangling.
      await connectionClosed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('LOU-V1: the tool passes its abortSignal to fetch and rejects with an AbortError', async () => {
    server = http.createServer(() => {
      // Never respond
    });
    const baseUrl = await listen(server);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    await expect(
      createHttpTool({ timeout: 10_000, ...LOCAL }).tool.execute!(
        { url: baseUrl, method: 'GET' },
        { toolCallId: 't', messages: [], abortSignal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError', message: 'HTTP request was aborted' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('throws when a redirect chain exceeds maxRedirects', async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hop = Number(url.searchParams.get('hop') ?? '0');
      // Always redirect one hop further, forever.
      res.writeHead(302, { Location: `/?hop=${hop + 1}` });
      res.end();
    });
    const baseUrl = await listen(server);

    await expect(
      makeHttpRequest({
        url: `${baseUrl}/?hop=0`,
        method: 'GET',
        options: { maxRedirects: 2, ...LOCAL },
      })
    ).rejects.toThrow(/maxRedirects/);
  });

  it('follows redirects up to the cap and succeeds', async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hop = Number(url.searchParams.get('hop') ?? '0');
      if (hop < 2) {
        res.writeHead(302, { Location: `/?hop=${hop + 1}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('done');
    });
    const baseUrl = await listen(server);

    const result = await makeHttpRequest({
      url: `${baseUrl}/?hop=0`,
      method: 'GET',
      options: { maxRedirects: 5, ...LOCAL },
    });

    expect(result).toBe('done');
  });

  describe('SSRF denylist', () => {
    it('rejects a request to the cloud metadata endpoint with no network call', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://169.254.169.254/latest/meta-data',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('rejects an RFC1918 private-range address by default (no opt-in flag)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://192.168.1.1/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('rejects a domain name that DNS-resolves to a blocked IP (DNS rebinding)', async () => {
      dnsLookupSpy?.mockImplementation(async (...args: unknown[]) => {
        const [hostname, opts] = args as [string, dns.LookupOptions | undefined];
        if (hostname === 'evil.example.com') {
          const entry = { address: '127.0.0.1', family: 4 };
          return opts && opts.all ? [entry] : entry;
        }
        throw new Error(`unexpected lookup for ${hostname}`);
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://evil.example.com/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('N13a: connects to the address it checked, so a rebinding name cannot reach a private address', async () => {
      // A rebinding DNS server: the first answer for the name is public, every
      // later one is loopback. Both resolver entry points are stubbed (the
      // promise API and the callback API sockets use by default), sharing one
      // answer sequence, so a check-then-resolve-again implementation gets
      // the public address for its check and 127.0.0.1 for its connection.
      let hits = 0;
      server = http.createServer((_req, res) => {
        hits++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('internal');
      });
      const port = await new Promise<number>((resolve) => {
        server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
      });
      let answers = 0;
      const next = () => (answers++ === 0 ? { address: '203.0.113.10', family: 4 } : { address: '127.0.0.1', family: 4 });
      dnsLookupSpy?.mockImplementation(async (...args: unknown[]) => {
        const [hostname, opts] = args as [string, dns.LookupOptions | undefined];
        if (hostname !== 'rebind.test') throw new Error(`unexpected lookup for ${hostname}`);
        const entry = next();
        return opts && opts.all ? [entry] : entry;
      });
      const actualLookup = dns.lookup;
      const callbackSpy = vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback?: unknown) => {
        const cb = (typeof options === 'function' ? options : callback) as (e: Error | null, a: unknown, f?: number) => void;
        const opts = (typeof options === 'object' && options !== null ? options : {}) as dns.LookupOptions;
        if (hostname !== 'rebind.test') return (actualLookup as (...a: unknown[]) => void)(hostname, options, callback);
        const entry = next();
        if (opts.all) cb(null, [entry]);
        else cb(null, entry.address, entry.family);
      }) as unknown as typeof dns.lookup);
      try {
        await expect(
          makeHttpRequest({ url: `http://rebind.test:${port}/`, method: 'GET', options: { timeout: 1500 } })
        ).rejects.toThrow();
        expect(hits).toBe(0);
        // One resolution: the one the pinned lookup checked and connected to.
        expect(answers).toBe(1);
      } finally {
        callbackSpy.mockRestore();
      }
    });

    it('rejects a bracketed IPv6 loopback literal ([::1])', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://[::1]/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('rejects a bracketed, mixed-case IPv6 link-local literal ([FE80::1])', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://[FE80::1]/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('rejects an IPv4-mapped-IPv6 literal pointing at a blocked range', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://[::ffff:127.0.0.1]/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("Node's URL parser normalizes decimal/octal/hex IPv4 hostnames to dotted-decimal", () => {
      // Documents the behavior relied on by isBlockedHost: no bespoke
      // decimal/octal/hex parsing is needed because `new URL(...)` already
      // normalizes these encodings before `.hostname` is read.
      expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1');
      expect(new URL('http://017700000001/').hostname).toBe('127.0.0.1');
      expect(new URL('http://0x7f000001/').hostname).toBe('127.0.0.1');
    });

    it('rejects a decimal-encoded loopback IPv4 hostname', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(
        makeHttpRequest({
          url: 'http://2130706433/',
          method: 'GET',
        })
      ).rejects.toThrow(/blocked host/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('validateSSL (per-request TLS dispatcher)', () => {
    let cert: string;
    let key: string;
    let httpsServer: https.Server | undefined;

    beforeAll(async () => {
      const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'localhost' }],
        { days: 1, keySize: 2048 }
      );
      cert = pems.cert;
      key = pems.private;
    });

    afterEach(async () => {
      if (httpsServer) {
        await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
        httpsServer = undefined;
      }
    });

    it('loads undici on the first request, not at import time (LOU-D19; N13a pins every request through it)', async () => {
      vi.resetModules();
      vi.doMock('undici', () => {
        throw new Error('undici is loaded lazily');
      });
      try {
        const { makeHttpRequest: fresh } = await import('./http');
        await expect(fresh({ url: 'http://203.0.113.10/', method: 'GET' })).rejects.toThrow(/mocking a module|undici is loaded lazily/);
      } finally {
        vi.doUnmock('undici');
        vi.resetModules();
      }
    });

    it('rejects a self-signed certificate by default (validateSSL unset)', async () => {
      httpsServer = https.createServer({ cert, key }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure');
      });
      const baseUrl = await listenHttps(httpsServer);

      await expect(
        makeHttpRequest({ url: baseUrl, method: 'GET', options: LOCAL })
      ).rejects.toThrow(/certificate|fetch failed/i);
    });

    it('accepts a self-signed certificate when validateSSL is false', async () => {
      httpsServer = https.createServer({ cert, key }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure');
      });
      const baseUrl = await listenHttps(httpsServer);

      const result = await makeHttpRequest({
        url: baseUrl,
        method: 'GET',
        options: { validateSSL: false, ...LOCAL },
      });

      expect(result).toBe('secure');
    });

    it('does not leak validateSSL between two concurrent requests with different settings', async () => {
      httpsServer = https.createServer({ cert, key }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure');
      });
      const baseUrl = await listenHttps(httpsServer);

      const [insecureResult, secureResult] = await Promise.all([
        makeHttpRequest({
          url: baseUrl,
          method: 'GET',
          options: { validateSSL: false, ...LOCAL },
        }),
        makeHttpRequest({
          url: baseUrl,
          method: 'GET',
          options: { validateSSL: true, ...LOCAL },
        }).then(
          () => 'unexpectedly-resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        ),
      ]);

      expect(insecureResult).toBe('secure');
      expect(secureResult).not.toBe('unexpectedly-resolved');
    });
  });

  describe('sandbox seam (LOU-K2)', () => {
    it('flags requiresSandbox and implements sandboxExecute', () => {
      const descriptor = createHttpTool();
      expect(descriptor.requiresSandbox).toBe(true);
      expect(typeof descriptor.sandboxExecute).toBe('function');
    });

    it('(a) NoopSandbox: sandboxExecute() gets the exact same real response as the unsandboxed execute() path', async () => {
      const localServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('sandboxed-ok');
      });
      const baseUrl = await listen(localServer);
      try {
        const descriptor = createHttpTool(LOCAL);

        const direct = await descriptor.tool.execute!({ url: baseUrl, method: 'GET' }, {} as ToolExecutionOptions);
        const viaGuard = await executeToolWithSandboxGuard('http', descriptor, { url: baseUrl, method: 'GET' }, NoopSandbox);

        expect(direct).toBe('sandboxed-ok');
        expect(viaGuard).toBe('sandboxed-ok');
      } finally {
        await new Promise<void>((resolve) => localServer.close(() => resolve()));
      }
    }, 15000);

    it('(b) a custom SandboxAdapter actually gets invoked for the outbound request', async () => {
      const runSpy = vi.fn(async (cmd: string, args: string[]) => {
        expect(cmd).toBe('node');
        expect(args[0]).toBe('-e');
        return {
          stdout: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: 'from-custom-sandbox' }),
          stderr: '',
          exitCode: 0,
        };
      });
      const customSandbox: SandboxAdapter = {
        name: 'custom-test-sandbox',
        run: runSpy,
        writeFile: vi.fn(),
      };

      const descriptor = createHttpTool();
      // TEST-NET-3 (RFC 5737, 203.0.113.0/24): a real, non-blocked-range IP
      // literal that skips isBlockedHost()'s DNS-resolution path entirely
      // (isIP() short-circuits it) - so this test never touches real DNS.
      const result = await executeToolWithSandboxGuard(
        'http',
        descriptor,
        { url: 'https://203.0.113.10/', method: 'GET' },
        customSandbox
      );

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(result).toBe('from-custom-sandbox');
    });

    it('N13a: the sandboxed process connects to the address checked here, not its own resolution', async () => {
      // 'pinned-target.invalid' cannot resolve anywhere (RFC 6761), so the
      // request only reaches the local server if the child process uses the
      // address this process resolved (stubbed to 127.0.0.1) and checked.
      const localServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`pinned host=${req.headers.host}`);
      });
      const port = await new Promise<number>((resolve) => {
        localServer.listen(0, '127.0.0.1', () => resolve((localServer.address() as AddressInfo).port));
      });
      dnsLookupSpy?.mockImplementation(async (...args: unknown[]) => {
        const [hostname, opts] = args as [string, dns.LookupOptions | undefined];
        if (hostname !== 'pinned-target.invalid') throw new Error(`unexpected lookup for ${hostname}`);
        const entry = { address: '127.0.0.1', family: 4 };
        return opts && opts.all ? [entry] : entry;
      });
      try {
        const url = `http://pinned-target.invalid:${port}/`;
        await expect(
          executeToolWithSandboxGuard('http', createHttpTool(), { url, method: 'GET' }, NoopSandbox)
        ).rejects.toThrow(/blocked host pinned-target\.invalid/);
        const result = await executeToolWithSandboxGuard(
          'http',
          createHttpTool({ allowPrivate: ['pinned-target.invalid'] }),
          { url, method: 'GET' },
          NoopSandbox
        );
        expect(result).toBe(`pinned host=pinned-target.invalid:${port}`);
      } finally {
        await new Promise<void>((resolve) => localServer.close(() => resolve()));
      }
    }, 15000);

    it('N13a: hands the sandbox the checked address and refuses a private one without running it', async () => {
      const runSpy = vi.fn(async (_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
        const request = JSON.parse(Buffer.from(opts!.env!.SANDBOX_FETCH_REQUEST, 'base64').toString('utf-8'));
        return { stdout: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: `via ${request.pinnedAddress}` }), stderr: '', exitCode: 0 };
      });
      const customSandbox: SandboxAdapter = { name: 'recording-sandbox', run: runSpy, writeFile: vi.fn() };
      dnsLookupSpy?.mockImplementation(async (...args: unknown[]) => {
        const [hostname] = args as [string];
        if (hostname === 'public.test') return [{ address: '203.0.113.10', family: 4 }];
        if (hostname === 'internal.test') return [{ address: '10.0.0.7', family: 4 }];
        throw new Error(`unexpected lookup for ${hostname}`);
      });

      const descriptor = createHttpTool();
      expect(await executeToolWithSandboxGuard('http', descriptor, { url: 'http://public.test/', method: 'GET' }, customSandbox)).toBe('via 203.0.113.10');
      await expect(
        executeToolWithSandboxGuard('http', descriptor, { url: 'http://internal.test/', method: 'GET' }, customSandbox)
      ).rejects.toThrow(/blocked host internal\.test/);
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('(c) fails closed when requiresSandbox is true but sandboxExecute is missing', async () => {
      const descriptor = createHttpTool();
      const broken = { ...descriptor, sandboxExecute: undefined };

      await expect(
        executeToolWithSandboxGuard('http', broken, { url: 'https://203.0.113.10/', method: 'GET' }, NoopSandbox)
      ).rejects.toThrow(/requiresSandbox but does not implement sandboxExecute/);
    });
  });
});
