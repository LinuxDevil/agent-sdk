/** Run lease records of the file and SQLite stores: when a lease is free to take. */
import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { leaseAvailable, newLeaseRecord, parseLeaseRecord } from './leaseRecord';
import { acquireRunLease } from '../execution/runLease';
import { memoryStore } from './agentStore';

describe('run lease records', () => {
  it('a missing, own, expired or unreadable lease is free; a live one of another owner is not', () => {
    const live = newLeaseRecord('claim:a', 60_000);
    expect(live.host).toBe(hostname());
    expect(leaseAvailable(undefined, 'claim:b')).toBe(true);
    expect(leaseAvailable(live, 'claim:a')).toBe(true);
    expect(leaseAvailable(live, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...live, expiresAt: Date.now() - 1 }, 'claim:b')).toBe(true);
    for (const raw of [undefined, 'not json', 'null', '{"owner":1}', '{"owner":"a"}']) expect(parseLeaseRecord(raw)).toBeUndefined();
    expect(parseLeaseRecord(JSON.stringify(live))).toEqual(live);
  });

  it("is free when its run's process is gone from this host, or is this process but no longer runs", async () => {
    const dead = { owner: '999999999:run', expiresAt: Date.now() + 60_000, host: hostname() };
    expect(leaseAvailable(dead, 'claim:b')).toBe(true);
    expect(leaseAvailable({ ...dead, host: 'another-host' }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...dead, owner: `${process.pid}:finished-run` }, 'claim:b')).toBe(true);
    const lease = await acquireRunLease(memoryStore().checkpoints, 'run-1');
    expect(leaseAvailable({ ...dead, owner: lease!.owner }, 'claim:b')).toBe(false);
    await lease!.release();
    expect(leaseAvailable({ ...dead, owner: `${process.ppid}:parent` }, 'claim:b')).toBe(false); // a live process
  });
});
