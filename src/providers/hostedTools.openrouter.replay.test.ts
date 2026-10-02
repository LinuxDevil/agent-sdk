/**
 * N1b: replays the cassette recorded by hostedTools.openrouter.live.test.ts
 * (a real OpenRouter web search with `openai/gpt-4o-mini`, once through
 * `send()` and once through `stream()`), offline: the provider's hosted call
 * and its cited sources reach the run's events, messages and usage.
 */

import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { webSearch } from '../tools/hosted';
import type { AgentEvent } from '../execution/agentEvents';

const PROMPT = 'Search the web: what is the latest version of Node.js? Answer in one line with the source URL.';

function replayAgent() {
  const provider = recordReplay(undefined, { cassette: 'src/providers/__fixtures__/cassettes/n1b-openrouter-web-search.json', mode: 'replay' });
  return createAgent({ provider, model: 'openai/gpt-4o-mini', tools: [webSearch({ maxUses: 1 })], maxSteps: 2 });
}

describe('OpenRouter web search cassette', () => {
  it('replays the hosted call and its sources through send() and stream()', async () => {
    const agent = replayAgent();

    const sent = await agent.send(PROMPT);
    const calls = sent.messages.at(-1)!.metadata?.hostedToolCalls as Array<{ name: string; sources?: Array<{ url: string }> }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('web_search');
    expect(calls[0]!.sources!.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.sources![0]!.url).toMatch(/^https:\/\//);
    expect(sent.usage.hostedToolCalls).toEqual({ web_search: 1 });
    expect(sent.text).toContain('Node.js');

    const events: AgentEvent[] = [];
    for await (const event of agent.stream(PROMPT)) events.push(event);
    const provided = events.filter((event) => event.type.startsWith('tool.') && 'executedBy' in event && event.executedBy === 'provider');
    expect(provided.map((event) => event.type)).toEqual(['tool.start', 'tool.done']);
  });
});
