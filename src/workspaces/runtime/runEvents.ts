import type { WireRunEvent } from '../client/wireTypes';
import type { PageRunEvent } from '../contracts/execution';
import type { WorkspaceRunEvents } from './stores';

export interface RunRecorder {
  emit(event: PageRunEvent): void;
  flush(): Promise<void>;
}

export function runRecorder(runId: string, events: WorkspaceRunEvents | undefined, listener: ((event: WireRunEvent) => void) | undefined): RunRecorder {
  const state: { next: number; tail: Promise<void>; failure?: { error: unknown } } = { next: 0, tail: Promise.resolve() };
  const append = async (event: PageRunEvent): Promise<WireRunEvent> => (events ? events.append(runId, event) : { id: state.next++, runId, event });
  const record = async (event: PageRunEvent): Promise<void> => {
    if (state.failure) return;
    const wire = await append(event);
    listener?.(wire);
  };
  return {
    emit(event) {
      state.tail = state.tail.then(() => record(event)).catch((error: unknown) => {
        state.failure ??= { error };
      });
    },
    async flush() {
      await state.tail;
      if (state.failure) throw state.failure.error;
    },
  };
}

export function withCause(error: unknown, cause: unknown): unknown {
  if (error instanceof Error && error.cause === undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  return error;
}

export async function thenFinish<T>(work: () => Promise<T>, finish: (result: T | undefined) => Promise<void>): Promise<T> {
  let result: T | undefined;
  try {
    result = await work();
  } catch (error) {
    await finish(undefined).catch((finishError: unknown) => withCause(error, finishError));
    throw error;
  }
  await finish(result);
  return result;
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
