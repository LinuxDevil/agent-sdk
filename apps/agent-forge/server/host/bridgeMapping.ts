/**
 * bridgeMapping: the pure pieces `BridgeAgentHost` composes - push →
 * `HostEvent` translation, spec `{ secret }` ref collection, and the
 * provider-key env a bridge run needs.
 *
 * `secretsFor` walks the whole spec JSON (not a typed traversal) because
 * `{ secret: '<name>' }` refs can appear anywhere a spec value allows a
 * secret - tool args, hook config, memory sources - and the bridge
 * resolves them by name in the project, so Studio ships exactly the
 * names the spec mentions, nothing more.
 */
import type { AgentSpecV2, BridgePush, BridgePushData } from 'lousho';
import type { HostEvent, HostRunResult } from './agentHost';
import type { SecretsStore } from '../secretsStore';

/** Translates one bridge push into the `HostEvent` RunManager consumes. */
export function toHostEvent(push: BridgePush): HostEvent {
  switch (push.event) {
    case 'agent':
      return { type: 'agent', event: push.data as BridgePushData['agent'] };
    case 'span.start':
      return { type: 'span', phase: 'start', span: push.data as BridgePushData['span.start'] };
    case 'span.end':
      return { type: 'span', phase: 'end', span: push.data as BridgePushData['span.end'] };
    case 'steer.joined': {
      const data = push.data as BridgePushData['steer.joined'];
      return { type: 'steer.joined', steerId: data.steerId, joined: data.joined };
    }
    case 'run.settled':
      return { type: 'settled', result: push.data as HostRunResult };
    case 'run.failed':
      return { type: 'failed', error: push.data as BridgePushData['run.failed'] };
  }
}

/** Every `{ secret: '<name>' }` ref in the spec, resolved through the workspace's SecretsStore. */
export function secretsFor(spec: AgentSpecV2, secretsStore: SecretsStore): Record<string, string> | undefined {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'secret' && typeof record.secret === 'string') {
      names.add(record.secret);
      return;
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(spec);
  if (names.size === 0) return undefined;
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = secretsStore.getSecret(name);
    if (value !== undefined) secrets[name] = value;
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/**
 * The provider API keys a bridge run needs in `env`: the two providers
 * Studio stores keys for, without `undefined` entries (the bridge's env
 * schema rejects empty values).
 */
export function providerEnv(secretsStore: SecretsStore): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const openai = secretsStore.getKey('openai');
  const anthropic = secretsStore.getKey('anthropic');
  if (openai !== undefined) env.OPENAI_API_KEY = openai;
  if (anthropic !== undefined) env.ANTHROPIC_API_KEY = anthropic;
  return Object.keys(env).length > 0 ? env : undefined;
}
