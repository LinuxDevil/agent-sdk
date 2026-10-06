import { describe, it, expect } from 'vitest';
import type { OAuthProvider } from '../oauth/defineOAuthProvider';
import { testToolContext } from './testToolContext';

const provider = { name: 'test-oauth' } as OAuthProvider;

describe('testToolContext', () => {
  it('returns a valid minimal ToolExecutionContext', () => {
    const ctx = testToolContext();
    expect(ctx.toolCallId).toBe('test-call');
    expect(ctx.messages).toEqual([]);
    expect(ctx.abortSignal).toBeUndefined();
  });

  it('lets every field be overridden', () => {
    const messages = [{ role: 'user', content: 'hi' }] as const;
    const ctx = testToolContext({
      toolCallId: 'call_7',
      messages,
      sessionId: 's1',
    });
    expect(ctx.toolCallId).toBe('call_7');
    expect(ctx.messages).toBe(messages);
    expect(ctx.sessionId).toBe('s1');
  });

  it('lets a test stub getToken for a tool that asks for a token', async () => {
    const ctx = testToolContext({
      getToken: () => Promise.resolve({ accessToken: 'gho_test', tokenType: 'Bearer' }),
    });
    await expect(ctx.getToken(provider)).resolves.toMatchObject({ accessToken: 'gho_test' });
  });

  it('fails loudly when an unstubbed tool asks for OAuth', async () => {
    const ctx = testToolContext();
    await expect(ctx.getToken(provider)).rejects.toThrow(/getToken\(\) is not stubbed/);
    expect(() => ctx.requireAuth(provider)).toThrow(/requireAuth\(\) is not stubbed/);
  });
});
