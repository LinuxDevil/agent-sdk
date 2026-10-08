/**
 * N2: tool search, offline with mockModel. Each test reads the tool names of
 * every model call (`model.calls[i].tools`) to see what was offered when.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockModel } from '../testing';
import type { AgentEvent } from './agentEvents';
import type { Message } from '../providers';
import { AgentExecutor } from './AgentExecutor';
import { AgentBuilder } from '../core/AgentBuilder';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolSearchResult } from './toolSearch';
import { loadedToolNames, visibleTools } from './toolDeferral';
import { defineSkill } from '../skills/defineSkill';

afterEach(() => {
  vi.restoreAllMocks();
});

const names = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const systemOf = (model: MockModel, call: number) => (model.calls[call].messages.find((m) => m.role === 'system')?.content as string) ?? '';
const searchFor = (query: string, id = 'call_search') => ({ toolCalls: [{ name: 'tool_search', args: { query }, id }] });
const toolResult = (messages: readonly Message[], id: string) => JSON.parse(messages.find((m) => m.toolCallId === id)?.content as string) as ToolSearchResult;

/** A small tool with a fixed result. */
function tool(name: string, description: string, options: { deferLoading?: boolean; needsApproval?: boolean } = {}): DefinedTool {
  return defineTool({ name, description, input: z.object({ amount: z.number().optional() }), execute: async () => ({ tool: name }), ...options });
}

/** Five deferred tools and one that is always sent. */
function catalog(options: { approval?: boolean } = {}): DefinedTool[] {
  return [
    tool('send_email', 'Send an email'),
    tool('get_weather', 'Get the weather forecast for a city', { deferLoading: true }),
    tool('convert_currency', 'Convert an amount of money from one currency to another', { deferLoading: true, needsApproval: options.approval }),
    tool('lookup_stock', 'Look up the price of a stock', { deferLoading: true }),
    tool('exchange_rates', 'List currency exchange rates', { deferLoading: true }),
    tool('translate_text', 'Translate text to another language', { deferLoading: true }),
  ];
}

const always = { thresholdPercent: 0 };

describe('tool search (N2): deferral', () => {
  it('withholds deferred tools and offers tool_search; the system prompt says how many and how to search', async () => {
    const model = mockModel(['Hi.']);
    const agent = createAgent({ provider: model, instructions: 'Be brief.', tools: catalog(), toolSearch: always });
    await agent.send('hello');
    expect(names(model, 0)).toEqual(['send_email', 'tool_search']);
    expect(systemOf(model, 0)).toContain('## Tool search');
    expect(systemOf(model, 0)).toContain('5 more tools are available but not loaded yet.');
    expect(model.calls[0].tools?.find((t) => t.function.name === 'tool_search')?.function.description).toMatch(/Search for more tools/);
  });

  it('after a tool_search call the next request has the matches, best first, and the result says what is left', async () => {
    const model = mockModel([searchFor('currency conversion'), 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: always });
    const result = await agent.send('What is 100 USD in EUR?');
    expect(names(model, 1)).toEqual(['send_email', 'convert_currency', 'exchange_rates', 'tool_search']);
    const found = toolResult(result.messages, 'call_search');
    expect(found.loaded.map((t) => t.name)).toEqual(['convert_currency', 'exchange_rates']);
    expect(found.loaded[0].description).toBe('Convert an amount of money from one currency to another');
    expect(found.more).toBe(3);
  });

  it('maxResults caps the tools one search loads', async () => {
    const model = mockModel([searchFor('currency'), 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: { thresholdPercent: 0, maxResults: 1 } });
    const result = await agent.send('x');
    expect(names(model, 1)).toEqual(['send_email', 'convert_currency', 'tool_search']);
    expect(toolResult(result.messages, 'call_search')).toEqual({
      loaded: [{ name: 'convert_currency', description: 'Convert an amount of money from one currency to another' }],
      more: 4,
    });
  });

  it('a custom search ranks the tools; unknown names and duplicates are dropped', async () => {
    const search = vi.fn(() => ['lookup_stock', 'nope', 'lookup_stock', 'send_email', 'get_weather']);
    const model = mockModel([searchFor('anything'), 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: { thresholdPercent: 0, search } });
    const result = await agent.send('x');
    expect(search).toHaveBeenCalledWith('anything', expect.arrayContaining([{ name: 'get_weather', description: 'Get the weather forecast for a city' }]));
    expect((search.mock.calls[0] as unknown[])[1]).toHaveLength(5);
    expect(toolResult(result.messages, 'call_search').loaded.map((t) => t.name)).toEqual(['lookup_stock', 'get_weather']);
    expect(names(model, 1)).toEqual(['send_email', 'get_weather', 'lookup_stock', 'tool_search']);
  });

  it('a custom search that throws is a tool error and loads nothing', async () => {
    const model = mockModel([searchFor('anything'), 'Done.']);
    const search = () => {
      throw new Error('index offline');
    };
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: { thresholdPercent: 0, search } });
    const result = await agent.send('x');
    const message = result.messages.find((m) => m.toolCallId === 'call_search');
    expect(message?.isError).toBe(true);
    expect(message?.content).toContain('tool_search failed: index offline');
    expect(names(model, 1)).toEqual(['send_email', 'tool_search']);
  });

  it('below the threshold (default 10% of the window) every tool is sent and no tool_search exists', async () => {
    const model = mockModel(['Hi.']);
    const agent = createAgent({ provider: model, tools: catalog() });
    await agent.send('hello');
    expect(names(model, 0)).toEqual(['send_email', 'get_weather', 'convert_currency', 'lookup_stock', 'exchange_rates', 'translate_text']);
    expect(systemOf(model, 0)).not.toContain('Tool search');
  });

  it('at the threshold it defers: a small contextWindow makes the same tools worth deferring', async () => {
    const model = mockModel(['Hi.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: { contextWindow: 1000 } });
    await agent.send('hello');
    expect(names(model, 0)).toEqual(['send_email', 'tool_search']);
  });

  it('warns once, naming toolSearch.contextWindow and registerModel(), when it assumes the 128,000-token fallback window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = mockModel(['Hi.', 'Hi.']);
    const agent = createAgent({ provider: model, model: 'unknown-local-tool-search-model', tools: catalog() });
    await agent.send('hello');
    await agent.send('again');
    const warnings = warn.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('unknown-local-tool-search-model'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tool search assumes a 128,000-token context window');
    expect(warnings[0]).toContain("'toolSearch.contextWindow'");
    expect(warnings[0]).toContain('registerModel(');
  });

  it('toolSearch: false sends every tool upfront', async () => {
    const model = mockModel(['Hi.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: false });
    await agent.send('hello');
    expect(names(model, 0)).toHaveLength(6);
    expect(names(model, 0)).not.toContain('tool_search');
  });

  it('once every deferred tool is loaded, tool_search is no longer offered', async () => {
    const model = mockModel([searchFor('weather currency stock exchange translate'), 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: always });
    await agent.send('x');
    expect(names(model, 1)).toEqual(['send_email', 'get_weather', 'convert_currency', 'lookup_stock', 'exchange_rates', 'translate_text']);
  });

  it('a deferred tool the model calls before it is loaded runs like any tool', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'lookup_stock', args: {}, id: 'call_stock' }] }, 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: always });
    const result = await agent.send('x');
    expect(result.messages.find((m) => m.toolCallId === 'call_stock')?.content).toBe(JSON.stringify({ tool: 'lookup_stock' }));
    expect(names(model, 1)).toEqual(['send_email', 'tool_search']);
  });

  it('stream() shows tool_search as an ordinary tool.start / tool.done', async () => {
    const model = mockModel([searchFor('weather'), 'Done.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: always });
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('x')) events.push(event);
    expect(events.find((e) => e.type === 'tool.start')).toMatchObject({ toolName: 'tool_search', toolCallId: 'call_search' });
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ toolName: 'tool_search', toolCallId: 'call_search' });
  });

  it('a user tool named tool_search is refused when deferral applies (and allowed when it does not)', async () => {
    const own = tool('tool_search', 'My own search');
    const deferred = createAgent({ provider: mockModel(['Hi.']), tools: [...catalog(), own], toolSearch: always });
    await expect(deferred.send('x')).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringContaining("a tool named 'tool_search' is already registered") });
    const plain = createAgent({ provider: mockModel(['Hi.']), tools: [...catalog(), own] });
    await expect(plain.send('x')).resolves.toMatchObject({ text: 'Hi.' });
  });

  it('skills: load_skill is never deferred', async () => {
    const model = mockModel(['Hi.']);
    const skill = defineSkill({ name: 'tone', description: 'Write in a friendly tone', content: 'Be friendly.' });
    const agent = createAgent({ provider: model, tools: catalog(), skills: [skill], toolSearch: always });
    await agent.send('x');
    expect(names(model, 0)).toEqual(['send_email', 'load_skill', 'tool_search']);
  });

  it('invalid toolSearch options are refused when the agent is created', () => {
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { thresholdPercent: 2 } })).toThrow(/'toolSearch.thresholdPercent' must be a number from 0 to 1/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { maxResults: 0 } })).toThrow(/'toolSearch.maxResults' must be a whole number >= 1/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: { contextWindow: -1 } })).toThrow(/'toolSearch.contextWindow' must be a positive number/);
    expect(() => createAgent({ provider: mockModel([]), toolSearch: 'auto' as never })).toThrow(/'toolSearch' must be false or an object/);
  });

  it('AgentExecutor.execute({ toolSearch }) works without createAgent', async () => {
    const registry = new ToolRegistry();
    const builder = AgentBuilder.create().setName('direct').setPrompt('Be brief.');
    for (const t of catalog()) {
      registry.register(t);
      builder.addTool(t);
    }
    const model = mockModel([searchFor('weather'), 'Done.']);
    await AgentExecutor.execute({ agent: builder.build(), input: 'x', provider: model, toolRegistry: registry, toolSearch: always });
    expect(names(model, 0)).toEqual(['send_email', 'tool_search']);
    expect(names(model, 1)).toEqual(['send_email', 'get_weather', 'tool_search']);
  });
});

describe('tool search (N2): what is loaded persists through the transcript', () => {
  it('a crash resume from a checkpoint taken after the search keeps the loaded tools, with no drift warning', async () => {
    const store = memoryStore();
    const crashed = mockModel([searchFor('weather'), { error: new Error('process died') }]);
    const first = createAgent({ provider: crashed, tools: catalog(), toolSearch: always, store });
    await expect(first.send('Weather in Paris?', { sessionId: 'job-1' })).rejects.toThrow();
    expect(names(crashed, 1)).toEqual(['send_email', 'get_weather', 'tool_search']);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: AgentEvent[] = [];
    const resumed = mockModel(['Sunny.']);
    const second = createAgent({ provider: resumed, tools: catalog(), toolSearch: always, store, onEvent: (event) => events.push(event) });
    const result = await second.resume('job-1');
    expect(result?.text).toBe('Sunny.');
    expect(names(resumed, 0)).toEqual(['send_email', 'get_weather', 'tool_search']);
    expect(events.some((event) => event.type === 'agent.drift')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a session's next turn keeps the tools loaded in an earlier turn", async () => {
    const model = mockModel([searchFor('weather'), 'Sunny.', 'Still sunny.']);
    const agent = createAgent({ provider: model, tools: catalog(), toolSearch: always });
    const session = agent.session();
    await session.send('Weather in Paris?');
    await session.send('And tomorrow?');
    expect(names(model, 2)).toEqual(['send_email', 'get_weather', 'tool_search']);
  });

  it('an approval pause and its resume keep the loaded tools', async () => {
    const model = mockModel([searchFor('currency'), { toolCalls: [{ name: 'convert_currency', args: { amount: 100 }, id: 'call_convert' }] }, 'It is 92 EUR.']);
    const agent = createAgent({ provider: model, tools: catalog({ approval: true }), toolSearch: always });
    const paused = await agent.send('100 USD in EUR?');
    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId as string, approved: true });
    expect(result.text).toBe('It is 92 EUR.');
    expect(names(model, 2)).toEqual(['send_email', 'convert_currency', 'exchange_rates', 'tool_search']);
  });

  it('a compaction that prunes the tool_search result unloads its tools; the model can search again', async () => {
    const model = mockModel([searchFor('weather'), { toolCalls: [{ name: 'get_weather', args: {}, id: 'call_weather' }] }, 'Sunny.']);
    const agent = createAgent({
      provider: model,
      tools: catalog(),
      toolSearch: always,
      compaction: { thresholdPercent: 0.01, contextWindow: 100, protectedTokens: 1 },
    });
    const result = await agent.send('Weather in Paris?');
    // Step 2: the result is new (after the last assistant turn), so it is kept and the tool is loaded.
    expect(names(model, 1)).toEqual(['send_email', 'get_weather', 'tool_search']);
    // Step 3: the search result was pruned, so get_weather is withheld again.
    expect(model.calls[2].messages.find((m) => m.toolCallId === 'call_search')?.content).toMatch(/^\[pruned: tool_search\(/);
    expect(names(model, 2)).toEqual(['send_email', 'tool_search']);
    expect(result.text).toBe('Sunny.');
  });

  it('loadedToolNames() ignores error results, unknown names and results before the last handoff', () => {
    const deferred = new Set(['a', 'b', 'c']);
    const search = (id: string, loaded: string[], extra: Partial<Message> = {}): Message => ({
      role: 'tool',
      toolName: 'tool_search',
      toolCallId: id,
      content: JSON.stringify({ loaded: loaded.map((name) => ({ name, description: '' })), more: 0 }),
      ...extra,
    });
    expect([...loadedToolNames([search('1', ['a', 'zzz']), search('2', ['b'], { isError: true })], deferred)]).toEqual(['a']);
    const handedOff: Message[] = [search('1', ['a']), { role: 'tool', toolCallId: 'h', content: '{}', metadata: { handoff: { from: 'x', to: 'y' } } }, search('2', ['c'])];
    expect([...loadedToolNames(handedOff, deferred)]).toEqual(['c']);
    const all = [{ type: 'function' as const, function: { name: 'a', description: '', parameters: {} } }];
    expect(visibleTools(all, [], undefined)).toBe(all);
  });
});

describe('tool search (N2): per agent', () => {
  it('a handoff target does not inherit what the lead loaded; it has its own deferral', async () => {
    const triageModel = mockModel([searchFor('currency'), { toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] }]);
    const billingModel = mockModel([searchFor('weather', 'call_billing_search'), 'Done.']);
    const billing = createAgent({ name: 'billing', description: 'Handles billing', provider: billingModel, tools: catalog(), toolSearch: always });
    const triage = createAgent({ name: 'triage', provider: triageModel, tools: catalog(), toolSearch: always, handoffs: [billing] });
    const result = await triage.send('Refund me in EUR');
    expect(result.agentName).toBe('billing');
    // Handoff tools are never deferred.
    expect(names(triageModel, 0)).toEqual(['send_email', 'tool_search', 'transfer_to_billing']);
    expect(names(triageModel, 1)).toEqual(['send_email', 'convert_currency', 'exchange_rates', 'tool_search', 'transfer_to_billing']);
    // The lead's search result is still in the transcript, but billing starts with nothing loaded.
    expect(billingModel.calls[0].messages.some((m) => m.toolCallId === 'call_search')).toBe(true);
    expect(names(billingModel, 0)).toEqual(['send_email', 'tool_search']);
    expect(names(billingModel, 1)).toEqual(['send_email', 'get_weather', 'tool_search']);
  });

  it('a handoff target without deferred tools gets no tool_search', async () => {
    const triageModel = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] }]);
    const billingModel = mockModel(['Done.']);
    const billing = createAgent({ name: 'billing', description: 'Handles billing', provider: billingModel, tools: [tool('refund', 'Refund a charge')] });
    const triage = createAgent({ name: 'triage', provider: triageModel, tools: catalog(), toolSearch: always, handoffs: [billing] });
    await triage.send('Refund me');
    expect(names(billingModel, 0)).toEqual(['refund']);
    expect(systemOf(billingModel, 0)).not.toContain('Tool search');
  });

  it('a sub-agent runs its own tool list: its deferred tools, none of the lead loaded', async () => {
    const childModel = mockModel(['Child done.']);
    const child = createAgent({ name: 'helper', description: 'Helps', provider: childModel, tools: catalog(), toolSearch: always });
    const leadModel = mockModel([searchFor('weather'), { toolCalls: [{ name: 'task', args: { agent: 'helper', prompt: 'Do it', description: 'help out' }, id: 'call_task' }] }, 'Lead done.']);
    const lead = createAgent({ provider: leadModel, tools: catalog(), toolSearch: always, subagents: { helper: child } });
    await lead.send('x');
    expect(names(leadModel, 0)).toEqual(['send_email', 'task', 'agent_status', 'agent_await', 'agent_cancel', 'tool_search']);
    expect(names(childModel, 0)).toEqual(['send_email', 'tool_search']);
  });
});
