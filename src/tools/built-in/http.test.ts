import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'http';
import dns from 'dns';
import type { AddressInfo } from 'net';
import { makeHttpRequest } from './http';

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://localhost:${port}`);
    });
  });
}

describe('makeHttpRequest', () => {
  let server: http.Server | undefined;
  let dnsLookupSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // The behavioral tests below (timeout / redirects) spin up a real HTTP
    // server bound to 'localhost' purely as test infrastructure - they are
    // not exercising SSRF behavior. Since the hardened SSRF check now
    // resolves domain names via DNS before connecting (to close the
    // DNS-rebinding gap), and 'localhost' genuinely resolves to a loopback
    // address that the denylist correctly blocks, we stub dns.lookup for
    // this hostname to return a non-blocked address for the purposes of the
    // SSRF pre-check only. The actual fetch() call still connects to the
    // real local server via Node's own (unmocked) DNS resolution.
    dnsLookupSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname: any, opts?: any) => {
      if (hostname === 'localhost') {
        const entry = { address: '203.0.113.10', family: 4 };
        return (opts && opts.all ? [entry] : entry) as any;
      }
      return vi.importActual<typeof dns>('dns').then((actual) =>
        actual.promises.lookup(hostname, opts)
      ) as any;
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
    server = http.createServer(() => {
      // Never respond
    });
    const baseUrl = await listen(server);

    const start = Date.now();
    await expect(
      makeHttpRequest({
        url: baseUrl,
        method: 'GET',
        options: { timeout: 500 },
      })
    ).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
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
        options: { maxRedirects: 2 },
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
      options: { maxRedirects: 5 },
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
      dnsLookupSpy?.mockImplementation(async (hostname: any, opts?: any) => {
        if (hostname === 'evil.example.com') {
          const entry = { address: '127.0.0.1', family: 4 };
          return (opts && opts.all ? [entry] : entry) as any;
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
});
