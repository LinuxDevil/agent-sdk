/**
 * The provider.generate() half of one AgentExecutor loop step: building the
 * request and tool definitions, the onLLMRequest/onLLMResponse callbacks,
 * pre/post generate hooks, the `chat {model}` span, and LOU-T4's
 * compaction of a generate() failure.
 */

import { GenerateOptions, GenerateResult, LLMProvider, Message, ToolDefinition } from '../providers';
import { interceptProvider } from '../providers/interception';
import { textOf } from '../providers/content';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { getToolInputSchema } from '../tools/toolContract';
import { withSpan, type Span } from './tracing';
import { withProviderEvents } from '../providers/providerEvents';
import type { CallUsage } from '../models/usage';
import { measureUsage } from './runUsage';
import { llmSpanInit, recordLlmResult, resolveCaptureContent } from './genAiSpans';
import { SdkAttr } from './semconv';
import { GenerateHookContext } from './hooks';
import {
  CompactedLLMProviderError,
  CompactedProviderError,
  compactProviderError,
  isModelActionableProviderErrorCategory,
} from './errors';
import type { ExecuteOptions } from './AgentExecutor';
import { runEventsOf, subagentNameOf } from './agentRun';
import { outputResponseFormat } from './structuredOutput';
import { withSteerSignal } from './inputQueue';
import { mergeModelSettings } from './modelSettings';
import { settleHostedFinish } from './hostedToolCalls';
import { hostedToolsInMode, permissionModeOf } from './permissions';
import type { ParallelInputCheck } from './ioGuardrails';
import { deferralOf, visibleTools, type ToolDeferral } from './toolDeferral';

/** A legacy `.tool`'s description when it is a string (always, on `ai` v4). */
function legacyDescription(description: unknown): string | undefined {
  return typeof description === 'string' ? description : undefined;
}

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
          // `ai` v6/v7 also allow a description function; only a string is sent.
          description: legacyDescription(toolDesc.tool.description) || toolConfig.description || '',
          // A zod / Standard Schema or JSON Schema object; each provider converts it.
          parameters: (getToolInputSchema(toolDesc) || {}) as Record<string, unknown>,
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
  request: GenerateOptions,
  generate?: GenerateHookContext['generate']
): GenerateHookContext {
  return {
    agentId: options.agent.id,
    agentName: options.agent.name,
    sessionId: options.sessionId,
    // LOU-R16: `send(x, { metadata })`, as `ctx.metadata`.
    metadata: options.metadata,
    messages,
    request,
    emit: runEventsOf(options)?.hookEvent,
    ...(generate && { generate }),
  };
}

/**
 * Audit C4: `GenerateHookContext.generate` for a run - a side model call (the
 * compaction summarizer) in its own `chat` span under the run's span, tagged
 * with its purpose, whose usage `record` adds to the run's total.
 */
export function sideGenerator(
  options: ExecuteOptions,
  agentSpanId: string,
  record: (measured: CallUsage) => void
): NonNullable<GenerateHookContext['generate']> {
  return (provider: LLMProvider, request: GenerateOptions, purpose: string) => {
    const { exporter, redactContent } = options;
    const captureContent = resolveCaptureContent(options.captureContent);
    const init = llmSpanInit(provider, request, { redactContent, captureContent });
    const attributes = { ...init.attributes, [SdkAttr.CALL_PURPOSE]: purpose };
    return withSpan(
      exporter,
      init.name,
      attributes,
      async (span) => {
        const generated = await provider.generate(request);
        const measured = measureUsage(request.model || provider.defaultModel || provider.name, request.messages, generated);
        recordLlmResult(span, generated, captureContent, measured);
        record(measured);
        return generated;
      },
      agentSpanId,
      init.kind
    );
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
  tools: ToolDefinition[],
  callSignal?: AbortSignal,
  generate?: GenerateHookContext['generate']
): Promise<GenerateOptions> {
  const { temperature, maxTokens, onLLMRequest, hooks } = options;
  // C6: the agent's / call's settings, then the run's own `temperature` / `maxTokens`; an unset key is not sent at all.
  const settings = mergeModelSettings(options.modelSettings, { temperature, maxTokens });
  // LOU-V10: a steer aborts this call alone (`callSignal`), the run's signal all of them.
  const signal = withSteerSignal(options.signal, callSignal);
  // N1a x N4: read the mode at every call, so a switch to plan mode drops non-read-only hosted tools from the next one.
  const hostedTools = hostedToolsInMode(options.hostedTools, permissionModeOf(options));
  // N2: the tools of this call, from the transcript as it is now (deferred tools load through `tool_search`).
  const deferral = deferralOf(options);
  const sent = visibleTools(tools, messages, deferral);

  const generateRequest: GenerateOptions = {
    // agent.settings.model > the model the provider was configured with >
    // undefined (the provider then applies its own built-in default).
    model: resolveModel(options),
    messages,
    ...settings,
    tools: sent.length > 0 ? sent : undefined,
    // N1a: the provider's own tools, sent with every call of the run (plan mode: read-only ones only).
    ...(hostedTools?.length && { hostedTools }),
    // LOU-V4: a JSON-mode hint for runs with an `output` schema.
    ...(options.output ? { responseFormat: outputResponseFormat(options.output) } : {}),
    // LOU-V13: the providers send it only to models that accept it.
    ...(options.reasoning !== undefined && { reasoning: options.reasoning }),
    // LOU-V1: lets the provider cancel the in-flight request.
    ...(signal ? { signal } : {}),
  };

  if (onLLMRequest) {
    await onLLMRequest(generateRequest);
  }

  if (hooks) {
    const before = generateRequest.tools;
    await hooks.runPreGenerate(generateHookContext(options, messages, generateRequest, generate));
    if (deferral && generateRequest.tools === before) reloadTools(generateRequest, tools, messages, deferral);
  }

  generateRequest.messages = withLeadingSystemOnly(generateRequest.messages);
  return generateRequest;
}

/**
 * `messages` with every system message after the first non-system one (a
 * handoff's routing note, or one a caller put in the history) appended, in
 * order, to the leading system message - created when there is none. Many
 * chat templates (Qwen, Llama, Mistral via LM Studio, llama.cpp, vLLM, Ollama)
 * and Anthropic's API reject a system message that is not at the start, so a
 * request never carries one. Returns `messages` itself when there is nothing
 * to move; the transcript is never changed.
 */
export function withLeadingSystemOnly(messages: Message[]): Message[] {
  let lead = 0;
  while (lead < messages.length && messages[lead].role === 'system') lead++;
  if (!messages.slice(lead).some((message) => message.role === 'system')) return messages;
  const system = [...messages.slice(0, lead), ...messages.slice(lead).filter((message) => message.role === 'system')];
  const content = system.map((message) => textOf(message)).filter(Boolean).join('\n\n');
  const head: Message = lead > 0 ? { ...messages[0], content } : { role: 'system', content };
  return [head, ...messages.slice(lead).filter((message) => message.role !== 'system')];
}

/**
 * N2: after the preGenerate hooks, the call's tools again from the transcript: a compaction
 * hook that pruned a `tool_search` result unloads its tools from this call on.
 */
function reloadTools(request: GenerateOptions, tools: ToolDefinition[], messages: Message[], deferral: ToolDeferral): void {
  const after = visibleTools(tools, messages, deferral);
  if (after.length !== (request.tools?.length ?? 0)) request.tools = after.length > 0 ? after : undefined;
}

/** A generate() reply with what the call spent (LOU-V5). */
export interface GeneratedStep {
  generated: GenerateResult;
  measured: CallUsage;
}

/**
 * LOU-V10: `call`, or its rejection with `signal`'s reason as soon as
 * `signal` aborts - a provider that ignores the signal is not waited for.
 */
function abortable<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return call;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    call.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** C2: `request` with each `withRetry()` retry of it recorded on its `chat` span (count, and category and status per failure). */
function recordingRetries(request: GenerateOptions, span: Span): GenerateOptions {
  const errors: string[] = [];
  return withProviderEvents(request, {
    retry: ({ error }) => {
      const { category, statusCode } = compactProviderError(error);
      errors.push(statusCode === undefined ? category : `${category} ${statusCode}`);
      span.attributes = { ...span.attributes, [SdkAttr.RETRY_COUNT]: errors.length, [SdkAttr.RETRY_ERRORS]: [...errors] };
    },
    fallback: () => undefined,
  });
}

/**
 * Runs provider.generate() inside a `chat {model}` span parented to the
 * run's `invoke_agent` span, followed by the onLLMResponse callback and
 * postGenerate hooks. A steer (`callSignal`, LOU-V10) rejects it at once.
 */
export function generateInSpan(
  options: ExecuteOptions,
  generateRequest: GenerateOptions,
  messages: Message[],
  agentSpanId: string,
  callSignal?: AbortSignal,
  inputCheck?: ParallelInputCheck
): Promise<GeneratedStep> {
  const { exporter, onLLMResponse, hooks, redactContent } = options;
  // LOU-D46.2: the one place a run's model call is routed, so eval cassettes cover every entry point.
  const provider = interceptProvider(options.provider, { agent: subagentNameOf(options) ?? options.agent?.name });
  const captureContent = resolveCaptureContent(options.captureContent);
  const init = llmSpanInit(provider, generateRequest, { redactContent, captureContent });

  return withSpan(
    exporter,
    init.name,
    init.attributes,
    async (llmSpan) => {
      const llmStart = Date.now();
      // LOU-V2: a run with a sink (a stream, or M9: listeners) obtains the
      // step through it (streamed when the provider can); everything around it is the same.
      const runEvents = runEventsOf(options);
      const onOutput = () => options.inputQueue?.callOutput();
      // N5b: the sink holds the step's streamed output until the parallel input guardrails pass.
      const hold = inputCheck?.verdict;
      const request = recordingRetries(generateRequest, llmSpan);
      const generated = settleHostedFinish(
        await abortable(runEvents ? runEvents.generate(provider, request, onOutput, hold) : provider.generate(request), callSignal)
      );
      const llmLatencyMs = Date.now() - llmStart;

      // A fallback's call is booked under the model that served it.
      const measured = measureUsage(generated.servedBy?.model ?? resolveModel(options) ?? provider.name, messages, generated);
      if (inputCheck) {
        // N5b: a reply that came first waits for the checks; a trip (which aborts `callSignal`) discards it.
        inputCheck.response = { generated, measured };
        await inputCheck.verdict;
        callSignal?.throwIfAborted();
      }
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
