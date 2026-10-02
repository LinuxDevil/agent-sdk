/**
 * N1b: `webSearch()` on the OpenRouter provider. The request body is captured
 * by a stubbed global `fetch` (the real `@ai-sdk/openai` of the installed peer
 * builds it), and the responses are shaped like OpenRouter's Chat Completions
 * responses with a server-side web search as the live run (the cassette of
 * hostedTools.openrouter.replay.test.ts) showed them: `url_citation`
 * annotations on the message and no search count in `usage`; one test adds
 * the documented `usage.server_tool_use.web_search_requests`. Runs on every
 * `ai` major.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { StreamChunk } from './llm';
import { codeInterpreter, fileSearch, webSearch } from '../tools/hosted';
import { createAgent } from '../createAgent';
import type { AgentEvent } from '../execution/agentEvents';

const CITATION = { type: 'url_citation', url_citation: { url: 'https://nodejs.org/en/blog', title: 'Node.js blog', start_index: 0, end_index: 10, content: 'Node' } };
const OTHER_CITATION = { type: 'url_citation', url_citation: { url: 'https://github.com/nodejs/node', title: 'nodejs/node', start_index: 11, end_index: 20, content: 'Node' } };

const USAGE = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };

function completion(options: { annotations?: unknown[]; requests?: number; text?: string } = {}) {
  const { annotations = [CITATION, OTHER_CITATION], requests = 0, text = 'Node 24 is current. https://nodejs.org/en/blog' } = options;
  return {
    id: 'gen-1730000000-abc',
    object: 'chat.completion',
    created: 1730000000,
    model: 'openai/gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: text, annotations }, finish_reason: 'stop' }],
    usage: { ...USAGE, ...(requests > 0 && { server_tool_use: { web_search_requests: requests } }) },
  };
}

function sse(chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function streamedCompletion(): Response {
  const base = { id: 'gen-1730000001-def', object: 'chat.completion.chunk', created: 1730000001, model: 'openai/gpt-4o-mini' };
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Node 24 ' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'is current.', annotations: [CITATION] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: USAGE },
  ]);
}

/** The JSON bodies posted to OpenRouter by `fetch` calls, in order. */
function stubFetch(respond: () => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return respond();
  });
  return bodies;
}

function provider(): OpenRouterProvider {
  return new OpenRouterProvider({ name: 'openrouter', apiKey: 'test-key', maxRetries: 0, defaultModel: 'openai/gpt-4o-mini' });
}

const messages = [{ role: 'user' as const, content: 'What is the latest Node.js?' }];
const lookup = { type: 'function' as const, function: { name: 'lookup', description: 'Look up', parameters: z.object({}) } };

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenRouter web search: the request body', () => {
  it('adds openrouter:web_search after the function tools, with the options mapped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bodies = stubFetch(() => Response.json(completion()));
    await provider().generate({
      messages,
      tools: [lookup],
      hostedTools: [
        webSearch({ maxUses: 1, allowedDomains: ['nodejs.org'], blockedDomains: ['x.com'], searchContextSize: 'low', userLocation: { country: 'DE' } }),
      ],
    });
    const tools = bodies[0]!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'lookup' } });
    expect(tools[1]).toEqual({
      type: 'openrouter:web_search',
      parameters: { max_uses: 1, allowed_domains: ['nodejs.org'], excluded_domains: ['x.com'], search_context_size: 'low' },
    });
  });

  it('creates the tools array when the call has no function tools, and omits empty parameters', async () => {
    const bodies = stubFetch(() => Response.json(completion()));
    await provider().generate({ messages, hostedTools: [webSearch()] });
    expect(bodies[0]!.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('with reasoning on, both the reasoning field and the search tool are in the body', async () => {
    const bodies = stubFetch(() => Response.json(completion()));
    await provider().generate({ messages, model: 'openai/o3-mini', tools: [lookup], reasoning: 'low', hostedTools: [webSearch({ maxUses: 2 })] });
    expect(bodies[0]!.reasoning).toEqual({ effort: 'low' });
    expect((bodies[0]!.tools as unknown[]).at(-1)).toEqual({ type: 'openrouter:web_search', parameters: { max_uses: 2 } });
    expect(bodies[0]!.tools).toHaveLength(2);
  });

  it('without a hosted tool the body has no search entry (and none is added for reasoning alone)', async () => {
    const bodies = stubFetch(() => Response.json(completion({ annotations: [], requests: 0 })));
    await provider().generate({ messages, tools: [lookup] });
    await provider().generate({ messages, model: 'openai/o3-mini', reasoning: 'low' });
    expect(JSON.stringify(bodies[0])).not.toContain('openrouter:web_search');
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.reasoning).toEqual({ effort: 'low' });
  });
});

describe('OpenRouter web search: the reported call', () => {
  it('generate(): one hosted call with the request count and the cited sources', async () => {
    stubFetch(() => Response.json(completion()));
    const result = await provider().generate({ messages, hostedTools: [webSearch({ maxUses: 1 })] });
    expect(result.hostedToolCalls).toEqual([
      {
        id: 'gen-1730000000-abc:web_search',
        name: 'web_search',
        args: {},
        result: {},
        sources: [
          { url: 'https://nodejs.org/en/blog', title: 'Node.js blog' },
          { url: 'https://github.com/nodejs/node', title: 'nodejs/node' },
        ],
      },
    ]);
    expect(result.toolCalls ?? []).toEqual([]);
  });

  it('usage.server_tool_use.web_search_requests, when OpenRouter sends it, is the call result', async () => {
    stubFetch(() => Response.json(completion({ requests: 2 })));
    const result = await provider().generate({ messages, hostedTools: [webSearch()] });
    expect(result.hostedToolCalls).toEqual([expect.objectContaining({ name: 'web_search', result: { requests: 2 } })]);
  });

  it('a response that did not search reports no call', async () => {
    stubFetch(() => Response.json(completion({ annotations: [], requests: 0 })));
    const result = await provider().generate({ messages, hostedTools: [webSearch()] });
    expect(result.hostedToolCalls).toBeUndefined();
  });

  it('a request count without citations still reports the call', async () => {
    stubFetch(() => Response.json(completion({ annotations: [], requests: 1 })));
    const result = await provider().generate({ messages, hostedTools: [webSearch()] });
    expect(result.hostedToolCalls).toEqual([{ id: 'gen-1730000000-abc:web_search', name: 'web_search', args: {}, result: { requests: 1 } }]);
  });

  it('stream(): the hosted call and its result arrive before the finish chunk', async () => {
    stubFetch(streamedCompletion);
    const streamed = await provider().stream({ messages, hostedTools: [webSearch()] });
    const chunks = await collect(streamed.fullStream);
    const types = chunks.map((chunk) => chunk.type);
    expect(types.slice(-3)).toEqual(['hosted-tool-call', 'hosted-tool-result', 'finish']);
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.textDelta).join('')).toBe('Node 24 is current.');
    expect(chunks.at(-2)!.hostedToolCall).toEqual({
      id: 'gen-1730000001-def:web_search',
      name: 'web_search',
      args: {},
      result: {},
      sources: [{ url: 'https://nodejs.org/en/blog', title: 'Node.js blog' }],
    });
  });

  it('a call without web search streams unchanged', async () => {
    stubFetch(streamedCompletion);
    const streamed = await provider().stream({ messages });
    const types = (await collect(streamed.fullStream)).map((chunk) => chunk.type);
    expect(types).not.toContain('hosted-tool-call');
  });
});

describe('OpenRouter web search through an agent', () => {
  it('reports tool.start / tool.done with executedBy provider, sources in metadata and usage', async () => {
    stubFetch(streamedCompletion);
    const events: AgentEvent[] = [];
    const agent = createAgent({ provider: provider(), instructions: 'x', tools: [webSearch({ maxUses: 1 })], maxSteps: 2, onEvent: (event) => events.push(event) });
    const result = await agent.send('What is the latest Node.js?');
    const tools = events.filter((event) => event.type.startsWith('tool.'));
    expect(tools.map((event) => [event.type, 'executedBy' in event ? event.executedBy : undefined])).toEqual([
      ['tool.start', 'provider'],
      ['tool.done', 'provider'],
    ]);
    expect(result.usage.hostedToolCalls).toEqual({ web_search: 1 });
    expect(result.messages.at(-1)!.metadata?.hostedToolCalls).toEqual([
      expect.objectContaining({ name: 'web_search', sources: [{ url: 'https://nodejs.org/en/blog', title: 'Node.js blog' }] }),
    ]);
    expect(result.text).toBe('Node 24 is current.');
  });
});

describe('OpenRouter hosted tool support', () => {
  it('supports web_search; code_interpreter and file_search are LOUSHO_HOSTED_TOOL_UNSUPPORTED', async () => {
    const openRouter = provider();
    expect(openRouter.supportsHostedTool('web_search')).toBe(true);
    expect(openRouter.supportsHostedTool('code_interpreter')).toBe(false);
    expect(openRouter.supportsHostedTool('file_search')).toBe(false);
    for (const tool of [codeInterpreter(), fileSearch({ vectorStoreIds: ['vs_1'] })]) {
      await expect(openRouter.generate({ messages, hostedTools: [tool] })).rejects.toMatchObject({
        code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
        message: expect.stringContaining('OpenRouter runs only web search'),
      });
    }
  });
});
