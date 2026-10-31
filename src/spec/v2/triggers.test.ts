import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';
import { CHANNEL_SECRET_KEYS, triggerListSchema } from './triggers';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(triggers: unknown) {
  return { ...base, triggers };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

/** The five trigger types as the builder writes them. */
const EXAMPLES = {
  chat: { id: 'chat', type: 'chat' },
  cron: {
    id: 'daily',
    type: 'cron',
    cron: '0 9 * * MON-FRI',
    timezone: 'Europe/Paris',
    prompt: 'Write the morning report.',
    sharedSession: true,
  },
  webhook: {
    id: 'hook',
    type: 'webhook',
    path: '/deploy',
    secret: { env: 'HOOK_SECRET' },
    promptTemplate: 'Deploy {{body.ref}}.',
    filter: "body.action == 'push'",
  },
  channel: {
    id: 'tg',
    type: 'channel',
    channel: 'telegram',
    secrets: { botToken: { env: 'TG_BOT_TOKEN' }, secretToken: { secret: 'tg-webhook-secret' } },
    filter: 'update.message',
  },
  agent: {
    id: 'chain',
    type: 'agent',
    after: 'researcher',
    on: 'done',
    promptTemplate: 'Summarize {{run.resultText}}.',
  },
};

describe('spec v2 triggers', () => {
  it('accepts one trigger of each of the five types', () => {
    const triggers = Object.values(EXAMPLES);
    const result = agentSpecV2Schema.safeParse(spec(triggers));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.triggers).toEqual(triggers);
  });

  it('accepts a spec with no triggers and an empty trigger list', () => {
    expect(agentSpecV2Schema.safeParse(base).success).toBe(true);
    expect(agentSpecV2Schema.safeParse(spec([])).success).toBe(true);
  });

  it('rejects a missing or malformed id at triggers.<i>.id', () => {
    for (const id of [undefined, '', 'Bad Id!', '.dot', '-dash', 'x'.repeat(65)]) {
      const error = thrown(spec([{ ...EXAMPLES.chat, id }]));
      expect(error.errors).toHaveProperty('triggers.0.id');
    }
  });

  it('rejects a duplicate id at triggers.<i>.id', () => {
    const error = thrown(spec([EXAMPLES.chat, { ...EXAMPLES.cron, id: 'chat' }]));
    expect(error.errors).toHaveProperty('triggers.1.id');
    expect(error.message).toContain("duplicate id 'chat'");
  });

  it('rejects a second chat trigger at triggers.<i>', () => {
    const error = thrown(spec([EXAMPLES.chat, { ...EXAMPLES.chat, id: 'chat2' }]));
    expect(error.errors).toHaveProperty('triggers.1');
    expect(error.message).toContain('only one chat trigger');
  });

  it('rejects a cron expression that does not parse at triggers.<i>.cron', () => {
    for (const cron of ['not cron', '61 * * * *', '0 0 31 2 *', '* * *']) {
      const error = thrown(spec([{ ...EXAMPLES.cron, cron, timezone: undefined }]));
      expect(error.errors).toHaveProperty('triggers.0.cron');
    }
    const error = thrown(spec([{ ...EXAMPLES.cron, cron: 'not cron' }]));
    expect(error.message).toContain('Invalid cron expression');
  });

  it('accepts cron shortcuts and a missing timezone', () => {
    const trigger = { ...EXAMPLES.cron, cron: '@daily' };
    delete (trigger as Record<string, unknown>).timezone;
    delete (trigger as Record<string, unknown>).sharedSession;
    expect(agentSpecV2Schema.safeParse(spec([trigger])).success).toBe(true);
  });

  it('rejects an unknown time zone at triggers.<i>.timezone', () => {
    const error = thrown(spec([{ ...EXAMPLES.cron, timezone: 'Mars/Olympus' }]));
    expect(error.errors).toHaveProperty('triggers.0.timezone');
    expect(error.message).toContain("unknown time zone 'Mars/Olympus'");
    // The bad zone is not also reported as a cron problem.
    expect(error.errors).not.toHaveProperty('triggers.0.cron');
  });

  it('requires a non-empty prompt and promptTemplate', () => {
    const cron = thrown(spec([{ ...EXAMPLES.cron, prompt: '' }]));
    expect(cron.errors).toHaveProperty('triggers.0.prompt');
    const webhook = thrown(spec([{ ...EXAMPLES.webhook, promptTemplate: '' }]));
    expect(webhook.errors).toHaveProperty('triggers.0.promptTemplate');
    const agent = thrown(spec([{ ...EXAMPLES.agent, promptTemplate: '' }]));
    expect(agent.errors).toHaveProperty('triggers.0.promptTemplate');
  });

  it('rejects a webhook path outside ^/[A-Za-z0-9/_-]{1,100}$ at triggers.<i>.path', () => {
    for (const path of ['deploy', '/', 'x'.repeat(102), '/bad path']) {
      const error = thrown(spec([{ ...EXAMPLES.webhook, path }]));
      expect(error.errors).toHaveProperty('triggers.0.path');
    }
    for (const path of ['/a/b_c-d', `/${'x'.repeat(100)}`]) {
      expect(agentSpecV2Schema.safeParse(spec([{ ...EXAMPLES.webhook, path }])).success).toBe(true);
    }
  });

  it('rejects a duplicate webhook path at triggers.<i>.path', () => {
    const error = thrown(spec([EXAMPLES.webhook, { ...EXAMPLES.webhook, id: 'hook2' }]));
    expect(error.errors).toHaveProperty('triggers.1.path');
    expect(error.message).toContain("duplicate webhook path '/deploy'");
  });

  it('rejects a channel trigger missing a required secret at triggers.<i>.secrets.<key>', () => {
    for (const [channel, keys] of Object.entries(CHANNEL_SECRET_KEYS)) {
      if (keys.length === 0) continue;
      const trigger = {
        id: 'c',
        type: 'channel',
        channel,
        secrets: Object.fromEntries(keys.slice(1).map((key) => [key, { env: 'X' }])),
      };
      const error = thrown(spec([trigger]));
      expect(error.errors).toHaveProperty(`triggers.0.secrets.${keys[0]}`);
      expect(error.message).toContain(`'${channel}' needs secrets.${keys[0]}`);
    }
  });

  it('rejects a channel secret value that is not a SecretRef', () => {
    const trigger = { ...EXAMPLES.channel, secrets: { botToken: 'literal-token', secretToken: { env: 'X' } } };
    const error = thrown(spec([trigger]));
    expect(error.errors).toHaveProperty('triggers.0.secrets.botToken');
  });

  it('accepts extra secret keys a channel may still need (e.g. discord botToken)', () => {
    const trigger = {
      id: 'd',
      type: 'channel',
      channel: 'discord',
      secrets: {
        publicKey: { env: 'DISCORD_PUBLIC_KEY' },
        applicationId: { env: 'DISCORD_APP_ID' },
        botToken: { secret: 'discord-bot-token' },
      },
    };
    expect(agentSpecV2Schema.safeParse(spec([trigger])).success).toBe(true);
    const http = { id: 'h', type: 'channel', channel: 'http', secrets: {} };
    expect(agentSpecV2Schema.safeParse(spec([http])).success).toBe(true);
  });

  it('rejects an unknown channel kind and an empty agent.after', () => {
    const channel = thrown(spec([{ ...EXAMPLES.channel, channel: 'irc' }]));
    expect(channel.errors).toHaveProperty('triggers.0.channel');
    const agent = thrown(spec([{ ...EXAMPLES.agent, after: '' }]));
    expect(agent.errors).toHaveProperty('triggers.0.after');
    const on = thrown(spec([{ ...EXAMPLES.agent, on: 'always' }]));
    expect(on.errors).toHaveProperty('triggers.0.on');
  });

  it('rejects an unknown trigger type', () => {
    const error = thrown(spec([{ id: 'x', type: 'monitor' }]));
    expect(Object.keys(error.errors).some((path) => path.startsWith('triggers.0'))).toBe(true);
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('rejects a non-object trigger entry', () => {
    for (const trigger of ['daily', 42, null]) {
      const error = thrown(spec([trigger]));
      expect(Object.keys(error.errors).some((path) => path.startsWith('triggers.0'))).toBe(true);
    }
  });

  it('rejects an entry with an extra key (strict variants)', () => {
    for (const [type, example] of Object.entries(EXAMPLES)) {
      const error = thrown(spec([{ ...example, unexpected: true }]));
      expect(Object.keys(error.errors).some((path) => path.startsWith('triggers.0')), type).toBe(true);
    }
  });

  it('rejects a v1-style cron trigger (no id, input not prompt); upgrading is S02', () => {
    const error = thrown(spec([{ type: 'cron', cron: '0 9 * * *', input: 'Report.' }]));
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('triggers.0.id');
  });

  it('rejects trigger values that are not a list', () => {
    for (const triggers of ['daily', 42, { id: 'x' }]) {
      const error = thrown(spec(triggers));
      expect(error.errors).toHaveProperty('triggers');
    }
  });
});

describe('triggerListSchema', () => {
  it('returns the parsed triggers', () => {
    const result = triggerListSchema.safeParse(Object.values(EXAMPLES));
    expect(result.success).toBe(true);
  });
});
