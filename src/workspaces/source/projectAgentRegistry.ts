import { checkGlobalRef, folderCandidate, highestInRange, type AgentCandidate, type GlobalAgentRegistry } from '../runtime/agentRegistry';
import { readFolderSubtree, readText, realRoot, type FolderLimits } from './folderFs';
import { SOURCE_DIR } from './revision';

const STUDIO_DIR = `${SOURCE_DIR}/agents`;

const LIMITS: FolderLimits = { maxFileBytes: 1024 * 1024, maxFiles: 500, maxTreeBytes: 8 * 1024 * 1024 };

function parseLine(line: string): unknown {
  try {
    return (JSON.parse(line) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

function studioVersions(index: string | undefined): number[] {
  const numbers = (index ?? '').split('\n').map(parseLine);
  return [...new Set(numbers.filter((value): value is number => Number.isInteger(value) && (value as number) > 0))];
}

function snapshotSpec(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as { snapshot?: { spec?: unknown } }).snapshot?.spec;
  } catch {
    return undefined;
  }
}

function studioCandidate(root: string, name: string, version: number): AgentCandidate {
  const dir = `${STUDIO_DIR}/${name}/versions/${String(version).padStart(6, '0')}.json`;
  return {
    version: `${version}.0.0`,
    async load() {
      const spec = snapshotSpec(await readText(root, dir, LIMITS.maxFileBytes));
      return spec === undefined ? undefined : { format: 'studio', name, version: `${version}.0.0`, dir, files: { 'spec.json': JSON.stringify(spec) } };
    },
  };
}

async function studioCandidates(root: string, name: string): Promise<AgentCandidate[]> {
  const index = await readText(root, `${STUDIO_DIR}/${name}/versions/index.jsonl`, LIMITS.maxTreeBytes);
  return studioVersions(index).map((version) => studioCandidate(root, name, version));
}

async function folderCandidates(root: string, name: string): Promise<AgentCandidate[]> {
  const dir = `agents/${name}`;
  const files = await readFolderSubtree(root, dir, LIMITS);
  return folderCandidate(name, dir, Object.fromEntries([...files].map(([path, text]) => [path.slice(dir.length + 1), text])));
}

/** The default global agent registry over a project folder: `<root>/agents/<name>/` folders with a `version` in `agent.json`, and Studio agents, whose saved Studio version `n` (`.lousho/agents/<name>/versions/`) counts as `n.0.0` and is served from that version's snapshot. It only reads, and only the named agent's files. */
export function projectAgentRegistry(root: string): GlobalAgentRegistry {
  return {
    async resolve(name, range) {
      checkGlobalRef(name, range);
      const dir = await realRoot(root);
      return highestInRange([...(await folderCandidates(dir, name)), ...(await studioCandidates(dir, name))], range);
    },
  };
}
