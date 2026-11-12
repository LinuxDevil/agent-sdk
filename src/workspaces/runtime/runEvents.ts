import type { WireRunEvent } from '../client/wireTypes';
import type { PageRunEvent } from '../contracts/execution';
import type { WorkspaceRunEvents } from './stores';

export interface RunRecorder {
  emit(event: PageRunEvent): void;
  flush(): Promise<void>;
}

export function runRecorder(runId: string, events: WorkspaceRunEvents | undefined, listener: ((event: WireRunEvent) => void) | undefined): RunRecorder {
  let next = 0;
  let tail: Promise<void> = Promise.resolve();
  const append = async (event: PageRunEvent): Promise<WireRunEvent> => (events ? events.append(runId, event) : { id: next++, runId, event });
  return {
    emit(event) {
      tail = tail.then(async () => {
        const wire = await append(event);
        listener?.(wire);
      });
    },
    flush: () => tail,
  };
}

export interface EventChannel<T> {
  push(item: T): void;
  end(): void;
  fail(error: unknown): void;
  readonly items: AsyncIterable<T>;
}

export function eventChannel<T>(onAbandon: () => void): EventChannel<T> {
  const queue: T[] = [];
  const state: { done: boolean; failed: boolean; error?: unknown; wake?: () => void } = { done: false, failed: false };
  const notify = (): void => {
    const wake = state.wake;
    state.wake = undefined;
    wake?.();
  };
  async function* iterate(): AsyncGenerator<T> {
    try {
      for (;;) {
        const item = queue.shift();
        if (item !== undefined) yield item;
        else if (state.failed) throw state.error;
        else if (state.done) return;
        else await new Promise<void>((resolve) => (state.wake = resolve));
      }
    } finally {
      if (!state.done && !state.failed) onAbandon();
    }
  }
  return {
    push(item) {
      queue.push(item);
      notify();
    },
    end() {
      state.done = true;
      notify();
    },
    fail(error) {
      state.failed = true;
      state.error = error;
      notify();
    },
    items: iterate(),
  };
}
