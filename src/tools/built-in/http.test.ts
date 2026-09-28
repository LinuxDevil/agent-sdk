import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
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

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
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
  });
});
