import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workerMissingPeerPlugin } from './bundle';
import { loadOptionalPeer, MissingPeerDependencyError } from '../providers/optionalPeer';

const ENTRY = "export const load = () => import('@ai-sdk/anthropic');\nexport const mcp = () => import('@modelcontextprotocol/sdk/client/streamableHttp.js');\n";

async function bundle(resolveDir: string): Promise<string> {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    plugins: [workerMissingPeerPlugin()],
  });
  return result.outputFiles[0]!.text;
}

describe('workerMissingPeerPlugin (cloudflare-worker build)', () => {
  it('turns a provider / MCP package that is not installed into a lazy "Cannot find package" module', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-missing-peer-'));
    try {
      const code = await bundle(dir);
      const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
        load: () => Promise<unknown>;
        mcp: () => Promise<unknown>;
      };
      // Importing the module is fine; only the lazy import fails, with the coded missing-peer error.
      await expect(loadOptionalPeer('@ai-sdk/anthropic', mod.load)).rejects.toBeInstanceOf(MissingPeerDependencyError);
      await expect(loadOptionalPeer('@modelcontextprotocol/sdk', mod.mcp)).rejects.toBeInstanceOf(MissingPeerDependencyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bundles an installed one as before', async () => {
    const code = await bundle(path.resolve(__dirname, '..', '..'));
    expect(code).not.toContain('it was not installed when this Worker was built');
    expect(code).toContain('createAnthropic');
  });
});
