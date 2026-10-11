/** Run lease records of the file and SQLite stores: when a lease is free to take. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { leaseAvailable, newLeaseRecord, parseLeaseRecord, type LeaseRecord } from './leaseRecord';
import { acquireRunLease, localLeaseInstance } from '../execution/runLease';
import { memoryStore } from './agentStore';

const linuxProcfs = process.platform === 'linux' && newLeaseRecord('x', 1).pidSpace !== undefined;

describe('run lease records', () => {
  it('a missing, own, long-expired or unreadable lease is free; a live one of another owner is not', () => {
    const live = newLeaseRecord('claim:a', 60_000);
    expect(live).toMatchObject({ host: hostname(), ttlMs: 60_000 });
    expect(leaseAvailable(undefined, 'claim:b')).toBe(true);
    expect(leaseAvailable(live, 'claim:a')).toBe(true);
    expect(leaseAvailable(live, 'claim:b')).toBe(false);
    for (const raw of [undefined, 'not json', 'null', '{"owner":1}', '{"owner":"a"}']) expect(parseLeaseRecord(raw)).toBeUndefined();
    expect(parseLeaseRecord(JSON.stringify(live))).toEqual(live);
  });

  it('an expired lease is taken only after one more lease period (clocks of two replicas may disagree)', () => {
    const lease = newLeaseRecord('claim:a', 30_000);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 1 }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 29_000 }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...lease, expiresAt: Date.now() - 30_001 }, 'claim:b')).toBe(true);
    // A record without its period (written by an earlier release) has no grace.
    expect(leaseAvailable({ owner: 'claim:a', expiresAt: Date.now() - 1 }, 'claim:b')).toBe(true);
  });

  it("is free at once when it is this realm's run and that run no longer runs", async () => {
    const lease = await acquireRunLease(memoryStore().checkpoints, 'run-1');
    const record = { ...newLeaseRecord(lease!.owner, 60_000) };
    expect(leaseAvailable(record, 'claim:b')).toBe(false);
    await lease!.release();
    expect(leaseAvailable(record, 'claim:b')).toBe(true);
    const finished = `${process.pid}:${localLeaseInstance()}:${randomUUID()}`;
    expect(leaseAvailable(newLeaseRecord(finished, 60_000), 'claim:b')).toBe(true);
  });

  it('is never taken early from another realm of this process (a worker thread, another module instance)', () => {
    const otherRealm = newLeaseRecord(`${process.pid}:${randomUUID()}:${randomUUID()}`, 60_000);
    expect(leaseAvailable(otherRealm, 'claim:b')).toBe(false);
  });

  it('is never taken early from another host, nor from an owner of an older release (no process identity)', () => {
    const dead: LeaseRecord = { ...newLeaseRecord(`999999999:${randomUUID()}:${randomUUID()}`, 60_000), host: 'another-host' };
    expect(leaseAvailable(dead, 'claim:b')).toBe(false);
    if (linuxProcfs) expect(leaseAvailable({ owner: '999999999:run', expiresAt: Date.now() + 60_000, host: hostname() }, 'claim:b')).toBe(false);
  });

  it.runIf(linuxProcfs)('on Linux, is free early only for an exited process of this boot and PID namespace', () => {
    const local = newLeaseRecord('x', 60_000);
    const owner = (pid: number) => `${pid}:${randomUUID()}:${randomUUID()}`;
    // A process that exited (no such pid here).
    expect(leaseAvailable({ ...local, owner: owner(999_999_999) }, 'claim:b')).toBe(true);
    // A live process (the parent), with its own start time: alive. Without a start time: never early.
    const stat = readFileSync(`/proc/${process.ppid}/stat`, 'utf8');
    const parent = { ...newLeaseRecord(owner(process.ppid), 60_000), pidStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    expect(leaseAvailable(parent, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...parent, owner: owner(999_999_999), pidStart: undefined }, 'claim:b')).toBe(false);
    // The same pid but another start time: that process exited and the pid was reused.
    expect(leaseAvailable({ ...parent, pidStart: '1' }, 'claim:b')).toBe(true);
    // Our own pid with our start time is another thread of this process: alive. With another start time, an earlier process.
    expect(leaseAvailable({ ...local, owner: owner(process.pid) }, 'claim:b')).toBe(false);
    expect(leaseAvailable({ ...local, owner: owner(process.pid), pidStart: '1' }, 'claim:b')).toBe(true);
    // Another PID namespace or boot (another container with the same hostname): never early, whatever its pid.
    expect(leaseAvailable({ ...local, owner: owner(999_999_999), pidSpace: 'other-boot/pid:[1]' }, 'claim:b')).toBe(false);
  });
});
