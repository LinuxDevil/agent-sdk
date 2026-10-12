/**
 * `lousho build`: warns when the provider package the agent's own provider
 * needs is not installed. The build itself succeeds without it (optional
 * peers stay lazy), but the built agent fails every request until the
 * package is installed where it runs (or, for a Worker, before building).
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listProviders, peerInstallCommand, type AiMajor } from '../providers/providerSpec';

const DATA_CONFIGS = ['agent.json', 'agent.yaml', 'agent.yml'];

function readData(file: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data: unknown = /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // the adapter reports an unreadable spec or config
  }
}

/**
 * The provider a spec file (`provider.type`) or an agent directory's
 * agent.json/agent.yaml (`provider`, or the prefix of `model`) names. A code
 * config (agent.ts) is not run for this, so it gives undefined.
 */
function agentProviderName(agentPath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(agentPath);
  } catch {
    return undefined;
  }
  if (stat.isFile()) {
    const type = (readData(agentPath)?.provider as { type?: unknown } | undefined)?.type;
    return typeof type === 'string' ? type : undefined;
  }
  const file = DATA_CONFIGS.map((name) => path.join(agentPath, name)).find((candidate) => fs.existsSync(candidate));
  const config = file === undefined ? undefined : readData(file);
  if (typeof config?.provider === 'string') return config.provider;
  return typeof config?.model === 'string' && config.model.includes('/') ? config.model.split('/')[0] : undefined;
}

function canResolve(req: NodeJS.Require, name: string): boolean {
  for (const specifier of [`${name}/package.json`, name]) {
    try {
      req.resolve(specifier);
      return true;
    } catch {
      // "exports" may hide one of the two specifiers: try the other
    }
  }
  return false;
}

/** The installed `ai` major as seen from `req`; 7 (what a fresh install gets) when it cannot be read. */
function aiMajor(req: NodeJS.Require): AiMajor {
  try {
    for (let dir = path.dirname(req.resolve('ai')); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (pkg.name !== 'ai') continue;
      const major = Number.parseInt(pkg.version ?? '', 10);
      return major === 4 || major === 6 ? major : 7;
    }
  } catch {
    // not installed: the default below
  }
  return 7;
}

/**
 * A warning when the agent at `agentPath` uses a built-in provider whose
 * package does not resolve from `resolveFrom` (the SDK's folder, where the
 * bundler resolves it), else undefined. `target` picks the advice: a
 * node-server or docker build declares the package in its own package.json,
 * a Worker bundles it at build time.
 */
export function missingProviderPeerWarning(agentPath: string, resolveFrom: string, target?: string): string | undefined {
  const name = agentProviderName(agentPath)?.toLowerCase();
  const info = listProviders().find((provider) => provider.name === name);
  if (!info) return undefined;
  const req = createRequire(path.join(resolveFrom, 'noop.js'));
  const major = aiMajor(req);
  const peer = info.peers[major].name;
  if (canResolve(req, peer)) return undefined;
  const missing = `Warning: the agent uses the '${info.name}' provider, but its package ${peer} is not installed here.`;
  if (target === 'docker') {
    return `${missing} The build's package.json lists it and the Docker image installs it; dist/server.js run without that install fails every request (LOUSHO_PEER_MISSING).`;
  }
  if (target === 'node-server') {
    return `${missing} The build's package.json lists it: run \`npm install\` in the build folder before \`node dist/server.js\`, or every request fails (LOUSHO_PEER_MISSING).`;
  }
  return (
    `${missing} The built agent would fail every request (LOUSHO_PEER_MISSING). ` +
    `Install it before building, or wherever the build runs: ${peerInstallCommand(peer, major)}`
  );
}
