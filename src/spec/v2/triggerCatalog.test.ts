import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from '../../tools/mcp/schema';
import { listTriggerTypes, type TriggerTypeInfo } from './triggerCatalog';
import { CHANNEL_KINDS, triggerSpecSchema, type TriggerSpec } from './triggers';

/** A valid trigger of each type, as a builder's form would produce it. */
const FIXTURES: Record<TriggerSpec['type'], TriggerSpec> = {
  chat: { id: 'chat', type: 'chat' },
  cron: {
    id: 'daily',
    type: 'cron',
    cron: '0 9 * * MON-FRI',
    timezone: 'UTC',
    prompt: 'Write the morning report.',
    sharedSession: false,
  },
  webhook: {
    id: 'hook',
    type: 'webhook',
    path: '/deploy/prod',
    secret: { secret: 'hook-hmac' },
    promptTemplate: 'Deploy {{body.ref}}.',
    filter: "body.action == 'push'",
  },
  channel: {
    id: 'slack',
    type: 'channel',
    channel: 'slack',
    secrets: { signingSecret: { env: 'SLACK_SIGNING_SECRET' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
    filter: 'event.app_mention',
  },
  agent: {
    id: 'chain',
    type: 'agent',
    after: 'researcher',
    on: 'error',
    promptTemplate: 'Summarize {{run.resultText}}.',
  },
};

/**
 * The zod schema a form gets by feeding the catalog row's `fieldsJsonSchema`
 * the shared `id`/`type` properties — the conformance check against the zod
 * `triggerSpecSchema` this file's tests perform.
 */
function formSchema(info: TriggerTypeInfo) {
  const fields = info.fieldsJsonSchema;
  return jsonSchemaToZod({
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { const: info.type },
      ...(fields.properties as Record<string, unknown>),
    },
    required: ['id', 'type', ...((fields.required as string[] | undefined) ?? [])],
    additionalProperties: false,
  });
}

describe('listTriggerTypes', () => {
  it('returns the five trigger types in fixed order', () => {
    const types = listTriggerTypes();
    expect(types.map((info) => info.type)).toEqual(['chat', 'cron', 'webhook', 'channel', 'agent']);
  });

  it('carries the title, description and runtimes the picker shows', () => {
    const expected = [
      ['chat', 'Chat', 'Runs when someone sends the agent a message in the test pane, a client or the HTTP API.', ['dev', 'worker', 'studio']],
      ['cron', 'Schedule', 'Runs the agent on a cron schedule with a fixed prompt.', ['dev', 'worker', 'studio']],
      ['webhook', 'Webhook', 'Runs when an HTTP POST arrives at the path; the body fills the prompt template.', ['studio']],
      ['channel', 'Channel', 'Runs on messages from Telegram, Slack, GitHub, Teams, Discord or plain HTTP.', ['studio']],
      ['agent', 'After another agent', "Runs when another agent's run finishes with the chosen status.", ['studio']],
    ] as const;
    expect(listTriggerTypes().map((info) => [info.type, info.title, info.description, info.runsUnder])).toEqual([...expected]);
  });

  it('returns a deep copy: mutating the result does not change the next call', () => {
    const first = listTriggerTypes();
    first[0].title = 'MUTATED';
    first[0].runsUnder = [];
    (first[1].fieldsJsonSchema.properties as Record<string, unknown>).cron = { type: 'number' };
    const second = listTriggerTypes();
    expect(second[0].title).toBe('Chat');
    expect(second[0].runsUnder).toEqual(['dev', 'worker', 'studio']);
    expect((second[1].fieldsJsonSchema.properties as Record<string, { type: string }>).cron.type).toBe('string');
  });

  it('gives every field of every type a title and a description', () => {
    for (const info of listTriggerTypes()) {
      for (const [name, property] of Object.entries(info.fieldsJsonSchema.properties as Record<string, Record<string, unknown>>)) {
        expect(property.title, `${info.type}.${name} title`).toBeTruthy();
        expect(property.description, `${info.type}.${name} description`).toBeTruthy();
      }
    }
  });

  it('lists the channel kinds the schema accepts', () => {
    const channel = listTriggerTypes().find((info) => info.type === 'channel');
    const field = (channel?.fieldsJsonSchema.properties as Record<string, Record<string, unknown>>).channel;
    expect(field.enum).toEqual([...CHANNEL_KINDS]);
  });
});

describe('trigger catalog conformance', () => {
  for (const info of listTriggerTypes()) {
    it(`type '${info.type}': a valid fixture is accepted by the zod schema and the catalog schema`, () => {
      const fixture = FIXTURES[info.type];
      expect(triggerSpecSchema.safeParse(fixture).success, 'triggerSpecSchema').toBe(true);
      expect(formSchema(info).safeParse(fixture).success, 'fieldsJsonSchema').toBe(true);
    });

    it(`type '${info.type}': a fixture with an extra key is rejected by both`, () => {
      const fixture = { ...FIXTURES[info.type], extra: true };
      expect(triggerSpecSchema.safeParse(fixture).success, 'triggerSpecSchema').toBe(false);
      expect(formSchema(info).safeParse(fixture).success, 'fieldsJsonSchema').toBe(false);
    });

    it(`type '${info.type}': a fixture of only the required keys is accepted by both`, () => {
      const required = new Set(['id', 'type', ...((info.fieldsJsonSchema.required as string[] | undefined) ?? [])]);
      const fixture = Object.fromEntries(
        Object.entries(FIXTURES[info.type] as Record<string, unknown>).filter(([key]) => required.has(key))
      );
      expect(triggerSpecSchema.safeParse(fixture).success, 'triggerSpecSchema').toBe(true);
      expect(formSchema(info).safeParse(fixture).success, 'fieldsJsonSchema').toBe(true);
    });

    it(`type '${info.type}': required lists match the zod schema`, () => {
      const required = new Set(['id', 'type', ...((info.fieldsJsonSchema.required as string[] | undefined) ?? [])]);
      const fixture = { ...FIXTURES[info.type] } as Record<string, unknown>;
      for (const key of required) delete fixture[key];
      expect(triggerSpecSchema.safeParse(fixture).success).toBe(false);
      expect(formSchema(info).safeParse(fixture).success).toBe(false);
    });
  }
});
