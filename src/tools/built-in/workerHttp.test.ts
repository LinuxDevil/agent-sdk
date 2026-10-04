/**
 * M3a: the Cloudflare Worker `http_request` tool. No network: every request
 * goes to an injected `fetch`, which records the URLs it was asked for.
 */
import { describe, it, expect } from 'vitest';
import { isIP } from 'node:net';
import { createWorkerHttpTool, parseHostAllowList, WorkerHttpToolOptions } from './workerHttp';
import { createHttpTool } from './http';
import { ipFamily } from './httpCore';
import { getToolExecute } from '../toolContract';
import { NamedToolDescriptor, ToolExecutionContext } from '../../types';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers from `route` and records each URL it was called with. */
function fakeFetch(route: Route = () => new Response('ok', { status: 200 })) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return route(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

function run(options: WorkerHttpToolOptions, args: Record<string, unknown>, ctx: Partial<ToolExecutionContext> = {}): Promise<unknown> {
  const execute = getToolExecute(createWorkerHttpTool(options));
  if (!execute) throw new Error('no execute');
  return Promise.resolve(execute({ method: 'GET', ...args }, ctx as ToolExecutionContext));
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe('createWorkerHttpTool', () => {
  it('has the Node tool\'s name and input schema, and needs no sandbox', () => {
    // defineTool() sets `name`; the factories' declared return type is ToolDescriptor, which doesn't carry it.
    const worker = createWorkerHttpTool({ allow: [] }) as NamedToolDescriptor;
    const node = createHttpTool() as NamedToolDescriptor;
    expect(worker.name).toBe('http_request');
    expect(worker.name).toBe(node.name);
    expect(worker.inputSchema).toBe(node.inputSchema);
    expect(worker.requiresSandbox).toBeFalsy();
  });

  it('requests an allowed host and returns the body', async () => {
    const { impl, calls } = fakeFetch(() => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(run({ allow: ['api.example.com'], fetch: impl }, { url: 'https://api.example.com/x' })).resolves.toBe('{"a":1}');
    expect(calls).toEqual(['https://api.example.com/x']);
  });

  it('matches hosts case-insensitively and ignores the port', async () => {
    const { impl, calls } = fakeFetch();
    await expect(run({ allow: ['API.Example.com'], fetch: impl }, { url: 'https://api.EXAMPLE.com:8443/x' })).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('refuses an unlisted host without calling fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(run({ allow: ['api.example.com'], fetch: impl }, { url: 'https://evil.example.net/' })).rejects.toThrow(
      /host evil\.example\.net is not in the allowlist \(LOUSHO_HTTP_ALLOW\)/
    );
    expect(calls).toEqual([]);
  });

  it('a wildcard matches subdomains only, not the bare domain or a look-alike', async () => {
    const { impl, calls } = fakeFetch();
    const options = { allow: ['*.example.com'], fetch: impl };
    await expect(run(options, { url: 'https://a.example.com/' })).resolves.toBe('ok');
    await expect(run(options, { url: 'https://a.b.example.com/' })).resolves.toBe('ok');
    await expect(run(options, { url: 'https://example.com/' })).rejects.toThrow(/not in the allowlist/);
    await expect(run(options, { url: 'https://evilexample.com/' })).rejects.toThrow(/not in the allowlist/);
    await expect(run(options, { url: 'https://a.example.com.evil.net/' })).rejects.toThrow(/not in the allowlist/);
    expect(calls).toEqual(['https://a.example.com/', 'https://a.b.example.com/']);
  });

  it('refuses literal IPv4 hosts even when listed, including encodings URL normalizes', async () => {
    const { impl, calls } = fakeFetch();
    const options = { allow: ['127.0.0.1', '8.8.8.8', 'api.example.com'], fetch: impl };
    for (const url of ['http://127.0.0.1/', 'http://8.8.8.8/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/']) {
      await expect(run(options, { url })).rejects.toThrow(/is an IP address/);
    }
    expect(calls).toEqual([]);
  });

  it('refuses literal IPv6 hosts', async () => {
    const { impl, calls } = fakeFetch();
    const options = { allow: ['api.example.com'], fetch: impl };
    for (const url of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[2606:4700:4700::1111]/']) {
      await expect(run(options, { url })).rejects.toThrow(/is an IP address/);
    }
    expect(calls).toEqual([]);
  });

  it('refuses every request when the allowlist is empty (fail closed)', async () => {
    const { impl, calls } = fakeFetch();
    await expect(run({ allow: [], fetch: impl }, { url: 'https://api.example.com/' })).rejects.toThrow(
      /no hosts are allowed; list them in the LOUSHO_HTTP_ALLOW binding/
    );
    expect(calls).toEqual([]);
  });

  it('fails every request when an allowlist entry is not a host pattern, naming it', async () => {
    const { impl, calls } = fakeFetch();
    await expect(run({ allow: ['api.example.com', 'http://x.com', '*'], fetch: impl }, { url: 'https://api.example.com/' })).rejects.toThrow(
      /invalid host pattern 'http:\/\/x\.com', '\*' in LOUSHO_HTTP_ALLOW/
    );
    expect(calls).toEqual([]);
  });

  it('refuses a redirect to an unlisted host, and to an IP address', async () => {
    const toUnlisted = fakeFetch((url) => (url.includes('api.example.com') ? redirect('https://internal.corp/secret') : new Response('leak')));
    await expect(run({ allow: ['api.example.com'], fetch: toUnlisted.impl }, { url: 'https://api.example.com/' })).rejects.toThrow(
      /host internal\.corp is not in the allowlist/
    );
    expect(toUnlisted.calls).toEqual(['https://api.example.com/']);

    const toIp = fakeFetch(() => redirect('http://169.254.169.254/latest/meta-data'));
    await expect(run({ allow: ['api.example.com'], fetch: toIp.impl }, { url: 'https://api.example.com/' })).rejects.toThrow(/is an IP address/);
    expect(toIp.calls).toHaveLength(1);
  });

  it('follows a redirect to a listed host (relative locations included)', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url === 'https://a.example.com/start') return redirect('https://b.example.com/next');
      if (url === 'https://b.example.com/next') return redirect('/final');
      return new Response('done');
    });
    await expect(run({ allow: ['*.example.com'], fetch: impl }, { url: 'https://a.example.com/start' })).resolves.toBe('done');
    expect(calls).toEqual(['https://a.example.com/start', 'https://b.example.com/next', 'https://b.example.com/final']);
  });

  it('honours maxRedirects', async () => {
    const { impl, calls } = fakeFetch((url) => redirect(`${url}x`));
    await expect(run({ allow: ['api.example.com'], maxRedirects: 2, fetch: impl }, { url: 'https://api.example.com/' })).rejects.toThrow(
      'Exceeded maxRedirects (2)'
    );
    expect(calls).toHaveLength(3);
  });

  it('refuses ftp: and other schemes, on the first URL and on a redirect', async () => {
    const { impl, calls } = fakeFetch(() => redirect('ftp://api.example.com/file'));
    await expect(run({ allow: ['api.example.com'], fetch: impl }, { url: 'ftp://api.example.com/file' })).rejects.toThrow(
      /only http: and https: URLs are allowed, not ftp:/
    );
    await expect(run({ allow: ['api.example.com'], fetch: impl }, { url: 'file:///etc/passwd' })).rejects.toThrow(/not file:/);
    expect(calls).toEqual([]);
    await expect(run({ allow: ['api.example.com'], fetch: impl }, { url: 'https://api.example.com/' })).rejects.toThrow(/not ftp:/);
    expect(calls).toEqual(['https://api.example.com/']);
  });

  it('reports an invalid URL, an HTTP error status and a failed fetch as tool failures', async () => {
    await expect(run({ allow: ['api.example.com'] }, { url: 'not a url' })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_EXECUTION_FAILED',
      message: 'Request refused: invalid URL not a url',
    });
    const notFound = fakeFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(run({ allow: ['api.example.com'], fetch: notFound.impl }, { url: 'https://api.example.com/' })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_EXECUTION_FAILED',
      message: 'HTTP 404: Not Found',
    });
    const broken = fakeFetch(() => {
      throw new TypeError('network down');
    });
    await expect(run({ allow: ['api.example.com'], fetch: broken.impl }, { url: 'https://api.example.com/' })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_EXECUTION_FAILED',
      message: 'HTTP request failed: network down',
    });
  });

  it('sends method, headers and body, and drops the body of a GET', async () => {
    const seen: RequestInit[] = [];
    const { impl } = fakeFetch((_url, init) => {
      seen.push(init);
      return new Response('ok');
    });
    await run({ allow: ['api.example.com'], fetch: impl }, { url: 'https://api.example.com/', method: 'POST', headers: { 'X-A': '1' }, body: '{"b":2}' });
    await run({ allow: ['api.example.com'], fetch: impl }, { url: 'https://api.example.com/', method: 'GET', body: 'ignored' });
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"b":2}', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-A': '1' } });
    expect(seen[1].body).toBeUndefined();
  });

  it('times out as a tool failure, and a caller cancellation stays an AbortError', async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    await expect(run({ allow: ['api.example.com'], timeout: 20, fetch: hang.impl }, { url: 'https://api.example.com/' })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_EXECUTION_FAILED',
      message: 'Request timed out after 20ms',
    });

    const controller = new AbortController();
    const pending = run({ allow: ['api.example.com'], fetch: hang.impl }, { url: 'https://api.example.com/' }, { abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'HTTP request was aborted' });
  });

  it('uses globalThis.fetch at call time when no fetch is injected', async () => {
    const original = globalThis.fetch;
    const { impl, calls } = fakeFetch();
    globalThis.fetch = impl;
    try {
      await expect(run({ allow: ['api.example.com'] }, { url: 'https://api.example.com/' })).resolves.toBe('ok');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(['https://api.example.com/']);
  });
});

describe('parseHostAllowList', () => {
  it('splits on commas, trims and drops empty entries; a non-string is empty', () => {
    expect(parseHostAllowList(' api.github.com, *.example.com ,,')).toEqual(['api.github.com', '*.example.com']);
    expect(parseHostAllowList('')).toEqual([]);
    expect(parseHostAllowList(undefined)).toEqual([]);
    expect(parseHostAllowList(42)).toEqual([]);
  });
});

describe('ipFamily', () => {
  it('agrees with node:net isIP', () => {
    const samples = [
      '127.0.0.1', '0.0.0.0', '255.255.255.255', '256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5',
      '::', '::1', '1::', 'fe80::1', '2001:db8::8a2e:370:7334', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::1.2.3.4', '::ffff:999.0.0.1', '1::2::3', ':1', '1:', 'g::1', '12345::',
      'example.com', '', '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4',
    ];
    for (const sample of samples) {
      expect([sample, ipFamily(sample)]).toEqual([sample, isIP(sample)]);
    }
  });
});
