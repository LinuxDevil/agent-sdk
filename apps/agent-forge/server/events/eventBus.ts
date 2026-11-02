/**
 * The per-workspace Studio event bus.
 *
 * Write routes publish `StudioEvent`s here (`workspaceOf(req).events`),
 * and `WS /events` (eventsWs.ts) forwards them to every open tab so the
 * agents list refreshes on change rather than polling. One bus per
 * `WorkspaceContext` - each workspace's writes only reach tabs watching
 * that workspace.
 */
import { EventEmitter } from 'node:events';
import type { StudioEvent } from '../../shared/wireTypes';

/** One open tab's `message` frame producer - returns the unsubscribe. */
export type StudioEventListener = (event: StudioEvent) => void;

/**
 * A synchronous fan-out over `EventEmitter`: `publish` runs every current
 * subscriber before returning. `setMaxListeners(0)` because every open
 * `/events` socket adds one listener and tabs come and go freely.
 */
export class StudioEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /** Delivers `event` to every current subscriber, synchronously. */
  publish(event: StudioEvent): void {
    this.emitter.emit('event', event);
  }

  /** Subscribes `listener` to every published event; the returned function unsubscribes it. */
  subscribe(listener: StudioEventListener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
