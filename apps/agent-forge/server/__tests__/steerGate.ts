/**
 * Shared test fixture for steer coverage: a 'steergate' LLM provider
 * whose model calls park on a test-released gate so a run is reliably
 * `running` while the test steers it. `setSteerGateScript` arms the NEXT
 * provider the registry builds (a fresh one per run, consumed once);
 * `steerGateProviders` lists every built provider so a test can inspect
 * the calls each received.
 *
 * Used by steer.test.ts (RunManager level) and app.test.ts (HTTP level).
 */
import {
  LLMProviderRegistry,
  type GenerateOptions,
  type GenerateResult,
  type LLMProvider,
  type StreamChunk,
  type StreamResult,
} from '@linuxdevil/lousho';

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/**
 * What the next built steergate provider does: its first `blockCalls`
 * model calls park on `gate`. 'before-output' waits before any delta (a
 * steer then applies 'immediate' and aborts the silent call);
 * 'after-delta' yields one delta first (callOutput() has run, so a steer
 * applies 'queued').
 */
export interface SteerGateScript {
  blockCalls: number;
  mode: 'before-output' | 'after-delta';
  gate: Promise<void>;
}

class GatedSteerProvider implements LLMProvider {
  readonly name = 'steergate';
  readonly calls: GenerateOptions[] = [];
  blockCalls = 0;
  mode: 'before-output' | 'after-delta' = 'before-output';
  gate: Promise<void> = Promise.resolve();

  private async waitGate(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.gate.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  private text(): string {
    return this.mode === 'after-delta' ? 'Working on it. All done.' : 'All done.';
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.calls.push(options);
    if (this.blockCalls > 0) {
      this.blockCalls -= 1;
      await this.waitGate(options.signal);
    }
    return { text: this.text(), finishReason: 'stop', usage: USAGE, toolCalls: [] };
  }

  async stream(options: GenerateOptions): Promise<StreamResult> {
    this.calls.push(options);
    const block = this.blockCalls > 0;
    if (block) this.blockCalls -= 1;
    const mode = this.mode;
    const waitGate = this.waitGate.bind(this);
    const deltas = mode === 'after-delta' ? ['Working on it. ', 'All done.'] : ['All done.'];
    const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
      let emitted = false;
      for (const delta of deltas) {
        // 'before-output' parks before the first delta; 'after-delta'
        // parks between the first and the rest.
        if (block && (mode === 'before-output' || emitted)) {
          await waitGate(options.signal);
        }
        emitted = true;
        yield { type: 'text-delta', textDelta: delta };
      }
      yield { type: 'finish', finishReason: 'stop', usage: USAGE };
    })();
    return {
      fullStream,
      textStream: (async function* () {
        yield* deltas;
      })(),
      text: Promise.resolve(this.text()),
      usage: Promise.resolve(USAGE),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    };
  }

  supportsTools(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return ['steer-1'];
  }
}

/** The script the NEXT built steergate provider starts with (consumed once). */
let script: SteerGateScript | undefined;
export const steerGateProviders: GatedSteerProvider[] = [];

LLMProviderRegistry.register('steergate', () => {
  const provider = new GatedSteerProvider();
  if (script !== undefined) {
    provider.blockCalls = script.blockCalls;
    provider.mode = script.mode;
    provider.gate = script.gate;
    script = undefined;
  }
  steerGateProviders.push(provider);
  return provider;
});

/** Arms the script the NEXT built steergate provider starts with. */
export function setSteerGateScript(next: SteerGateScript): void {
  script = next;
}

/** Clears the armed script and the built-provider list (a beforeEach reset). */
export function resetSteerGate(): void {
  script = undefined;
  steerGateProviders.length = 0;
}
