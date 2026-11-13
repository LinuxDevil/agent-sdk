import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Check } from '../evals/checks';
import { resolveProvider } from '../providers';
import { fileHostBackend } from '../workspaces/runtime/backends';
import { checkRegistry } from '../workspaces/runtime/checks';
import { fileArtifactStore } from '../workspaces/runtime/fileArtifactStore';
import { globalProfiles } from '../workspaces/runtime/profileStore';
import { projectAgentRegistry } from '../workspaces/source/projectAgentRegistry';
import { createWorkspaceStores } from '../workspaces/runtime/stores';
import type { HostToolRegistry } from '../workspaces/runtime/policy';
import type { PolicyCeiling } from '../workspaces/contracts/policy';
import type { ProviderResolver, WorkspaceHost } from '../workspaces/runtime/workspaceHost';
import { OUTPUT_CHECK_NAME } from './workspaceTemplates';

export interface CliHostOptions {
  providers?: ProviderResolver;
  project?: string;
  hostModule?: string;
}

interface HostModule {
  tools?: HostToolRegistry;
  checks?: Record<string, Check<unknown>>;
  policyCeiling?: PolicyCeiling;
}

const CEILING: PolicyCeiling = { permissions: [], tools: { allow: ['*'] }, secrets: [] };

const outputPresent: Check<unknown> = {
  evaluate: (output) => {
    const values = typeof output === 'object' && output !== null ? Object.values(output) : [output];
    const passed = values.some((value) => typeof value === 'string' && value.trim().length > 0);
    return { score: passed ? 1 : 0, passed, threshold: 1, message: passed ? undefined : 'output has no non-empty text field' };
  },
};

async function loadHostModule(file: string | undefined): Promise<HostModule> {
  if (file === undefined) return {};
  return (await import(pathToFileURL(path.resolve(file)).href)) as HostModule;
}

export async function cliHost(dir: string, options: CliHostOptions = {}): Promise<WorkspaceHost> {
  const root = path.resolve(dir);
  const mod = await loadHostModule(options.hostModule);
  const base = options.providers ?? { resolve: (ref: string) => resolveProvider(ref) };
  const stores = createWorkspaceStores(fileHostBackend(path.join(root, '.lousho', 'host')), { projectId: 'default', workspaceId: path.basename(root) });
  return {
    tools: mod.tools ?? {},
    policyCeiling: mod.policyCeiling ?? CEILING,
    providers: base,
    secrets: { resolve: async (ref) => ('env' in ref ? process.env[ref.env] : undefined) },
    stores: { ...stores, artifacts: fileArtifactStore(path.join(root, '.lousho', 'artifacts')) },
    globals: {
      agents: options.project === undefined ? { resolve: async () => undefined } : projectAgentRegistry(path.resolve(options.project)),
      profiles: globalProfiles(() => undefined),
    },
    checks: checkRegistry({ [OUTPUT_CHECK_NAME]: outputPresent, ...mod.checks }),
  };
}
