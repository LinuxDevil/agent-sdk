/** Shared agent factory for the incident-triage scenarios. */
import { createAgent, isRetryableProviderError, type AgentEvent, type CreateAgentConfig, type LLMProvider } from '@lousho/build-ai-agent';
import { OpenAIProvider } from '@lousho/build-ai-agent';
import { LOCAL_BASE_URL, LOCAL_MODEL } from '../_shared/local.js';
import { IncidentReport, INSTRUCTIONS, tools } from './logs.js';

export type TriageOptions = Partial<CreateAgentConfig> & { quiet?: boolean };

/**
 * createAgent() has no per-call maxTokens/temperature option, so cap output
 * tokens by wrapping the provider: an 8K window with a reasoning model needs
 * room reserved for the reply.
 */
export function capped(p: LLMProvider, maxTokens = Number(process.env.MAX_TOKENS ?? 2500)): LLMProvider {
  return new Proxy(p, {
    get(target, key, recv) {
      // STREAM=0: report no streaming support, so the executor uses generate() even with
      // an onEvent listener (createAgent has no streamModelCalls option), which lets
      // withRetry retry LM Studio's errors (mid-stream errors are never retried).
      if (key === 'supportsStreaming' && process.env.STREAM === '0') return () => false;
      if (key === 'generate' || key === 'stream') return (o: Parameters<LLMProvider['generate']>[0]) => (target as any)[key]({ ...o, maxTokens: o.maxTokens ?? maxTokens });
      const v = Reflect.get(target, key, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Like _shared/localProvider() but with the ai SDK's own retries off, so createAgent({ retry }) retries in one place. */
export function provider0(): OpenAIProvider {
  return new OpenAIProvider({ apiKey: 'lm-studio', baseURL: process.env.LOCAL_LLM_BASE_URL ?? LOCAL_BASE_URL, defaultModel: LOCAL_MODEL, maxRetries: 0 });
}

export function triageAgent(opts: TriageOptions = {}) {
  const { quiet, ...rest } = opts;
  return createAgent({
    name: 'incident-triage',
    provider: capped(provider0()),
    instructions: INSTRUCTIONS,
    tools,
    maxSteps: 14,
    toolConcurrency: 4,
    output: IncidentReport,
    onEvent: quiet ? undefined : logEvent,
    // The shared LM Studio server runs parallel slots over one 8K KV cache, so
    // "Context size has been exceeded" is transient under load: retry it too.
    retry: {
      maxRetries: Number(process.env.RETRIES ?? 6),
      backoff: { initialMs: 2000 },
      retryOn: (err) => isRetryableProviderError(err) || /context size has been exceeded|exceeds the available context/i.test(String((err as Error)?.message)),
      onRetry: ({ attempt, delayMs, error }) => console.log(`  [retry ${attempt} in ${delayMs}ms] ${String((error as Error)?.message).slice(0, 120)}`),
    },
    ...(rest as Record<string, never>), // CreateAgentConfig is a union; a Partial of it does not spread back cleanly
  });
}

export const TASK =
  'Pager fired at 14:12 UTC: checkout is failing. Investigate the logs and produce the incident report.';

const t0 = Date.now();
export function logEvent(e: AgentEvent) {
  const ts = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  const ev = e as Record<string, any>;
  switch (e.type) {
    case 'tool.start':
    case 'tool.resume':
      console.log(`${ts}s  -> ${ev.toolName ?? ev.name}(${JSON.stringify(ev.args ?? ev.input ?? '').slice(0, 140)})`);
      break;
    case 'tool.error':
    case 'tool.done':
      console.log(`${ts}s  <- ${ev.toolName ?? ev.name} ${ev.error ? 'ERROR ' + JSON.stringify(ev.error).slice(0, 160) : `${JSON.stringify(ev.result ?? ev.output ?? '').length} chars`}`);
      break;
    case 'step.start':
    case 'step.done':
    case 'compaction.start':
    case 'compaction.done':
    case 'provider.retry':
    case 'run.done':
      console.log(`${ts}s  ${e.type} ${JSON.stringify({ ...ev, type: undefined, text: undefined, messages: undefined, object: undefined }).slice(0, 260)}`);
      break;
  }
}
