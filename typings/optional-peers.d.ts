/**
 * Ambient module declarations for optional peer dependencies.
 *
 * `@ai-sdk/openai` and `ollama-ai-provider` are declared as optional peer
 * dependencies (see package.json `peerDependenciesMeta`) and are not
 * installed in this repo's own node_modules. These minimal ambient
 * declarations let `tsc`/`tsup`'s declaration (`.d.ts`) build resolve the
 * imports in src/providers/OpenAIProvider.ts, src/providers/OpenRouterProvider.ts
 * and src/providers/OllamaProvider.ts without requiring consumers of this
 * package (or this repo's own CI) to install those optional packages.
 *
 * Consumers who actually install the real packages get the real, richer
 * types from those packages instead of these stand-ins.
 */

declare module '@ai-sdk/openai' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createOpenAI(options?: Record<string, any>): any;
}

declare module 'ollama-ai-provider' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createOllama(options?: Record<string, any>): any;
}
