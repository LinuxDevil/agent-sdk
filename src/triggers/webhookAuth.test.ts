import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkSlackSignature, verifySlackSignature } from './webhookAuth';

const signingSecret = 'test-signing-secret';
const now = 1_700_000_000_000;
const timestamp = String(now / 1000);
const rawBody = 'token=abc&text=hello';
const sign = (body: string) => `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;

describe('checkSlackSignature / verifySlackSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    const input = { signingSecret, timestamp, signature: sign(rawBody), rawBody, now };
    expect(checkSlackSignature(input)).toBeUndefined();
    expect(verifySlackSignature(input)).toBe(true);
  });

  it('rejects a signature that does not match the body', () => {
    const input = { signingSecret, timestamp, signature: sign('other'), rawBody, now };
    expect(checkSlackSignature(input)).toBe('signature mismatch');
    expect(verifySlackSignature(input)).toBe(false);
  });

  it('rejects missing headers and an unset secret', () => {
    expect(checkSlackSignature({ signingSecret, timestamp: undefined, signature: undefined, rawBody, now })).toBe('missing signature headers');
    expect(checkSlackSignature({ signingSecret: '', timestamp, signature: sign(rawBody), rawBody, now })).toBe('no signing secret configured');
  });

  it('rejects a stale timestamp', () => {
    const stale = String(now / 1000 - 3600);
    expect(checkSlackSignature({ signingSecret, timestamp: stale, signature: sign(rawBody), rawBody, now })).toBe('stale or invalid timestamp');
  });
});
