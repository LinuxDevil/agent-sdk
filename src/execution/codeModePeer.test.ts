/**
 * N14: without the optional peer `quickjs-emscripten`, a codeMode run fails at
 * its start with MissingPeerDependencyError naming the package and the command.
 * The import is made to fail the way Node reports a missing package.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { MissingPeerDependencyError } from '../providers/optionalPeer';

vi.mock('../providers/optionalPeer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../providers/optionalPeer')>();
  const missing = (name: string) => Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
  return {
    ...real,
    loadOptionalPeer: <T>(name: string, importer: () => Promise<T>) =>
      name === 'quickjs-emscripten' ? real.loadOptionalPeer(name, () => Promise.reject(missing(name))) : real.loadOptionalPeer(name, importer),
  };
});

describe('code mode (N14): the optional peer', () => {
  it('codeMode: true fails the first run with MissingPeerDependencyError naming quickjs-emscripten', async () => {
    const model = mockModel(['never']);
    const agent = createAgent({ provider: model, codeMode: true });
    const error = await agent.send('hi').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingPeerDependencyError);
    expect(error).toMatchObject({ packageName: 'quickjs-emscripten', installCommand: 'npm install quickjs-emscripten@^0.32.0', feature: 'code mode (`createAgent({ codeMode })`)' });
    expect(model.calls).toHaveLength(0);
  });

  it('an agent without codeMode does not need it', async () => {
    await expect(createAgent({ provider: mockModel(['ok']) }).send('hi')).resolves.toMatchObject({ text: 'ok' });
  });
});
