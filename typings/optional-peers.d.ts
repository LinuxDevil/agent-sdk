/**
 * Ambient module declarations for optional peer dependencies.
 *
 * `@ai-sdk/openai`, `@ai-sdk/google` and `ollama-ai-provider` are declared as optional peer
 * dependencies (see package.json `peerDependenciesMeta`) and are not
 * installed in this repo's own node_modules. These minimal ambient
 * declarations let `tsc`/`tsup`'s declaration (`.d.ts`) build resolve the
 * imports in src/providers/OpenAIProvider.ts, src/providers/OpenRouterProvider.ts,
 * src/providers/GoogleProvider.ts and src/providers/OllamaProvider.ts without requiring consumers of this
 * package (or this repo's own CI) to install those optional packages.
 *
 * Consumers who actually install the real packages get the real, richer
 * types from those packages instead of these stand-ins.
 */

declare module '@ai-sdk/openai' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createOpenAI(options?: Record<string, any>): any;
}

// Not a devDependency: GoogleProvider's tests mock it.
declare module '@ai-sdk/google' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createGoogleGenerativeAI(options?: Record<string, any>): any;
}

declare module 'ollama-ai-provider' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createOllama(options?: Record<string, any>): any;
}

// The Ollama package for `ai` 6/7.
declare module 'ollama-ai-provider-v2' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createOllama(options?: Record<string, any>): any;
}

// The 'isolate' sandbox driver's optional peer (src/sandbox/isolate.ts) - a
// native module, so it is an optional peer but NOT a devDependency; the
// driver lazy-loads it and tests inject a fake module. Only the surface the
// driver uses is declared; the real package's types fill in when installed.
declare module 'isolated-vm' {
  /** Options of Context.evalClosure (the parts src/sandbox/isolate.ts passes). */
  export interface EvalClosureOptions {
    /** Structured-clone the arguments into the isolate. */
    arguments?: { copy?: boolean };
    /** Structured-clone the result back; `promise` awaits a returned promise inside the isolate. */
    result?: { copy?: boolean; promise?: boolean };
    /** Interrupt synchronous execution after this many ms. */
    timeout?: number;
  }
  export class Context {
    evalClosure(code: string, args?: unknown[], options?: EvalClosureOptions): Promise<unknown>;
  }
  export class Isolate {
    constructor(options?: { memoryLimit?: number });
    createContext(): Promise<Context>;
    dispose(): void;
    readonly isDisposed: boolean;
  }
}
