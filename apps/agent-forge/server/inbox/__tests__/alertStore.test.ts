import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AlertStore, type InboxAlert } from '../alertStore';

function alertInput(overrides: Partial<Parameters<AlertStore['add']>[0]> = {}) {
  return {
    kind: 'auto_disabled' as const,
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    title: 'Agent was turned off after 5 failed runs',
    detail: null,
    payload: {},
    ...overrides,
  };
}

describe('AlertStore', () => {
  let dir: string;
  let store: AlertStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l12-alerts-'));
    store = new AlertStore(path.join(dir, 'inbox', 'alerts.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('add/list round-trips newest first with stamped id and timestamps', async () => {
    const first = await store.add(alertInput({ title: 'first' }));
    const second = await store.add(alertInput({ title: 'second' }));
    expect(first.id).toMatch(/^alert_/);
    expect(first.dismissedAt).toBeNull();
    const list = await store.list();
    expect(list.map((a) => a.title)).toEqual(['second', 'first']);
    expect(list[0].id).toBe(second.id);
  });

  it('dismiss stamps dismissedAt, hides the alert by default and returns it', async () => {
    const alert = await store.add(alertInput());
    const dismissed = await store.dismiss(alert.id);
    expect(dismissed?.dismissedAt).not.toBeNull();
    expect(await store.list()).toEqual([]);
    expect((await store.list({ includeDismissed: true })).map((a) => a.id)).toEqual([alert.id]);
    expect(await store.dismiss('alert_missing')).toBeUndefined();
  });

  it('caps the list at 500, dropping the oldest', async () => {
    const seeded: InboxAlert[] = Array.from({ length: 500 }, (_, i) => ({
      id: `alert_seed_${i}`,
      kind: 'auto_disabled',
      agentId: 'a',
      workspaceId: 'ws-1',
      title: `seed ${i}`,
      detail: null,
      payload: {},
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      dismissedAt: null,
    }));
    const file = path.join(dir, 'inbox', 'alerts.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seeded));
    await store.add(alertInput({ title: 'one-too-many' }));
    const list = await store.list();
    expect(list).toHaveLength(500);
    expect(list[0].title).toBe('one-too-many');
    // The file is newest-first, so the tail is the oldest: seed_499 drops.
    expect(list.some((a) => a.id === 'alert_seed_499')).toBe(false);
    expect(list.some((a) => a.id === 'alert_seed_0')).toBe(true);
  });

  it('onChange fires after add and dismiss and unsubscribes cleanly', async () => {
    let calls = 0;
    const off = store.onChange(() => calls++);
    const alert = await store.add(alertInput());
    await store.dismiss(alert.id);
    expect(calls).toBe(2);
    off();
    await store.add(alertInput());
    expect(calls).toBe(2);
  });

  it('parallel adds all land (the lock serializes the read-modify-write)', async () => {
    const added = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.add(alertInput({ title: `parallel ${i}` })))
    );
    const list = await store.list();
    expect(list).toHaveLength(10);
    expect(new Set(added.map((a) => a.id)).size).toBe(10);
  });
});
