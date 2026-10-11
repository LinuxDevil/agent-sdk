import { describe, expect, it } from 'vitest';
import { hostHeaderAllowed, hostnameOf, isLoopbackHost } from './hostCheck';

describe('isLoopbackHost', () => {
  it('accepts localhost, 127.0.0.0/8 and ::1 exactly', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
  });

  it('refuses names that only look loopback, and other addresses', () => {
    for (const host of ['127.attacker.example', '127.0.0.1.attacker.example', '127.0.0.256', 'localhost.attacker.example', '0.0.0.0', '10.0.0.1', '']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('hostnameOf', () => {
  it('strips the port and refuses userinfo and paths', () => {
    expect(hostnameOf('Example.COM:8080')).toBe('example.com');
    expect(hostnameOf('[::1]:3737')).toBe('[::1]');
    expect(hostnameOf('127.0.0.1@evil.example')).toBeUndefined();
    expect(hostnameOf('evil.example/@127.0.0.1')).toBeUndefined();
    expect(hostnameOf('')).toBeUndefined();
    expect(hostnameOf(undefined)).toBeUndefined();
  });
});

describe('hostHeaderAllowed', () => {
  it('a loopback bind accepts only loopback names', () => {
    expect(hostHeaderAllowed('localhost:3737', '127.0.0.1')).toBe(true);
    expect(hostHeaderAllowed('127.0.0.1:3737', '127.0.0.1')).toBe(true);
    expect(hostHeaderAllowed('[::1]:3737', '127.0.0.1')).toBe(true);
    expect(hostHeaderAllowed('127.attacker.example:3737', '127.0.0.1')).toBe(false);
    expect(hostHeaderAllowed('evil.example', '127.0.0.1')).toBe(false);
    expect(hostHeaderAllowed('192.168.1.5:3737', '127.0.0.1')).toBe(false);
    expect(hostHeaderAllowed(undefined, '127.0.0.1')).toBe(false);
  });

  it('a wildcard bind adds IP addresses, never a name', () => {
    expect(hostHeaderAllowed('192.168.1.5:3737', '0.0.0.0')).toBe(true);
    expect(hostHeaderAllowed('[fe80::1]:3737', '::')).toBe(true);
    expect(hostHeaderAllowed('evil.example:3737', '0.0.0.0')).toBe(false);
  });

  it('a named bind adds that name', () => {
    expect(hostHeaderAllowed('devbox.local:3737', 'devbox.local')).toBe(true);
    expect(hostHeaderAllowed('evil.example:3737', 'devbox.local')).toBe(false);
  });

  it('allowedHosts is the whole list; * accepts anything', () => {
    expect(hostHeaderAllowed('agent.example.com', '0.0.0.0', ['agent.example.com'])).toBe(true);
    expect(hostHeaderAllowed('agent.example.com:8443', '0.0.0.0', ['agent.example.com:8443'])).toBe(true);
    expect(hostHeaderAllowed('localhost', '0.0.0.0', ['agent.example.com'])).toBe(false);
    expect(hostHeaderAllowed('anything.example', '127.0.0.1', ['*'])).toBe(true);
  });
});
