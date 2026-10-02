import { describe, it, expect, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isPrivateAddress, pinnedLookup, resolvePublicAddresses, SsrfBlockedError, findSsrfBlockedError } from './privateAddress';

/** Stubs `dns.promises.lookup` (the resolver the module uses) with a fixed answer per host. */
function stubResolver(answers: Record<string, LookupAddress[]>) {
  return vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string) => {
    const answer = answers[hostname];
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return answer;
  }) as unknown as typeof dns.promises.lookup);
}

function lookupOnce(fn: ReturnType<typeof pinnedLookup>, host: string, options: dns.LookupOptions = {}) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    fn(host, options, (error, address, family) => (error ? reject(error) : resolve({ address, family })));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '::',
    '[::]',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '[FE80::1]',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:10.0.0.1]',
    '64:ff9b::7f00:1',
    '64:ff9b::8.8.8.8',
    '2002:7f00:1::1',
    '2002::1',
  ])('%s is private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '203.0.113.10', '172.32.0.1', '100.128.0.1', '198.20.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );

  it('treats anything that is not an IP address as private (fail closed)', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('resolvePublicAddresses', () => {
  it('returns every address of a public name', async () => {
    stubResolver({ 'public.test': [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::1', family: 6 }] });
    await expect(resolvePublicAddresses('public.test')).resolves.toEqual([
      { address: '203.0.113.10', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);
  });

  it('refuses a name with any private address, naming the host only', async () => {
    stubResolver({ 'mixed.test': [{ address: '203.0.113.10', family: 4 }, { address: '10.0.0.5', family: 4 }] });
    const error = await resolvePublicAddresses('mixed.test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect((error as Error).message).toContain('mixed.test');
    expect((error as Error).message).not.toContain('10.0.0.5');
  });

  it('checks IP literals without resolving them', async () => {
    const spy = stubResolver({});
    await expect(resolvePublicAddresses('[::1]')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolvePublicAddresses('203.0.113.10')).resolves.toEqual([{ address: '203.0.113.10', family: 4 }]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pinnedLookup', () => {
  it('throws SsrfBlockedError for a name resolving to any private address', async () => {
    stubResolver({ 'rebind.test': [{ address: '127.0.0.1', family: 4 }] });
    await expect(lookupOnce(pinnedLookup(), 'rebind.test')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('returns the checked address, resolving exactly once per connection', async () => {
    const spy = stubResolver({ 'public.test': [{ address: '203.0.113.10', family: 4 }] });
    await expect(lookupOnce(pinnedLookup(), 'public.test')).resolves.toEqual({ address: '203.0.113.10', family: 4 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers `all: true` with every checked address and honors `family`', async () => {
    stubResolver({ 'dual.test': [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::1', family: 6 }] });
    await expect(lookupOnce(pinnedLookup(), 'dual.test', { all: true })).resolves.toMatchObject({
      address: [{ address: '203.0.113.10', family: 4 }, { address: '2001:db8::1', family: 6 }],
    });
    await expect(lookupOnce(pinnedLookup(), 'dual.test', { family: 6 })).resolves.toEqual({ address: '2001:db8::1', family: 6 });
  });

  it('allowPrivate exempts a matching host, and only that host', async () => {
    stubResolver({ 'docs.intranet.test': [{ address: '10.1.2.3', family: 4 }], 'other.test': [{ address: '10.1.2.3', family: 4 }] });
    const lookup = pinnedLookup({ allowPrivate: ['*.intranet.test'] });
    await expect(lookupOnce(lookup, 'docs.intranet.test')).resolves.toEqual({ address: '10.1.2.3', family: 4 });
    await expect(lookupOnce(lookup, 'other.test')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('passes resolver failures through', async () => {
    stubResolver({});
    await expect(lookupOnce(pinnedLookup(), 'missing.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('findSsrfBlockedError', () => {
  it('finds the error on a cause chain', () => {
    const blocked = new SsrfBlockedError('x.test');
    const wrapped = new TypeError('fetch failed', { cause: new Error('connect', { cause: blocked }) });
    expect(findSsrfBlockedError(wrapped)).toBe(blocked);
    expect(findSsrfBlockedError(new Error('other'))).toBeUndefined();
  });
});
