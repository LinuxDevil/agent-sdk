/**
 * The names an agent directory's files may import from
 * '@lousho/build-ai-agent' in a cloudflare-worker build: the exports of
 * src/deploy/workerSdk.ts (a test keeps the two equal). In its own module so
 * the adapter (adapters/cloudflare.ts) and the build-time module evaluation
 * (./evalModule.ts) can share it without a circular import.
 */
import { SDKError } from '../execution/errors';

/** The names an agent directory's files may import from '@lousho/build-ai-agent' in a Worker build. */
export const WORKER_SDK_EXPORTS = [
  'AnthropicProvider',
  'ConfigurationError',
  'LLMProviderRegistry',
  'MockLLMProvider',
  'OpenAIProvider',
  'OpenRouterProvider',
  'SDKError',
  'ToolExecutionError',
  'ValidationError',
  'always',
  'createMockProvider',
  'defineChannel',
  'defineMemory',
  'defineSchedule',
  'defineSkill',
  'defineTool',
  'discordChannel',
  'fromAiSdk',
  'githubChannel',
  'httpChannel',
  'inMemoryMemory',
  'isDefinedSchedule',
  'isDefinedTool',
  'kvMemory',
  'never',
  'once',
  'slackChannel',
  'teamsChannel',
  'telegramChannel',
  'textOf',
];

/** Adds what to do to esbuild's "No matching export" for an SDK name a Worker bundle does not offer (exported for tests). */
export function explainWorkerBuildError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/No matching export in "[^"]*workerSdk\.ts"/.test(message)) return error;
  return new SDKError(
    `cloudflare-worker build: ${message}
In a Cloudflare Worker, the files of an agent directory can import only these ` +
      `from '@lousho/build-ai-agent': ${WORKER_SDK_EXPORTS.join(', ')}. Use --target=node-server or --target=docker for the rest.`,
    'LOUSHO_DEPLOY_FAILED',
    { cause: error }
  );
}
