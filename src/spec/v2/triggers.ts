/**
 * The `spec.triggers` section of AgentSpec v2: the ways a run starts other
 * than a direct `agent.chat()` call. One entry is a strict discriminated
 * union on `type`: `chat` (a message in the test pane, a client or the HTTP
 * API), `cron` (a schedule with a fixed prompt), `webhook` (an HTTP POST on
 * `path`), `channel` (messages from a chat platform) and `agent` (a chain
 * trigger fired when another agent's run ends). Which kind runs where is a
 * host decision — `triggersFromSpec` (S22b) starts cron under `lousho dev`,
 * Studio's trigger host runs the rest — the schema only validates the data.
 * Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { CronExpressionError, parseCronExpression } from '../../triggers/cronExpression';
import { anyError, typeErrors } from '../../utils/zodCompat';
import { refineUniqueIds, specIdSchema } from './common';
import { secretRefSchema, type SecretRef } from './secrets';

/** The channel kinds a `channel` trigger may name: the platforms `src/channels/` ships factories for. */
export const CHANNEL_KINDS = ['telegram', 'slack', 'github', 'teams', 'discord', 'http'] as const;

/** A {@link CHANNEL_KINDS} entry. */
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * One `spec.triggers` entry: `id` is its `trigger:<id>` canvas node id. `chat`
 * needs no fields; `cron` carries a cron expression, an optional IANA
 * `timezone`, the fixed `prompt` and `sharedSession` (reuse one conversation
 * across fires); `webhook` a `path`, an optional HMAC `secret`, the
 * `promptTemplate` the request body fills and an optional `filter`
 * safeExpression; `channel` the platform and the SecretRefs its factory
 * needs; `agent` the agent id whose run ending (`on`) starts this one.
 */
export type TriggerSpec =
  | { id: string; type: 'chat' }
  | { id: string; type: 'cron'; cron: string; timezone?: string; prompt: string; sharedSession?: boolean }
  | { id: string; type: 'webhook'; path: string; secret?: SecretRef; promptTemplate: string; filter?: string }
  | { id: string; type: 'channel'; channel: ChannelKind; secrets: Record<string, SecretRef>; filter?: string }
  | { id: string; type: 'agent'; after: string; on: 'done' | 'error' | 'any'; promptTemplate: string };

/**
 * The `secrets` keys each channel kind must carry — the credential option
 * names of `src/channels/`'s factories (`githubChannel` also needs `botName`,
 * which is not a secret: the trigger host supplies it, e.g. the spec name).
 */
export const CHANNEL_SECRET_KEYS: Readonly<Record<ChannelKind, readonly string[]>> = {
  telegram: ['botToken', 'secretToken'],
  slack: ['signingSecret', 'botToken'],
  github: ['webhookSecret', 'token'],
  teams: ['appId', 'appPassword'],
  discord: ['publicKey', 'applicationId'],
  http: [],
};

const requiredString = z.string(typeErrors({ required: 'is required', invalid: 'must be a string' }));
const nonEmptyString = requiredString.min(1, 'must not be empty');
const optionalString = z.string(typeErrors({ invalid: 'must be a string' })).optional();

const chatTrigger = z
  .object({
    id: specIdSchema,
    type: z.literal('chat'),
  })
  .strict();

const cronTrigger = z
  .object({
    id: specIdSchema,
    type: z.literal('cron'),
    cron: nonEmptyString,
    timezone: optionalString,
    prompt: nonEmptyString,
    sharedSession: z.boolean().optional(),
  })
  .strict();

const webhookTrigger = z
  .object({
    id: specIdSchema,
    type: z.literal('webhook'),
    path: nonEmptyString.regex(
      /^\/[A-Za-z0-9/_-]{1,100}$/,
      "must be a '/'-path of 2-101 characters: letters, digits, '/', '_' or '-'"
    ),
    secret: secretRefSchema.optional(),
    promptTemplate: nonEmptyString,
    filter: optionalString,
  })
  .strict();

const channelTrigger = z
  .object({
    id: specIdSchema,
    type: z.literal('channel'),
    channel: z.enum(CHANNEL_KINDS, anyError("must be 'telegram', 'slack', 'github', 'teams', 'discord' or 'http'")),
    secrets: z.record(z.string(), secretRefSchema),
    filter: optionalString,
  })
  .strict();

const agentTrigger = z
  .object({
    id: specIdSchema,
    type: z.literal('agent'),
    after: nonEmptyString,
    on: z.enum(['done', 'error', 'any'], anyError("must be 'done', 'error' or 'any'")),
    promptTemplate: nonEmptyString,
  })
  .strict();

const triggerUnion = z.discriminatedUnion('type', [chatTrigger, cronTrigger, webhookTrigger, channelTrigger, agentTrigger]);

/**
 * A cron trigger's `timezone` must be an IANA name `Intl` knows, and `cron`
 * must parse under it. The zone is checked first so a bad one is reported at
 * `timezone`, not as a `cron` problem.
 */
function checkCron(trigger: { cron: string; timezone?: string }, ctx: z.RefinementCtx): void {
  let timezone = trigger.timezone;
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown time zone '${timezone}'`, path: ['timezone'] });
      timezone = undefined;
    }
  }
  try {
    parseCronExpression(trigger.cron, timezone);
  } catch (error) {
    if (error instanceof CronExpressionError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: ['cron'] });
    } else {
      throw error;
    }
  }
}

/** A channel trigger's `secrets` must hold a SecretRef for every key {@link CHANNEL_SECRET_KEYS} requires. */
function checkChannelSecrets(trigger: { channel: ChannelKind; secrets: Record<string, SecretRef> }, ctx: z.RefinementCtx): void {
  for (const key of CHANNEL_SECRET_KEYS[trigger.channel]) {
    if (!(key in trigger.secrets)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'${trigger.channel}' needs secrets.${key}`,
        path: ['secrets', key],
      });
    }
  }
}

/**
 * One `spec.triggers` entry (zod): a strict discriminated union on `type`,
 * plus the checks the fields alone cannot express (a cron expression that
 * parses under `timezone`, a channel's required secret keys).
 */
export const triggerSpecSchema: z.ZodType<TriggerSpec> = triggerUnion.superRefine((value, ctx) => {
  if (value.type === 'cron') checkCron(value, ctx);
  if (value.type === 'channel') checkChannelSecrets(value, ctx);
});

/** The list rules a per-entry schema cannot see: at most one `chat`, webhook paths unique. */
function checkTriggerList(triggers: readonly TriggerSpec[], ctx: z.RefinementCtx): void {
  let chatSeen = false;
  const webhookPaths = new Set<string>();
  for (let index = 0; index < triggers.length; index++) {
    const trigger = triggers[index];
    if (trigger.type === 'chat') {
      if (chatSeen) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only one chat trigger', path: [index] });
      chatSeen = true;
    }
    if (trigger.type === 'webhook') {
      if (webhookPaths.has(trigger.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate webhook path '${trigger.path}'`,
          path: [index, 'path'],
        });
      } else {
        webhookPaths.add(trigger.path);
      }
    }
  }
}

/** The `spec.triggers` list (zod): unique `id`s, at most one `chat` trigger, unique webhook paths. */
export const triggerListSchema = z.array(triggerSpecSchema).superRefine((triggers, ctx) => {
  refineUniqueIds(triggers, ctx);
  checkTriggerList(triggers, ctx);
});
