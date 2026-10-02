/**
 * N9b live test: a real model (openai/gpt-4o-mini on OpenRouter) handles a
 * tool call that pauses for an OAuth sign-in and runs again after it.
 * `list_repos` calls `ctx.getToken()` on a provider whose token endpoint is the
 * in-test fake; the run pauses, the fake code is exchanged, the pause is
 * approved, and the final answer names a repository the fake API returned.
 *
 * - Replay (default): the model is served from `__cassettes__/sign-in.json`, so
 *   the test costs nothing.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.10 USD).
 *   Grep the cassette for `sk-or-`, `Authorization` and `gho_SECRET` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { ALICE, fakeOAuthServer, githubProvider, listReposTool } from './__fixtures__/fakeOAuth';

const CASSETTE = path.join(__dirname, '__cassettes__', 'sign-in.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

describe.skipIf(!runnable)('OAuth sign-in live (N9b)', () => {
  it('a real model handles a tool call that pauses for sign-in and runs after it', async () => {
    const { tool, executions } = listReposTool(githubProvider(fakeOAuthServer()));
    const agent = createAgent({
      provider: recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' }),
      instructions: 'You help with GitHub. Use the tools. Keep answers short.',
      tools: [tool],
      store: memoryStore(),
      maxSteps: 3,
    });

    const paused = await agent.send('List my repositories.', { principal: ALICE });
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ kind: 'sign-in', toolName: 'list_repos', signIn: { provider: 'github' } });

    const state = new URL(pending.signIn?.url ?? '').searchParams.get('state') ?? '';
    expect(await agent.oauth.complete({ state, code: 'code-alice' })).toMatchObject({ outcome: 'signed-in', approvalId: pending.id });
    const done = await agent.approvals.resolve({ id: pending.id, approved: true });

    expect(done.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
    expect(done.text).toMatch(/lousho-demo|agent-sdk/);
  });
});
