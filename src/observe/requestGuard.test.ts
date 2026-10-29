/**
 * The observe daemon's /api/* request guard (I3): loopback `Host` when bound
 * to loopback (DNS rebinding), no cross-site browser writes (`Origin`,
 * `Sec-Fetch-Site`), and `application/json` bodies only (no "simple" form or
 * text/plain POSTs).
 */
import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { guardApiRequest } from './requestGuard';

const JSON_POST: IncomingHttpHeaders = { host: '127.0.0.1:7777', 'content-type': 'application/json', 'content-length': '2' };

const check = (method: string, headers: IncomingHttpHeaders, boundHost = '127.0.0.1') => guardApiRequest(method, headers, boundHost);
const statusOf = (method: string, headers: IncomingHttpHeaders, boundHost?: string) => check(method, headers, boundHost)?.status;

describe('guardApiRequest: Origin on writes', () => {
  it.each([
    ['missing Origin (non-browser client)', undefined, undefined],
    ['Origin null', 'null', 403],
    ['empty Origin', '', 403],
    ['Origin http://evil.com', 'http://evil.com', 403],
    ['Origin http://localhost:5173', 'http://localhost:5173', undefined],
    ['Origin http://[::1]:4318', 'http://[::1]:4318', undefined],
    ['Origin https://127.0.0.1', 'https://127.0.0.1', undefined],
    ['Origin http://studio.localhost:3000', 'http://studio.localhost:3000', undefined],
    ['Origin http://127.0.0.1.evil.com', 'http://127.0.0.1.evil.com', 403],
    ['Origin http://localhost.evil.com', 'http://localhost.evil.com', 403],
    ['Origin file://localhost', 'file://localhost', 403],
    ['Origin http://192.168.1.10', 'http://192.168.1.10', 403],
  ])('POST with %s', (_label, origin, expected) => {
    const headers = origin === undefined ? JSON_POST : { ...JSON_POST, origin };
    expect(statusOf('POST', headers)).toBe(expected);
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('%s with a foreign Origin is rejected', (method) => {
    expect(statusOf(method, { host: 'localhost:7777', origin: 'http://evil.com' })).toBe(403);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s with Origin evil.com passes the Origin rule', (method) => {
    expect(check(method, { host: '127.0.0.1:7777', origin: 'http://evil.com' })).toBeUndefined();
  });

  it('GET with Origin evil.com is still subject to the Host rule', () => {
    expect(statusOf('GET', { host: 'evil.com', origin: 'http://evil.com' })).toBe(403);
  });

  it('applies the Origin rule when bound beyond loopback too', () => {
    expect(statusOf('POST', { ...JSON_POST, host: '10.0.0.5:7777', origin: 'http://evil.com' }, '0.0.0.0')).toBe(403);
  });

  it('rejects Sec-Fetch-Site: cross-site on a write, allows same-origin / same-site / none', () => {
    expect(statusOf('POST', { ...JSON_POST, 'sec-fetch-site': 'cross-site' })).toBe(403);
    for (const site of ['same-origin', 'same-site', 'none']) expect(statusOf('POST', { ...JSON_POST, 'sec-fetch-site': site })).toBeUndefined();
    expect(check('GET', { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' })).toBeUndefined();
  });

  it('answers 403 with LOUSHO_REQUEST_INVALID and a message naming the cross-origin rule', () => {
    expect(check('POST', { ...JSON_POST, origin: 'http://evil.com' })).toEqual({
      status: 403,
      error: expect.stringMatching(/cross-origin/i),
      code: 'LOUSHO_REQUEST_INVALID',
    });
  });
});

describe('guardApiRequest: Host when bound to loopback', () => {
  it.each([
    ['127.0.0.1 (no port)', '127.0.0.1', undefined],
    ['127.0.0.1:7777', '127.0.0.1:7777', undefined],
    ['127.5.6.7:7777', '127.5.6.7:7777', undefined],
    ['[::1]:4318', '[::1]:4318', undefined],
    ['LOCALHOST:4318', 'LOCALHOST:4318', undefined],
    ['localhost. (trailing dot)', 'localhost.:7777', undefined],
    ['studio.localhost:7777', 'studio.localhost:7777', undefined],
    ['evil.com', 'evil.com', 403],
    ['DNS rebinding attacker.example:4318', 'attacker.example:4318', 403],
    ['127.0.0.1.evil.com', '127.0.0.1.evil.com', 403],
    ['localhost.evil.com', 'localhost.evil.com:7777', 403],
    ['0.0.0.0', '0.0.0.0:7777', 403],
    ['LAN IP 192.168.1.10', '192.168.1.10:7777', 403],
    ['garbage a@b', 'a@b', 403],
  ])('Host %s', (_label, host, expected) => {
    expect(statusOf('GET', { host })).toBe(expected);
  });

  it('allows a missing Host header', () => {
    expect(check('GET', {})).toBeUndefined();
  });

  it.each(['localhost', '::1', '127.0.0.1'])('applies for a %s bind', (bound) => {
    expect(statusOf('GET', { host: 'evil.com' }, bound)).toBe(403);
  });

  it('skips the Host rule when bound beyond loopback (the token guards it there)', () => {
    expect(check('GET', { host: 'observe.example.com' }, '0.0.0.0')).toBeUndefined();
  });

  it('answers 403 with a message saying the daemon only answers loopback Host names', () => {
    expect(check('GET', { host: 'evil.com' })).toEqual({
      status: 403,
      error: expect.stringMatching(/loopback Host/i),
      code: 'LOUSHO_REQUEST_INVALID',
    });
  });
});

describe('guardApiRequest: JSON content type on writes', () => {
  const withType = (type: string | undefined, extra: IncomingHttpHeaders = { 'content-length': '2' }): IncomingHttpHeaders => ({
    host: '127.0.0.1:7777',
    ...extra,
    ...(type === undefined ? {} : { 'content-type': type }),
  });

  it.each([
    ['text/plain', 415],
    ['application/x-www-form-urlencoded', 415],
    ['multipart/form-data; boundary=x', 415],
    ['application/json-patch+json', 415],
    ['text/json', 415],
    ['application/json; charset=utf-8', undefined],
    ['Application/JSON', undefined],
    [' application/json ', undefined],
  ])('POST with Content-Type %s', (type, expected) => {
    expect(statusOf('POST', withType(type))).toBe(expected);
  });

  it('rejects a body with no Content-Type (content-length or transfer-encoding)', () => {
    expect(statusOf('POST', withType(undefined))).toBe(415);
    expect(statusOf('PUT', withType(undefined, { 'transfer-encoding': 'chunked' }))).toBe(415);
  });

  it('rejects a non-JSON Content-Type even with no body', () => {
    expect(statusOf('POST', withType('text/plain', { 'content-length': '0' }))).toBe(415);
  });

  it('allows a bodyless write with no Content-Type (DELETE, an empty claim POST)', () => {
    expect(check('DELETE', withType(undefined, {}))).toBeUndefined();
    expect(check('POST', withType(undefined, { 'content-length': '0' }))).toBeUndefined();
  });

  it('does not apply to GET', () => {
    expect(check('GET', withType('text/plain'))).toBeUndefined();
  });

  it('answers 415 with LOUSHO_REQUEST_INVALID', () => {
    expect(check('POST', withType('text/plain'))).toEqual({
      status: 415,
      error: expect.stringMatching(/application\/json/),
      code: 'LOUSHO_REQUEST_INVALID',
    });
  });
});
