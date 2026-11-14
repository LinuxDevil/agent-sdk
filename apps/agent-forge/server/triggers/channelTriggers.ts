/**
 * Channel triggers (R08b, PLAN §3.1/§15): a `{ type: 'channel' }` trigger
 * makes Studio serve that chat platform at
 * `POST /hooks/<agentId>/channel/<kind>` through the SDK's own channel
 * implementation (`mountChannels` + the per-platform factories), so
 * signature verification, session handling, replies and approval buttons
 * behave exactly as under `lousho dev`.
 *
 * Per agent, all its channel triggers mount under one
 * `mountChannels(agent, channels, { basePath })` handler; channel names
 * are the platform kinds, so two triggers of one kind on an agent are an
 * error ("Only one telegram channel per agent") and only the first is
 * served.
 *
 * The Express middleware buffers the raw body itself (the SDK handler
 * reads the stream, so this route must run BEFORE app.ts's
 * `express.raw` on `/hooks`), evaluates the spec's abort listeners and
 * the trigger's `filter` on `{ channel, headers, body }`, then replays
 * the exact bytes to the SDK handler - platform signatures are checked
 * over those bytes inside the SDK.
 *
 * Channel turns run through `agent.session()` inside the SDK: they land
 * in traces (the file + observe exporters `buildAgent` wires) but not in
 * the test pane, the per-agent trigger queue or the failure streak.
 */
import { Readable } from 'node:stream';
import type * as http from 'node:http';

import type { Request, Response, NextFunction } from 'express';
import {
  discordChannel,
  githubChannel,
  httpChannel,
  mountChannels,
  slackChannel,
  teamsChannel,
  telegramChannel,
  type AgentSpecV2,
  type Channel,
  type ChannelsHandler,
  type SimpleAgent,
} from '@linuxdevil/lousho';
import type { SecretRef, TriggerSpec } from '@linuxdevil/lousho/spec';
import { evaluateSafeExpression } from '@linuxdevil/lousho/flows';

import type { ChannelTriggerStatus } from '../../shared/wireTypes';
import type { AgentRepo } from '../storage/agentRepo';
import { applyAbortListeners } from './abortListeners';
import type { TriggerHost } from './triggerHost';

export type ChannelKind = Extract<TriggerSpec, { type: 'channel' }>['channel'];

/** A `channel` trigger entry. */
export type ChannelTrigger = Extract<TriggerSpec, { type: 'channel' }>;

/**
 * Option keys each factory takes from `trigger.secrets` (values resolved
 * to strings). `required` mirrors the SDK spec schema's own
 * `CHANNEL_SECRET_KEYS` (src/spec/v2/triggers.ts - `writeSpec` already
 * refuses a spec missing those keys, so a miss here means the SecretRef
 * did not resolve); `optional` are factory options the schema does not
 * require. `github.botName` is the odd one: it names the bot, not a
 * credential, so the host supplies the spec's `name` when `secrets`
 * carries no `botName` ref.
 */
export const CHANNEL_SECRET_KEYS: Record<ChannelKind, { required: string[]; optional: string[] }> = {
  telegram: { required: ['botToken', 'secretToken'], optional: ['botUsername'] },
  slack: { required: ['signingSecret', 'botToken'], optional: [] },
  github: { required: ['webhookSecret', 'token', 'botName'], optional: ['botLogin'] },
  teams: { required: ['appId', 'appPassword'], optional: ['tenantId'] },
  discord: { required: ['publicKey', 'applicationId'], optional: ['botToken'] },
  http: { required: [], optional: [] },
};

/** Resolves a SecretRef (or a plain string, which passes through) to its value; `undefined` when unset. */
export type SecretResolver = (ref: SecretRef | string) => string | undefined;

/**
 * Resolves every required+optional key of {@link CHANNEL_SECRET_KEYS} for
 * one trigger. The first required miss returns `{ error: "Channel <kind>
 * needs <key>" }`; optional misses are simply absent from the map.
 * `github.botName` falls back to `specName` (it names the bot, not a
 * credential).
 */
function collectSecretValues(
  trigger: ChannelTrigger,
  resolve: SecretResolver,
  specName?: string
): { values: Map<string, string> } | { error: string } {
  const keys = CHANNEL_SECRET_KEYS[trigger.channel];
  const values = new Map<string, string>();
  for (const key of [...keys.required, ...keys.optional]) {
    const ref = trigger.secrets?.[key];
    const isRequired = keys.required.includes(key);
    if (ref === undefined && isRequired && trigger.channel === 'github' && key === 'botName' && specName !== undefined) {
      values.set(key, specName);
      continue;
    }
    if (ref === undefined) {
      if (isRequired) return { error: `Channel ${trigger.channel} needs ${key}` };
      continue;
    }
    const value = resolve(ref);
    if (value === undefined || value === '') {
      if (isRequired) return { error: `Channel ${trigger.channel} needs ${key}` };
      continue;
    }
    values.set(key, value);
  }
  return { values };
}

/**
 * Builds the SDK `Channel` for one channel trigger. Every required key of
 * {@link CHANNEL_SECRET_KEYS} must resolve (github's `botName` falls back
 * to `specName`); the first miss returns `{ error: "Channel <kind> needs
 * <key>" }`. Optional keys that do not resolve are simply absent.
 */
export function channelFromTrigger(
  trigger: ChannelTrigger,
  resolve: SecretResolver,
  specName?: string
): { channel: Channel } | { error: string } {
  const collected = collectSecretValues(trigger, resolve, specName);
  if ('error' in collected) return collected;
  const { values } = collected;
  const v = (key: string): string => values.get(key) ?? '';
  const opt = (key: string): Record<string, string> => (values.has(key) ? { [key]: v(key) } : {});
  try {
    switch (trigger.channel) {
      case 'telegram':
        return {
          channel: telegramChannel({
            botToken: v('botToken'),
            secretToken: v('secretToken'),
            ...opt('botUsername'),
          }),
        };
      case 'slack':
        return { channel: slackChannel({ signingSecret: v('signingSecret'), botToken: v('botToken') }) };
      case 'github':
        return {
          channel: githubChannel({
            webhookSecret: v('webhookSecret'),
            botName: v('botName'),
            token: v('token'),
            ...opt('botLogin'),
          }),
        };
      case 'teams':
        return {
          channel: teamsChannel({ appId: v('appId'), appPassword: v('appPassword'), ...opt('tenantId') }),
        };
      case 'discord':
        return {
          channel: discordChannel({
            publicKey: v('publicKey'),
            applicationId: v('applicationId'),
            ...opt('botToken'),
          }),
        };
      case 'http':
        return { channel: httpChannel() };
    }
  } catch (error) {
    // A factory ConfigurationError (empty credential, bad option combo)
    // surfaces as this trigger's mount error, same as a missing secret.
    return { error: `Channel ${trigger.channel}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Builds every servable channel of one agent's channel triggers: the first
 * trigger of each kind wins (a second is an "Only one <kind> channel per
 * agent" error), a trigger whose secrets do not resolve or whose factory
 * rejects the options lands in `errors` under its id. Both outcomes are
 * logged once per mount.
 */
function collectAgentChannels(
  agentId: string,
  triggers: ChannelTrigger[],
  specName: string | undefined,
  deps: { resolve: SecretResolver; log: TriggerHost['log'] }
): { channels: Channel[]; errors: Map<string, string> } {
  const errors = new Map<string, string>();
  const seen = new Set<ChannelKind>();
  const channels: Channel[] = [];
  for (const trigger of triggers) {
    let error: string | undefined;
    if (seen.has(trigger.channel)) {
      error = `Only one ${trigger.channel} channel per agent`;
    } else {
      seen.add(trigger.channel);
      const made = channelFromTrigger(trigger, deps.resolve, specName);
      if ('channel' in made) {
        channels.push(made.channel);
        continue;
      }
      error = made.error;
    }
    errors.set(trigger.id, error);
    deps.log(agentId, `Channel trigger ${trigger.id}: ${error}`, 'warn');
  }
  return { channels, errors };
}

/** One agent's mounted channel surface. */
interface AgentMount {
  handler: ChannelsHandler;
  spec: AgentSpecV2;
  triggers: ChannelTrigger[];
}

/** `/hooks/<agentId>/channel/<name>` out of a request url; `undefined` for anything else. */
function channelRoute(url: string | undefined): { agentId: string; name: string } | undefined {
  const pathname = (url ?? '/').split('?')[0].split('#')[0];
  const match = /^\/hooks\/([^/]+)\/channel\/([^/?#]+)/.exec(pathname);
  if (match === null) return undefined;
  try {
    return { agentId: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

/** The request body as a Buffer, capped at the SDK's own 1 MB channel limit. */
function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += data.length;
      if (bytes <= limit) chunks.push(data);
    });
    req.on('end', () => {
      if (bytes > limit) {
        reject(new Error('Request body exceeds the 1MB channel limit'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** `body` parsed as JSON, or `null` for anything else (the abort/filter event's `body`). */
function jsonOrNull(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * A fresh `IncomingMessage` carrying `req`'s method/url/headers and
 * `body` as its stream content - the SDK channel handler reads the raw
 * stream for signature checks, so the buffered bytes must replay
 * exactly.
 */
function replayRequest(req: http.IncomingMessage, body: Buffer): http.IncomingMessage {
  const replay = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  replay.method = req.method;
  replay.url = req.url;
  replay.headers = req.headers;
  replay.httpVersion = req.httpVersion;
  replay.httpVersionMajor = req.httpVersionMajor;
  replay.httpVersionMinor = req.httpVersionMinor;
  process.nextTick(() => {
    replay.push(body);
    replay.push(null);
  });
  return replay;
}

export class ChannelTriggers {
  /** agentId -> its mounted channel handler. */
  private readonly mounts = new Map<string, AgentMount>();
  /** agentId -> the spec `status()` reports (kept even when nothing mounts). */
  private readonly specs = new Map<string, AgentSpecV2>();
  /** agentId -> triggerId -> mount error, reset on every mount. */
  private readonly errors = new Map<string, Map<string, string>>();
  /** Serializes mounts per agent so a reload during a build cannot interleave. */
  private readonly mounting = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      host: TriggerHost;
      repo: AgentRepo;
      /** Builds the agent a channel turn runs on (the working copy, rebuilt per mount). */
      buildAgent: (agentId: string) => Promise<SimpleAgent>;
      resolve: SecretResolver;
      log: TriggerHost['log'];
    }
  ) {}

  /**
   * (Re)mounts the channel triggers of one agent - called from
   * `TriggerHost.reload` on every spec change. A spec with no channel
   * triggers (or an unreadable one) unmounts; a build failure unmounts
   * too, logged, so a removed trigger is never served stale.
   */
  mount(agentId: string): Promise<void> {
    const prev = this.mounting.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => this.mountNow(agentId));
    this.mounting.set(
      agentId,
      next.catch(() => {})
    );
    return next;
  }

  private async mountNow(agentId: string): Promise<void> {
    const spec = (await this.deps.repo.readSpec(agentId).catch(() => undefined)) as AgentSpecV2 | undefined;
    if (spec === undefined) {
      this.specs.delete(agentId);
      this.mounts.delete(agentId);
      this.errors.delete(agentId);
      return;
    }
    this.specs.set(agentId, spec);
    const triggers = (spec.triggers ?? []).filter((t): t is ChannelTrigger => t.type === 'channel');
    if (triggers.length === 0) {
      this.mounts.delete(agentId);
      this.errors.delete(agentId);
      return;
    }

    const { channels, errors } = collectAgentChannels(agentId, triggers, spec.name, {
      resolve: this.deps.resolve,
      log: this.deps.log,
    });
    this.errors.set(agentId, errors);
    if (channels.length === 0) {
      this.mounts.delete(agentId);
      return;
    }

    let agent: SimpleAgent;
    try {
      agent = await this.deps.buildAgent(agentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(agentId, `Channel mount failed: ${message}`, 'error');
      // `errors` is already stored - surface the build failure on every
      // trigger that had no error of its own, so status() never shows a
      // served-looking row for a channel that is not mounted.
      for (const trigger of triggers) {
        if (!errors.has(trigger.id)) errors.set(trigger.id, `Channel mount failed: ${message}`);
      }
      this.mounts.delete(agentId);
      return;
    }
    const handler = mountChannels(agent, channels, {
      basePath: `/hooks/${agentId}/channel`,
      onError: (error, context) =>
        this.deps.log(
          agentId,
          `Channel ${context.channel} failed at ${context.stage}: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        ),
    });
    this.mounts.set(agentId, { handler, spec, triggers });
  }

  /**
   * Express middleware for `/hooks/:agentId/channel/*`: non-channel paths
   * `next()`; channel paths buffer the body, run abort listeners and the
   * trigger `filter`, then hand the replayed request to the SDK handler.
   */
  handler(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      void this.handle(req, res, next).catch(next);
    };
  }

  private async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    const route = channelRoute(req.url);
    if (route === undefined) {
      next();
      return;
    }
    const mount = this.mounts.get(route.agentId);
    const trigger = mount?.triggers.find((t) => t.channel === route.name);
    if (mount === undefined || trigger === undefined) {
      next();
      return;
    }

    // R09: a turned-off agent's channels answer 200 skipped so platforms
    // do not retry; the SDK handler (which would run the agent) is never
    // called, and abort listeners do not run either.
    if (!this.deps.host.isEnabled(route.agentId)) {
      res.status(200).json({ ok: true, skipped: 'disabled' });
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.status(413).json({ error: 'Request body exceeds the 1MB channel limit' });
      return;
    }

    // The event abort listeners and the filter see: channel kind, the
    // lower-cased header NAMES (values may carry secrets, so they are
    // never exposed) and the parsed JSON body (null when not JSON).
    const event = {
      channel: route.name,
      headers: Object.fromEntries(Object.keys(req.headers).map((h) => [h.toLowerCase(), true])),
      body: jsonOrNull(body),
    };
    applyAbortListeners({
      spec: mount.spec,
      agentId: route.agentId,
      triggerId: trigger.id,
      event,
      host: this.deps.host,
      log: this.deps.log,
    });
    if (trigger.filter !== undefined && evaluateSafeExpression(trigger.filter, { event }) !== true) {
      res.status(200).json({ ok: true, skipped: 'filter' });
      return;
    }

    // The SDK handler answers the request itself; `false` means the path
    // was not a channel route after all (e.g. a GET) - keep looking.
    const handled = await mount.handler(replayRequest(req, body), res);
    if (!handled) next();
  }

  /** This agent's channel triggers with their mount URL and error, for the Overview card. */
  status(agentId: string): ChannelTriggerStatus[] {
    const spec = this.specs.get(agentId);
    if (spec === undefined) return [];
    const errors = this.errors.get(agentId);
    return (spec.triggers ?? [])
      .filter((t): t is ChannelTrigger => t.type === 'channel')
      .map((t) => ({
        triggerId: t.id,
        channel: t.channel,
        url: `/hooks/${agentId}/channel/${t.channel}`,
        error: errors?.get(t.id) ?? null,
      }));
  }
}
