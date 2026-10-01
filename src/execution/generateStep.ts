/**
 * The provider.generate() half of one AgentExecutor loop step: building the
 * request and tool definitions, the onLLMRequest/onLLMResponse callbacks,
 * pre/post generate hooks, the `chat {model}` span, and LOU-T4's
 * compaction of a generate() failure.
 */

import { GenerateOptions, GenerateResult, Message, ToolDefinition } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { withSpan } from './tracing';
import type { CallUsage } from '../models/usage';
import { measureUsage } from './runUsage';
import { llmSpanInit, recordLlmResult, resolveCaptureContent } from './genAiSpans';
import { GenerateHookContext } from './hooks';
import {
  CompactedLLMProviderError,
  CompactedProviderError,
  compactProviderError,
  isModelActionableProviderErrorCategory,
} from './errors';
import type { ExecuteOptions } from './AgentExecutor';
import { runEventsOf } from './agentRun';

/**
 * Build tools from agent and registry
 */
export function buildTools(
  agent: AgentConfig,
  toolRegistry?: ToolRegistry
): ToolDefinition[] {
  if (!agent.tools || !toolRegistry) {
    return [];
  }

  const tools: ToolDefinition[] = [];

  for (const [toolName, toolConfig] of Object.entries(agent.tools)) {
    const toolDesc = toolRegistry.get(toolName);
    if (toolDesc && toolDesc.tool) {
      // The tool from 'ai' SDK already has description and parameters
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: toolDesc.tool.description || toolConfig.description || '',
          parameters: toolDesc.tool.parameters || {},
        },
      });
    }
  }

  return tools;
}

/**
 * Builds the context object passed to a pre/post generate hook. Called
 * once per hook invocation so each receives its own object.
 */
function generateHookContext(
  options: ExecuteOptions,
  messages: Message[],
  request: GenerateOptions
): GenerateHookContext {
  return {
    agentId: options.agent.id,
    agentName: options.agent.name,
    sessionId: options.sessionId,
    messages,
    request,
  };
}

/** The model a call is made with: agent.settings.model > the provider's configured model > unknown. */
function resolveModel(options: ExecuteOptions): string | undefined {
  return options.agent.settings?.model || options.provider.defaultModel;
}

/**
 * Builds the next provider.generate() request and runs the onLLMRequest
 * callback and preGenerate hooks for it. Errors thrown here are NOT
 * provider failures and are never compacted.
 */
export async function prepareGenerateRequest(
  options: ExecuteOptions,
  messages: Message[],
  tools: ToolDefinition[]
): Promise<GenerateOptions> {
  const { temperature, maxTokens, onLLMRequest, hooks, signal } = options;

  const generateRequest: GenerateOptions = {
    // agent.settings.model > the model the provider was configured with >
    // undefined (the provider then applies its own built-in default).
    model: resolveModel(options),
    messages,
    temperature,
    maxTokens,
    tools: tools.length > 0 ? tools : undefined,
    // LOU-V1: lets the provider cancel the in-flight request.
    ...(signal ? { signal } : {}),
  };

  if (onLLMRequest) {
    await onLLMRequest(generateRequest);
  }

  if (hooks) {
    await hooks.runPreGenerate(generateHookContext(options, messages, generateRequest));
  }

  return generateRequest;
}

/** A generate() reply with what the call spent (LOU-V5). */
export interface GeneratedStep {
  generated: GenerateResult;
  measured: CallUsage;
}

/**
 * Runs provider.generate() inside a `chat {model}` span parented to the
 * run's `invoke_agent` span, followed by the onLLMResponse callback and
 * postGenerate hooks.
 */
export function generateInSpan(
  options: ExecuteOptions,
  generateRequest: GenerateOptions,
  messages: Message[],
  agentSpanId: string
): Promise<GeneratedStep> {
  const { provider, exporter, onLLMResponse, hooks, redactContent = false } = options;
  const captureContent = resolveCaptureContent(options.captureContent);
  const init = llmSpanInit(provider, generateRequest, { redactContent, captureContent });

  return withSpan(
    exporter,
    init.name,
    init.attributes,
    async (llmSpan) => {
      const llmStart = Date.now();
      // LOU-V2: a streaming run obtains the step through its sink (streamed
      // when the provider can); everything around it is the same.
      const runEvents = runEventsOf(options);
      const generated = runEvents
        ? await runEvents.generate(provider, generateRequest)
        : await provider.generate(generateRequest);
      const llmLatencyMs = Date.now() - llmStart;

      const measured = measureUsage(resolveModel(options) ?? provider.name, messages, generated);
      recordLlmResult(llmSpan, generated, captureContent, measured);

      if (onLLMResponse) {
        await onLLMResponse(generated, llmLatencyMs, measured);
      }

      if (hooks) {
        await hooks.runPostGenerate(
          generateHookContext(options, messages, generateRequest),
          generated
        );
      }

      return { generated, measured };
    },
    agentSpanId,
    init.kind
  );
}

/**
 * LOU-T4 (Factor 9): compact whatever the provider adapter threw - a raw
 * 'ai'-SDK APICallError/LoadAPIKeyError/RetryError, or a bare network
 * error - into a small CompactedProviderError before it goes anywhere near
 * the caller or `messages`. See errors.ts's `compactProviderError()` doc
 * comment for the full mapping evidence (all four adapters share the same
 * 'ai'-SDK error taxonomy).
 */
export function compactGenerateError(
  generateError: unknown,
  providerName: string
): { compacted: CompactedProviderError; error: CompactedLLMProviderError } {
  const compacted = compactProviderError(generateError, providerName);
  return {
    compacted,
    error: new CompactedLLMProviderError(compacted, generateError as Error),
  };
}

/**
 * Whether a compacted generate() failure should be folded into the
 * conversation for the model to react to (opt-in, model-actionable
 * categories only) rather than rejecting execute().
 */
export function shouldSurfaceToModel(
  options: ExecuteOptions,
  compacted: CompactedProviderError
): boolean {
  const { surfaceRetryableProviderErrors = false } = options;
  return (
    surfaceRetryableProviderErrors &&
    isModelActionableProviderErrorCategory(compacted.category)
  );
}

/**
 * The `[provider-error]` message that folds a compacted generate() failure
 * into the conversation so the MODEL sees it on its next turn and can react
 * (back off, shorten its own ask, etc.) - this is what Factor 9 actually
 * asks for ("compact errors into the CONTEXT WINDOW"), for the categories
 * where handing it to the model is productive.
 *
 * This is a `role: 'user'` message, not `role: 'tool'`, despite using the
 * same `{error: ...}` shape the tool-error compaction pattern uses: a
 * `tool` message is only valid, for every provider here, when it's paired
 * with a `toolCallId` from an assistant tool-call turn that actually
 * happened - and a provider.generate() failure means no such assistant
 * turn exists yet. Sending an orphaned `tool` message would itself be
 * rejected by the next generate() call (OpenAI/Anthropic both require tool
 * results to follow a matching tool-call), compounding the failure instead
 * of compacting it. The `[provider-error]` prefix keeps this
 * distinguishable from genuine human input in transcripts/logs.
 */
export function providerErrorMessage(compacted: CompactedProviderError): Message {
  return {
    role: 'user',
    content: `[provider-error] ${JSON.stringify({
      error: compacted.error,
      category: compacted.category,
      retryable: compacted.retryable,
      ...(compacted.retryAfterMs !== undefined
        ? { retryAfterMs: compacted.retryAfterMs }
        : {}),
    })}`,
  };
}
