import { describe, expect, it } from 'vitest';
import { hostStatus, listNotes, readNote, writeNote } from './host';
import { testToolContext } from '@lousho/build-ai-agent/testing';

const ctx = testToolContext();

describe('vps-ops tools', () => {
  it('host_status returns live host facts', async () => {
    const s = await hostStatus.execute({}, ctx);
    expect(s.cpus).toBeGreaterThan(0);
    expect(s.memory.totalMb).toBeGreaterThan(0);
    expect(s.os).toMatch(/Linux|Windows|Darwin/);
  });

  it('notes write/read/list round-trips and rejects traversal', async () => {
    await writeNote.execute({ name: 'deploy-log', content: 'smoke passed' }, ctx);
    expect((await readNote.execute({ name: 'deploy-log' }, ctx)).content).toBe('smoke passed');
    expect((await listNotes.execute({}, ctx)).notes).toContain('deploy-log');
    await expect(writeNote.execute({ name: '../escape', content: 'x' }, ctx)).rejects.toThrow(/a-z0-9/i);
    await expect(writeNote.execute({ name: 'a/b', content: 'x' }, ctx)).rejects.toThrow(/a-z0-9/i);
  });
});
