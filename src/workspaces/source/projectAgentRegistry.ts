import { agentFolderAt, highestInRange, type GlobalAgent, type GlobalAgentRegistry } from '../runtime/agentRegistry';
import { readText, realRoot } from './folderFs';
import { folderSource } from './folderSource';
import { SOURCE_DIR } from './revision';

const STUDIO_DIR = `${SOURCE_DIR}/agents`;

const MAX_BYTES = 1024 * 1024;

function latestStudioVersion(index: string | undefined): number | undefined {
  const numbers = (index ?? '').split('\n').flatMap((line) => {
    try {
      const value = (JSON.parse(line) as { version?: unknown }).version;
      return Number.isInteger(value) && (value as number) > 0 ? [value as number] : [];
    } catch {
      return [];
    }
  });
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

async function studioAgent(root: string, name: string): Promise<GlobalAgent | undefined> {
  const file = `${STUDIO_DIR}/${name}.yaml`;
  const text = await readText(root, file, MAX_BYTES);
  const latest = text === undefined ? undefined : latestStudioVersion(await readText(root, `${STUDIO_DIR}/${name}/versions/index.jsonl`, MAX_BYTES));
  if (text === undefined || latest === undefined) return undefined;
  return { format: 'studio', name, version: `${latest}.0.0`, dir: file, files: { [`${name}.yaml`]: text } };
}

/** The default global agent registry over a project folder: `<root>/agents/<name>/` folders with a `version` in `agent.json`, and Studio YAML agents `<root>/.lousho/agents/<name>.yaml` whose latest Studio version `n` counts as `n.0.0`. It only reads. */
export function projectAgentRegistry(root: string): GlobalAgentRegistry {
  const source = folderSource(root);
  return {
    async resolve(name, range) {
      const folder = await agentFolderAt(source, name, await source.revision());
      const studio = await studioAgent(await realRoot(root), name);
      return highestInRange([folder, studio].filter((item): item is GlobalAgent => item !== undefined), range);
    },
  };
}
