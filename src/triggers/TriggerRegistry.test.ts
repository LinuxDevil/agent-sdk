import { describe, it, expect, vi } from 'vitest';
import { TriggerRegistry, globalTriggerRegistry } from './TriggerRegistry';
import { TriggerAdapter } from './types';

function makeAdapter(type: string): TriggerAdapter {
  return {
    type,
    listen: vi.fn().mockReturnValue({ stop: vi.fn() }),
  };
}

describe('TriggerRegistry', () => {
  it('registers and retrieves an adapter by name', () => {
    const registry = new TriggerRegistry();
    const adapter = makeAdapter('webhook');
    registry.register('webhook', adapter);
    expect(registry.get('webhook')).toBe(adapter);
  });

  it('returns undefined for an unregistered name', () => {
    const registry = new TriggerRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('has() reflects registration state', () => {
    const registry = new TriggerRegistry();
    expect(registry.has('cron')).toBe(false);
    registry.register('cron', makeAdapter('cron'));
    expect(registry.has('cron')).toBe(true);
  });

  it('registers multiple adapters at once via registerMany', () => {
    const registry = new TriggerRegistry();
    registry.registerMany({
      webhook: makeAdapter('webhook'),
      cron: makeAdapter('cron'),
    });
    expect(registry.list().sort()).toEqual(['cron', 'webhook']);
  });

  it('list() returns all registered names', () => {
    const registry = new TriggerRegistry();
    registry.register('a', makeAdapter('a'));
    registry.register('b', makeAdapter('b'));
    expect(registry.list().sort()).toEqual(['a', 'b']);
  });

  it('getAll() returns a name->adapter map', () => {
    const registry = new TriggerRegistry();
    const adapter = makeAdapter('slack');
    registry.register('slack', adapter);
    expect(registry.getAll()).toEqual({ slack: adapter });
  });

  it('overwrites an existing registration under the same name and warns', () => {
    const registry = new TriggerRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeAdapter('webhook');
    const second = makeAdapter('webhook');
    registry.register('webhook', first);
    registry.register('webhook', second);
    expect(registry.get('webhook')).toBe(second);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('unregister() removes an adapter and returns true, false if absent', () => {
    const registry = new TriggerRegistry();
    registry.register('webhook', makeAdapter('webhook'));
    expect(registry.unregister('webhook')).toBe(true);
    expect(registry.has('webhook')).toBe(false);
    expect(registry.unregister('webhook')).toBe(false);
  });

  it('clear() removes all adapters', () => {
    const registry = new TriggerRegistry();
    registry.register('a', makeAdapter('a'));
    registry.register('b', makeAdapter('b'));
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it('size() reflects the number of registered adapters', () => {
    const registry = new TriggerRegistry();
    expect(registry.size()).toBe(0);
    registry.register('a', makeAdapter('a'));
    expect(registry.size()).toBe(1);
  });

  it('globalTriggerRegistry is a shared TriggerRegistry instance', () => {
    expect(globalTriggerRegistry).toBeInstanceOf(TriggerRegistry);
  });
});
