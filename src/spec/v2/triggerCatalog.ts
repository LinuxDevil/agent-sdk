/**
 * The trigger-type catalog (`listTriggerTypes()`): the five `spec.triggers`
 * kinds, each with a title and one-line description for the trigger node's
 * type picker, the draft-7 JSON Schema of its fields besides `id` and `type`
 * (`fieldsJsonSchema`, what the node's form renders), and the runtimes that
 * start it (`runsUnder`). Hand-written — the installed zod cannot convert
 * schemas at run time — and kept in step with the zod schema in
 * `triggers.ts` by the conformance test. Browser-safe: no `node:*` imports.
 */
import { CHANNEL_KINDS, type TriggerSpec } from './triggers';

/** One {@link listTriggerTypes} entry: a trigger type, its picker copy, the JSON Schema of its form fields and its runtimes. */
export interface TriggerTypeInfo {
  /** The `type` value a trigger entry writes. */
  type: TriggerSpec['type'];
  /** The picker's label, e.g. 'Schedule'. */
  title: string;
  /** One sentence: what makes a run start. */
  description: string;
  /** JSON Schema (draft 7) of the entry's fields besides `id` and `type`. */
  fieldsJsonSchema: Record<string, unknown>;
  /** The runtimes that start this trigger. */
  runsUnder: ReadonlyArray<'dev' | 'worker' | 'studio'>;
}

/** A SecretRef as JSON Schema: exactly `{ env: 'NAME' }` or `{ secret: 'name' }`, matching `secretRefSchema` in secrets.ts. */
const SECRET_REF_JSON_SCHEMA: Record<string, unknown> = {
  title: 'Secret',
  description: 'A reference to a secret: an environment variable or a name in the secrets store.',
  oneOf: [
    {
      type: 'object',
      properties: { env: { type: 'string', title: 'Environment variable', description: 'The variable holding the secret.' } },
      required: ['env'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        secret: { type: 'string', title: 'Secret name', description: 'The name in the secrets store (Settings → Secrets).' },
      },
      required: ['secret'],
      additionalProperties: false,
    },
  ],
};

const FILTER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'string',
  title: 'Filter',
  description: 'An optional safeExpression over the incoming event; a run starts only when it is true.',
};

const PROMPT_TEMPLATE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'string',
  title: 'Prompt template',
  description: 'The template rendered over the event to build the prompt the run starts with.',
  minLength: 1,
};

/** The catalog rows, in the order the picker lists them. */
const TRIGGER_TYPES: TriggerTypeInfo[] = [
  {
    type: 'chat',
    title: 'Chat',
    description: 'Runs when someone sends the agent a message in the test pane, a client or the HTTP API.',
    fieldsJsonSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    runsUnder: ['dev', 'worker', 'studio'],
  },
  {
    type: 'cron',
    title: 'Schedule',
    description: 'Runs the agent on a cron schedule with a fixed prompt.',
    fieldsJsonSchema: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          title: 'Cron expression',
          description: 'A 5-field cron expression, or a shortcut like @daily.',
          examples: ['0 9 * * MON-FRI'],
        },
        timezone: {
          type: 'string',
          title: 'Time zone',
          description: 'The IANA time zone the wall clock is read in, e.g. America/New_York. Default: the machine zone.',
        },
        prompt: {
          type: 'string',
          title: 'Prompt',
          description: 'The message sent to the agent every time the schedule fires.',
          minLength: 1,
        },
        sharedSession: {
          type: 'boolean',
          title: 'Shared session',
          description: 'When true, every run of this trigger continues the same conversation.',
        },
      },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
    runsUnder: ['dev', 'worker', 'studio'],
  },
  {
    type: 'webhook',
    title: 'Webhook',
    description: 'Runs when an HTTP POST arrives at the path; the body fills the prompt template.',
    fieldsJsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          title: 'Path',
          description: 'The URL path the webhook listens on; POSTs to it start runs.',
          pattern: '^/[A-Za-z0-9/_-]{1,100}$',
        },
        secret: {
          ...SECRET_REF_JSON_SCHEMA,
          description: 'A SecretRef for the secret the request signature is verified against.',
        },
        promptTemplate: PROMPT_TEMPLATE_JSON_SCHEMA,
        filter: FILTER_JSON_SCHEMA,
      },
      required: ['path', 'promptTemplate'],
      additionalProperties: false,
    },
    runsUnder: ['studio'],
  },
  {
    type: 'channel',
    title: 'Channel',
    description: 'Runs on messages from Telegram, Slack, GitHub, Teams, Discord or plain HTTP.',
    fieldsJsonSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          title: 'Channel',
          description: 'The platform the agent listens on.',
          enum: [...CHANNEL_KINDS],
        },
        secrets: {
          type: 'object',
          title: 'Secrets',
          description: 'A SecretRef for every credential key the channel kind requires.',
          additionalProperties: SECRET_REF_JSON_SCHEMA,
        },
        filter: FILTER_JSON_SCHEMA,
      },
      required: ['channel', 'secrets'],
      additionalProperties: false,
    },
    runsUnder: ['studio'],
  },
  {
    type: 'agent',
    title: 'After another agent',
    description: "Runs when another agent's run finishes with the chosen status.",
    fieldsJsonSchema: {
      type: 'object',
      properties: {
        after: {
          type: 'string',
          title: 'After agent',
          description: 'The id of the agent whose finished run starts this one.',
          minLength: 1,
        },
        on: {
          type: 'string',
          title: 'On status',
          description: "The run status that fires the trigger: 'done', 'error' or 'any'.",
          enum: ['done', 'error', 'any'],
        },
        promptTemplate: {
          ...PROMPT_TEMPLATE_JSON_SCHEMA,
          description: 'The template rendered over the finished run to build the prompt the run starts with.',
        },
      },
      required: ['after', 'on', 'promptTemplate'],
      additionalProperties: false,
    },
    runsUnder: ['studio'],
  },
];

/**
 * The trigger types a spec may carry, in picker order (chat, cron, webhook,
 * channel, agent). A fresh deep copy each call, so a form may edit the
 * returned schemas. Studio serves it from the catalog route (D09) and the
 * Author's `listTriggerTypes` tool reads it.
 */
export function listTriggerTypes(): TriggerTypeInfo[] {
  return structuredClone(TRIGGER_TYPES);
}
