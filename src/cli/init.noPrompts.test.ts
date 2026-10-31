import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissingPeerDependencyError } from '../providers/optionalPeer';
import { runInit } from './init';

// `npx lousho init` installs the SDK without its optional `prompts` peer.
vi.mock('./init/prompts', () => ({
  askMissing: async () => {
    throw new MissingPeerDependencyError('prompts', 'npm install prompts@^2.4.2', { feature: 'the interactive prompts of lousho init' });
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('lousho init on a terminal without the prompts package', () => {
  it('scaffolds from the flags and defaults and says how to choose', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-init-np-'));
    roots.push(root);
    const err: string[] = [];
    const code = await runInit(['demo', '--no-install', '--no-git'], {
      env: {},
      cwd: root,
      interactive: true,
      sdk: { version: '1.0.0-alpha.8', peerDependencies: { ai: '^4.3.19', zod: '^3.25.76' } },
      write: () => undefined,
      writeError: (text) => err.push(text),
      exec: async () => 0,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, 'demo', 'src', 'agent.ts'))).toBe(true);
    expect(err.join('')).toMatch(/optional 'prompts' package.*--provider and --template.*npm create lousho/);
  });
});
