import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { testToolContext } from 'lousho/testing';
import { AUTHOR_TOOL_FACTORIES, buildAuthorTools, type AuthorToolDeps } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { AuthorToolFailure, RequestSecretOutput } from '../../../../shared/authorWire';
import { SecretsStore } from '../../../secretsStore';
import { AuthorSessionStore } from '../../sessionStore';
import type { WorkspaceContext } from '../../../workspace/context';

/**
 * requestSecret (AA14): 'pending' opens the card, 'exists' answers
 * without one when the name already holds a value, and the provider
 * keys / Studio token are refused toward Settings. The value never
 * crosses the tool - the 'exists' output carries only the name.
 */

const TURN: AuthorTurn = {
  sessionId: 'sess-1',
  requestId: 'req-test',
  focus: { mode: 'create' },
  storedTranscript: [],
  userMessage: { id: 'm-1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  signal: new AbortController().signal,
  stepsRemaining: () => 12,
  state: new Map(),
};

function fakeDeps(secrets: AuthorToolDeps['secrets']): AuthorToolDeps {
  return {
    workspace: async () => ({}) as WorkspaceContext,
    catalog: {
      listModels: () => [],
      listTools: () => [],
      listGuardrails: () => [],
      listTriggerTypes: () => [],
      listSkills: async () => [],
      listKits: async () => [],
      listRegistryMcpServers: async () => [],
    },
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir: '/nonexistent-docs',
    reviewDraft: async () => ({ pass: true }),
    requirements: async () => [],
    sessions: new AuthorSessionStore('/unused-sessions'),
    secrets,
  };
}

const EMPTY_SECRETS: AuthorToolDeps['secrets'] = {
  secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }),
};

function tool(deps: AuthorToolDeps) {
  return buildAuthorTools(TURN, deps).find(
    (candidate) => ((candidate as { name?: string }).name ?? candidate.displayName) === 'requestSecret'
  )!;
}

async function call(t: ReturnType<typeof tool>, args: Record<string, unknown>): Promise<unknown> {
  return t.execute!(args as never, testToolContext({ toolCallId: 'call_s1' }));
}

describe('requestSecret', () => {
  it('is registered in AUTHOR_TOOL_FACTORIES', () => {
    const names = AUTHOR_TOOL_FACTORIES.map((factory) => factory(TURN, fakeDeps(EMPTY_SECRETS))).map(
      (t) => (t as { name?: string }).name ?? t.displayName
    );
    expect(names).toContain('requestSecret');
  });

  it('answers pending for a name that holds no value', async () => {
    const output = (await call(tool(fakeDeps(EMPTY_SECRETS)), {
      name: 'GITHUB_TOKEN',
      why: 'The agent lists your repos.',
    })) as RequestSecretOutput;
    expect(output).toEqual({ ok: true, name: 'GITHUB_TOKEN', status: 'pending' });
  });

  describe('with a real secrets store', () => {
    let dir: string;
    let secrets: SecretsStore;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa14-tool-'));
      secrets = new SecretsStore(dir);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('answers exists for a stored name - no card, and the value stays out of the output', async () => {
      secrets.setSecret('GITHUB_TOKEN', 'sk-live-SECRET-999');
      const output = (await call(tool(fakeDeps(secrets)), {
        name: 'GITHUB_TOKEN',
        why: 'The agent lists your repos.',
      })) as RequestSecretOutput;
      expect(output).toEqual({ ok: true, name: 'GITHUB_TOKEN', status: 'exists' });
      expect(JSON.stringify(output)).not.toContain('sk-live-SECRET-999');
    });

    it('answers pending for a name the store does not hold', async () => {
      const output = (await call(tool(fakeDeps(secrets)), {
        name: 'SLACK_BOT_TOKEN',
        why: 'The agent posts to Slack.',
      })) as RequestSecretOutput;
      expect(output).toEqual({ ok: true, name: 'SLACK_BOT_TOKEN', status: 'pending' });
    });
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'LOUSHO_STUDIO_TOKEN',
  ])('refuses the reserved name %s toward Settings', async (name) => {
    const failure = (await call(tool(fakeDeps(EMPTY_SECRETS)), { name, why: 'needed' })) as AuthorToolFailure;
    expect(failure).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
      userMessage: 'That key is set in Settings.',
    });
    expect(failure.error).toBe(
      `${name} is a provider key or a Studio token and is set in Settings, not through requestSecret.`
    );
    expect(failure.next).toBe('Tell the user to add it in Settings, and use openPage with "/settings".');
  });

  it.each(['github_token', 'Github_Token', 'A', 'A'.repeat(65), '1TOKEN', 'MY-TOKEN'])(
    'the schema rejects the bad name %j before execute runs',
    (name) => {
      const input = tool(fakeDeps(EMPTY_SECRETS)).inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(input.safeParse({ name, why: 'The agent needs it.' }).success).toBe(false);
    }
  );

  it('a throwing secrets store is an UNAVAILABLE failure, never a thrown execute', async () => {
    const broken: AuthorToolDeps['secrets'] = {
      secretStatus: () => {
        throw new Error('secrets.json is unreadable');
      },
    };
    const failure = (await call(tool(fakeDeps(broken)), { name: 'GITHUB_TOKEN', why: 'needed' })) as AuthorToolFailure;
    expect(failure).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  });
});
