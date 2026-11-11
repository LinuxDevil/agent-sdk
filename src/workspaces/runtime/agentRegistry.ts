import { SDKError } from '../../utils/sdkError';
import { parseAgentRef } from '../contracts/agentRefs';
import { compareVersions, isVersionRange, satisfiesVersionRange } from '../contracts/versionRange';
import type { RevisionId, WorkspaceSource } from '../source/types';
import type { AgentFiles } from './agentDirView';

/** One version of a global agent a registry found. */
export interface GlobalAgent extends AgentFiles {
  /** The agent's name, as in `global:<name>@<range>`. */
  name: string;
  /** The exact `x.y.z` version that satisfied the range. */
  version: string;
}

/** Answers `global:<name>@<range>` agent refs; the host injects one (F3.4). */
export interface GlobalAgentRegistry {
  /** The highest version of `name` that satisfies `range`, or `undefined` when none does; a name or range outside the ref grammar throws. */
  resolve(name: string, range: string): Promise<GlobalAgent | undefined>;
}

export interface AgentCandidate {
  version: string;
  load(): Promise<GlobalAgent | undefined>;
}

function isExactVersion(version: unknown): version is string {
  return typeof version === 'string' && /^\d/.test(version) && isVersionRange(version);
}

export function checkGlobalRef(name: string, range: string): void {
  const parsed = parseAgentRef(`global:${name}@${range}`);
  if (!parsed.ok) throw new SDKError(`global agent lookup '${name}@${range}': ${parsed.error}`, 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED');
}

export async function highestInRange(candidates: readonly AgentCandidate[], range: string): Promise<GlobalAgent | undefined> {
  const best = candidates
    .filter((candidate) => satisfiesVersionRange(candidate.version, range))
    .reduce<AgentCandidate | undefined>((top, candidate) => (top === undefined || compareVersions(candidate.version, top.version) > 0 ? candidate : top), undefined);
  return best?.load();
}

function versionField(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

export function folderCandidate(name: string, dir: string, files: Record<string, string>): AgentCandidate[] {
  const version = versionField(files['agent.json']);
  return isExactVersion(version) ? [{ version, load: async () => ({ format: 'dir', name, version, dir, files }) }] : [];
}

async function folderAt(source: WorkspaceSource, name: string, revision: RevisionId): Promise<AgentCandidate[]> {
  const dir = `agents/${name}`;
  const files: Record<string, string> = {};
  for (const path of await source.list(dir, { revision })) {
    const text = await source.read(path, { revision });
    if (text !== undefined) files[path.slice(dir.length + 1)] = text;
  }
  return folderCandidate(name, dir, files);
}

/** A global agent registry over a project tree held in a `WorkspaceSource`, such as a database source: `agents/<name>/` folders with a `version` in `agent.json`. */
export function sourceAgentRegistry(source: WorkspaceSource): GlobalAgentRegistry {
  return {
    async resolve(name, range) {
      checkGlobalRef(name, range);
      return highestInRange(await folderAt(source, name, await source.revision()), range);
    },
  };
}
