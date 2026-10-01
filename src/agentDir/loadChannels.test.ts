import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadAgentDir, resolveAgentDir } from './index';
import { SDKError } from '../execution/errors';
import { mockModel } from '../testing';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);

describe('channels/ in an agent directory (LOU-P7.2)', () => {
  it('loads channels/*.ts: the name defaults to the file name, an explicit name wins', async () => {
    const { channels, manifest } = await resolveAgentDir(fixture('channels'), { provider: mockModel(['x']) });
    expect(channels.map((c) => c.name)).toEqual(['echo', 'webhook', 'custom-sms']);
    expect(manifest.channels).toEqual(['echo', 'webhook', 'custom-sms']);
    expect(typeof channels[2].parse).toBe('function');
  });

  it('a directory without channels/ behaves as before', async () => {
    const { channels, manifest } = await resolveAgentDir(fixture('full'), { provider: mockModel(['x']) });
    expect(channels).toEqual([]);
    expect(manifest.channels).toEqual([]);
    await expect(loadAgentDir(fixture('full'), { provider: mockModel(['x']) })).resolves.toBeDefined();
  });

  it('rejects a default export that is not a channel with a coded error naming the file', async () => {
    const failure = await resolveAgentDir(fixture('err-bad-channel'), { provider: mockModel(['x']) }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SDKError);
    expect((failure as SDKError).code).toBe('LOUSHY_CHANNEL_INVALID');
    expect((failure as SDKError).message).toMatch(/plain\.ts: the default export must be a channel/);
  });
});
