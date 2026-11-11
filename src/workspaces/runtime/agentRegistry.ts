import { satisfiesRange } from '../../cli/versionRange';
import { isVersionRange } from '../contracts/versionRange';
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
  /** The highest version of `name` that satisfies `range`, or `undefined` when none does. */
  resolve(name: string, range: string): Promise<GlobalAgent | undefined>;
}

const EXACT = /^\d/;

/** True when `version` is an exact `x.y.z` the ref grammar accepts. */
function isExactVersion(version: unknown): version is string {
  return typeof version === 'string' && EXACT.test(version) && isVersionRange(version);
}

/** The highest candidate whose version satisfies `range`; an earlier candidate wins a tie. */
export function highestInRange<T extends { version: string }>(candidates: readonly T[], range: string): T | undefined {
  return candidates
    .filter((candidate) => satisfiesRange(candidate.version, range))
    .reduce<T | undefined>((best, candidate) => (best === undefined || !satisfiesRange(best.version, `>=${candidate.version}`) ? candidate : best), undefined);
}

function versionOf(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

/** Reads `agents/<name>/` of `source` at one revision, as an agent folder with its `agent.json` version, or `undefined` when it has no exact version. */
export async function agentFolderAt(source: WorkspaceSource, name: string, revision: RevisionId): Promise<GlobalAgent | undefined> {
  const dir = `agents/${name}`;
  const files: Record<string, string> = {};
  for (const path of await source.list(dir, { revision })) {
    const text = await source.read(path, { revision });
    if (text !== undefined) files[path.slice(dir.length + 1)] = text;
  }
  const version = versionOf(files['agent.json']);
  return isExactVersion(version) ? { format: 'dir', name, version, dir, files } : undefined;
}

/** A global agent registry over a project tree held in a `WorkspaceSource`, such as a database source: `agents/<name>/` folders with a `version` in `agent.json`. */
export function sourceAgentRegistry(source: WorkspaceSource): GlobalAgentRegistry {
  return {
    async resolve(name, range) {
      const found = await agentFolderAt(source, name, await source.revision());
      return found === undefined ? undefined : highestInRange([found], range);
    },
  };
}
