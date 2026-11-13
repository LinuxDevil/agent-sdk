import { describe, it, expect } from 'vitest';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';
import type { AbortListenerSpec } from './abortListeners';
import type { AgentSpecV2 } from './types';
import type { TriggerSpec } from './triggers';

const base: AgentSpecV2 = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

const webhook = { id: 'hook', type: 'webhook', path: '/deploy', promptTemplate: 'Deploy {{body.ref}}.' } as const;
const channel = {
  id: 'tg',
  type: 'channel',
  channel: 'telegram',
  secrets: { botToken: { env: 'TG_BOT_TOKEN' }, secretToken: { secret: 'tg-webhook-secret' } },
} as const;
const chat = { id: 'chat', type: 'chat' } as const;

function spec(overrides: Partial<AgentSpecV2>): AgentSpecV2 {
  return { ...base, ...overrides };
}

/** A valid listener; `overrides` may carry deliberately invalid values for the rejection cases. */
function listener(overrides: Record<string, unknown> = {}): AbortListenerSpec {
  return {
    id: 'a1',
    triggerId: 'hook',
    when: "event.kind == 'cancel'",
    match: 'run.event.pr == event.pr',
    scope: 'both',
    ...overrides,
  } as AbortListenerSpec;
}

function issuesOf(data: unknown) {
  const result = agentSpecV2Schema.safeParse(data);
  return result.success ? [] : result.error.issues;
}

function pathOf(entry: { path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }): string {
  return (entry.path ?? []).map((part) => (typeof part === 'object' && part !== null ? part.key : part)).join('.');
}

describe('abortListeners', () => {
  it('accepts a spec with webhook and channel listeners', () => {
    const parsed = parseAgentSpecV2(
      spec({
        triggers: [webhook, channel],
        abortListeners: [listener(), listener({ id: 'a2', triggerId: 'tg', scope: 'queued' })],
      })
    );
    expect(parsed.abortListeners).toHaveLength(2);
    expect(parsed.abortListeners?.[0]).toMatchObject({ id: 'a1', triggerId: 'hook', scope: 'both' });
  });

  it('accepts expressions that only reference variables the scope will provide', () => {
    const result = agentSpecV2Schema.safeParse(
      spec({ triggers: [webhook], abortListeners: [listener({ when: 'event.missing.deep', match: 'run.event.x == event.y' })] })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a duplicate listener id at its id path', () => {
    const issues = issuesOf(spec({ triggers: [webhook], abortListeners: [listener(), listener()] }));
    const issue = issues.find((entry) => pathOf(entry) === 'abortListeners.1.id');
    expect(issue?.message).toBe("Abort listener id 'a1' is used twice.");
  });

  it('rejects a listener watching a trigger that does not exist', () => {
    const issues = issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ triggerId: 'nope' })] }));
    const issue = issues.find((entry) => pathOf(entry) === 'abortListeners.0.triggerId');
    expect(issue?.message).toBe("No trigger 'nope' in this agent.");
  });

  it.each(['chat', 'cron', 'agent'] as const)('rejects a listener watching a %s trigger', (type) => {
    const trigger: TriggerSpec =
      type === 'chat'
        ? chat
        : type === 'cron'
          ? { id: 'c', type: 'cron', cron: '0 9 * * *', prompt: 'hi' }
          : { id: 'ag', type: 'agent', after: 'x', on: 'done', promptTemplate: 'p' };
    const issues = issuesOf(spec({ triggers: [trigger], abortListeners: [listener({ triggerId: trigger.id })] }));
    const issue = issues.find((entry) => pathOf(entry) === 'abortListeners.0.triggerId');
    expect(issue?.message).toBe(
      `Abort listeners can only watch webhook or channel triggers; '${trigger.id}' is a ${type} trigger.`
    );
  });

  it('rejects a malformed when expression with its position in params', () => {
    const issues = issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ when: 'event.kind ==' })] }));
    const issue = issues.find((entry) => pathOf(entry) === 'abortListeners.0.when');
    expect(issue?.message).toMatch(/^Expression error at \d+: /);
    expect((issue as { params?: { position?: number } })?.params?.position).toBeTypeOf('number');
  });

  it('rejects a malformed match expression at its own path', () => {
    const issues = issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ match: 'process.exit(1)' })] }));
    const issue = issues.find((entry) => pathOf(entry) === 'abortListeners.0.match');
    expect(issue?.message).toMatch(/^Expression error at \d+: /);
  });

  it('rejects more than 20 listeners', () => {
    const abortListeners = Array.from({ length: 21 }, (_, index) => listener({ id: `a${index}` }));
    const issues = issuesOf(spec({ triggers: [webhook], abortListeners }));
    expect(issues.some((entry) => entry.path?.[0] === 'abortListeners')).toBe(true);
  });

  it('rejects unknown keys, a bad scope and an invalid id shape', () => {
    expect(issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ extra: 1 })] })).length).toBeGreaterThan(0);
    expect(issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ scope: 'paused' })] })).length).toBeGreaterThan(0);
    expect(issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ id: '-bad' })] })).length).toBeGreaterThan(0);
  });

  it('rejects empty when/match', () => {
    expect(issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ when: '' })] })).length).toBeGreaterThan(0);
    expect(issuesOf(spec({ triggers: [webhook], abortListeners: [listener({ match: '' })] })).length).toBeGreaterThan(0);
  });
});
