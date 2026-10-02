/**
 * Agent fingerprint (LOU-W9.2): a short, stable summary of the run-relevant
 * parts of an agent, saved in every checkpoint and approval snapshot. A resume
 * compares it with the resuming agent's, so a deploy that renamed a tool or
 * changed the model is noticed instead of silently continuing the old run.
 */

import type { LLMProvider } from '../providers';
import type { ToolRegistry } from '../tools';
import { getToolInputSchema } from '../tools/toolContract';
import type { AgentConfig } from '../types';
import type { HostedTool } from '../tools/hosted';
import { stableStringify } from '../testing/fingerprint';
import { SDKError } from './errors';

/** What a resume does when the agent is not the one that paused: warn (default), refuse, or carry on. */
export type AgentDriftMode = 'warn' | 'error' | 'ignore';

/** Version of the fingerprint's inputs; fingerprints of different versions are not compared. */
const FINGERPRINT_VERSION = 1;

/**
 * The run-relevant, serializable parts of an agent: the resolved model id,
 * each tool's name with a hash of its JSON input schema, and a hash of the
 * system instructions. Functions and other non-serializable values (a tool's
 * `execute`, hooks, callbacks) are ignored, so changing only code does not
 * change the fingerprint. The parts are stored individually so a mismatch can
 * say what changed.
 */
export interface AgentFingerprint {
  version: number;
  /** Short hash over all the parts below. */
  hash: string;
  /** The model the agent calls (`agent.settings.model`, else the provider's default); absent when unknown. */
  model?: string;
  /** Tool name to the hash of its input schema. */
  tools: Record<string, string>;
  /** Hash of the system instructions. */
  instructions: string;
}

/** What differs between the agent that paused a run and the one resuming it; see `agent.drift`. */
export interface AgentDrift {
  /** The model changed; either side is absent when it was unknown. */
  model?: { from?: string; to?: string };
  toolsAdded: string[];
  toolsRemoved: string[];
  /** Tools with the same name whose input schema changed. */
  toolsChanged: string[];
  /** The system instructions changed. */
  instructions: boolean;
}

/** A 64-bit prefix of the SHA-256 of `text`, as 16 hex characters (Web Crypto, no `node:*`). */
async function shortHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The fingerprint of `agent` (as configured, before skills or sub-agents) running on `provider` with `toolRegistry`.
 * N1a: hosted tools count as tools, hashed by their type and options, so a resume with another set reports drift.
 */
export async function fingerprintOf(
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined,
  provider: LLMProvider,
  hostedTools: readonly HostedTool[] = []
): Promise<AgentFingerprint> {
  const model: string | undefined = agent.settings?.model || provider.defaultModel;
  const tools: Record<string, string> = {};
  for (const name of Object.keys(agent.tools ?? {}).sort()) {
    const descriptor = toolRegistry?.get(name);
    if (descriptor?.tool) tools[name] = await shortHash(stableStringify(getToolInputSchema(descriptor) ?? {}));
  }
  for (const tool of [...hostedTools].sort((a, b) => a.name.localeCompare(b.name))) {
    tools[tool.name] = await shortHash(stableStringify({ hosted: tool.type, options: tool.options }));
  }
  const instructions = await shortHash(agent.prompt ?? '');
  const hash = await shortHash(stableStringify({ version: FINGERPRINT_VERSION, model, tools, instructions }));
  return { version: FINGERPRINT_VERSION, hash, ...(model !== undefined && { model }), tools, instructions };
}

/** What differs between `saved` and `current`, or `undefined` when nothing does (or they cannot be compared). */
function driftOf(saved: AgentFingerprint, current: AgentFingerprint): AgentDrift | undefined {
  if (saved.version !== current.version || saved.hash === current.hash) return undefined;
  const names = (fingerprint: AgentFingerprint) => Object.keys(fingerprint.tools);
  const drift: AgentDrift = {
    toolsAdded: names(current).filter((name) => !(name in saved.tools)),
    toolsRemoved: names(saved).filter((name) => !(name in current.tools)),
    toolsChanged: names(current).filter((name) => name in saved.tools && saved.tools[name] !== current.tools[name]),
    instructions: saved.instructions !== current.instructions,
  };
  if (saved.model !== current.model) {
    drift.model = { ...(saved.model !== undefined && { from: saved.model }), ...(current.model !== undefined && { to: current.model }) };
  }
  return drift;
}

/** The drift as one line, e.g. `model gpt-4o -> gpt-5, tools removed: lookup`. */
function describeDrift(drift: AgentDrift): string {
  const parts = [
    drift.model && `model ${drift.model.from ?? 'unknown'} -> ${drift.model.to ?? 'unknown'}`,
    drift.toolsAdded.length > 0 && `tools added: ${drift.toolsAdded.join(', ')}`,
    drift.toolsRemoved.length > 0 && `tools removed: ${drift.toolsRemoved.join(', ')}`,
    drift.toolsChanged.length > 0 && `tools changed (input schema): ${drift.toolsChanged.join(', ')}`,
    drift.instructions && 'instructions changed',
  ];
  return parts.filter(Boolean).join('; ');
}

/** What a resume compares: the saved fingerprint, the resuming agent's, and the tools the run still has to call. */
export interface DriftCheck {
  saved: AgentFingerprint;
  current: AgentFingerprint;
  mode: AgentDriftMode | undefined;
  /** Names of pending tool calls whose tool the resuming agent does not have. */
  missingTools: string[];
}

/**
 * Applies `onAgentDrift` to a resume: a pending call whose tool is gone is
 * always `LOUSHO_RESUME_TOOL_MISSING`; other drift is `LOUSHO_AGENT_DRIFT`
 * with `'error'`, a `console.warn` with `'warn'` (the default), nothing with
 * `'ignore'`. Returns the drift a caller reports as an `agent.drift` event.
 */
export function checkAgentDrift({ saved, current, mode = 'warn', missingTools }: DriftCheck): AgentDrift | undefined {
  const drift = driftOf(saved, current);
  if (missingTools.length > 0) {
    const what = drift ? ` (${describeDrift(drift)})` : '';
    throw new SDKError(
      `The run is waiting on a call to ${missingTools.map((name) => `'${name}'`).join(', ')}, but the resuming agent has no such tool${what}.`,
      'LOUSHO_RESUME_TOOL_MISSING'
    );
  }
  if (!drift || mode === 'ignore') return undefined;
  const message = `The agent resuming this run is not the one that paused it: ${describeDrift(drift)}.`;
  if (mode === 'error') throw new SDKError(message, 'LOUSHO_AGENT_DRIFT');
  console.warn(`[lousho] ${message} Continuing (onAgentDrift: 'warn').`);
  return drift;
}
