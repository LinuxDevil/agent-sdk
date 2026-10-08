/**
 * Deterministic, zero-network scripted LLMProvider for the ops-pipeline
 * demo (LOU-J8). Not a "real" provider - it inspects the conversation
 * shape to decide what a real model would plausibly do at each step:
 *
 *  - Monitor agent turn (tools present, no tool result yet in the
 *    conversation): calls the `delegate_to_fixer` tool with the
 *    triggering user message as the delegated task.
 *  - Monitor agent's follow-up turn (tools present, a tool result already
 *    in the conversation): finishes with a short confirmation, no further
 *    tool calls.
 *  - Fixer agent turn (no tools - the fixer agent is never given a tool
 *    registry): returns a fenced ```diff block diagnosing the demo's
 *    synthetic NullPointerException.
 */
import { GenerateOptions, GenerateResult, LLMProvider, StreamResult } from '../../src/providers';
import { textOf } from '../../src/providers/content';

const DEMO_FIXER_DIFF_RESPONSE = [
  'Root cause: `order` is not null-checked before `charge()` is called.',
  '',
  '```diff',
  '--- a/src/OrderService.java',
  '+++ b/src/OrderService.java',
  '@@ -39,7 +39,9 @@',
  '   public void checkout(Order order) {',
  '-    charge(order.getPayment());',
  '+    if (order.getPayment() == null) {',
  '+      throw new IllegalArgumentException("payment is required");',
  '+    }',
  '+    charge(order.getPayment());',
  '   }',
  '```',
].join('\n');

function usageFor(text: string): GenerateResult['usage'] {
  const tokens = Math.max(1, Math.ceil(text.length / 4));
  return { promptTokens: tokens, completionTokens: tokens, totalTokens: tokens * 2 };
}

function lastUserContent(options: GenerateOptions): string {
  const lastUser = [...options.messages].reverse().find((m) => m.role === 'user');
  return lastUser ? textOf(lastUser) : '';
}

/** Monitor agent's first turn: delegate the triggering message to the fixer. */
function delegationTurn(options: GenerateOptions): GenerateResult {
  const task = lastUserContent(options);
  return {
    text: '',
    finishReason: 'tool_calls',
    usage: usageFor(task),
    toolCalls: [
      {
        id: 'call_delegate_1',
        type: 'function',
        function: {
          name: 'delegate_to_fixer',
          arguments: JSON.stringify({ task }),
        },
      },
    ],
  };
}

/** Monitor agent's follow-up turn, after the delegate tool has returned. */
function confirmationTurn(): GenerateResult {
  const text = 'Delegated to the fixer agent for review.';
  return { text, finishReason: 'stop', usage: usageFor(text) };
}

/** Fixer agent turn: no tools registered for it. */
function fixerTurn(): GenerateResult {
  return {
    text: DEMO_FIXER_DIFF_RESPONSE,
    finishReason: 'stop',
    usage: usageFor(DEMO_FIXER_DIFF_RESPONSE),
  };
}

export function createDemoProvider(): LLMProvider {
  const generate = async (options: GenerateOptions): Promise<GenerateResult> => {
    const hasTools = !!options.tools && options.tools.length > 0;
    if (!hasTools) {
      return fixerTurn();
    }
    const alreadyDelegated = options.messages.some((m) => m.role === 'tool');
    return alreadyDelegated ? confirmationTurn() : delegationTurn(options);
  };

  return {
    name: 'ops-pipeline-demo',
    generate,
    stream: async (options: GenerateOptions): Promise<StreamResult> => {
      const result = await generate(options);
      async function* full() {
        yield { type: 'text-delta' as const, textDelta: result.text };
        yield {
          type: 'finish' as const,
          finishReason: result.finishReason,
          usage: result.usage,
        };
      }
      async function* textOnly() {
        yield result.text;
      }
      return {
        fullStream: full(),
        textStream: textOnly(),
        text: Promise.resolve(result.text),
        usage: Promise.resolve(result.usage),
        finishReason: Promise.resolve(result.finishReason),
        toolCalls: Promise.resolve(result.toolCalls ?? []),
      };
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => ['ops-pipeline-demo'],
  };
}
