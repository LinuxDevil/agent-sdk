import { describe, it, expect, vi } from 'vitest';
import { StudioEventBus } from '../events/eventBus';
import type { StudioEvent } from '../../shared/wireTypes';

/**
 * The per-workspace Studio event bus (server/events/eventBus.ts) that
 * `WS /events` fans out from: a publish reaches every current subscriber,
 * an unsubscribed listener hears nothing.
 */
describe('StudioEventBus', () => {
  const AGENT_CHANGED: StudioEvent = { type: 'agent.changed', agentId: 'a1', reason: 'save' };

  it('delivers a published event to every subscriber', () => {
    const bus = new StudioEventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);
    bus.publish(AGENT_CHANGED);
    expect(first).toHaveBeenCalledWith(AGENT_CHANGED);
    expect(second).toHaveBeenCalledWith(AGENT_CHANGED);
  });

  it('an unsubscribed listener receives nothing', () => {
    const bus = new StudioEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    bus.publish(AGENT_CHANGED);
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing one listener leaves the others subscribed', () => {
    const bus = new StudioEventBus();
    const kept = vi.fn();
    const dropped = vi.fn();
    bus.subscribe(kept);
    const unsubscribe = bus.subscribe(dropped);
    unsubscribe();
    bus.publish(AGENT_CHANGED);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('tolerates many subscribers (the WS endpoint adds one per open tab)', () => {
    const bus = new StudioEventBus();
    const listeners = Array.from({ length: 25 }, () => vi.fn());
    for (const listener of listeners) bus.subscribe(listener);
    bus.publish(AGENT_CHANGED);
    for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(1);
  });
});
