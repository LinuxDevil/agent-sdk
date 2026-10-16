import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel, type MockRequest } from '../testing';
import { defineMemory, inMemoryMemory, type MemoryProvider } from './index';

const systemOf = (call: MockRequest | undefined): string => String(call?.messages.find((m) => m.role === 'system')?.content ?? '');
const toolsOf = (call: MockRequest | undefined): string[] => (call?.tools ?? []).map((t) => t.function.name);
const task = (agent: string, prompt: string) => ({ name: 'task', args: { agent, prompt } });

async function seeded(key: string, texts: string[]): Promise<MemoryProvider> {
  const provider = inMemoryMemory();
  for (const text of texts) await provider.add(key, { text });
  return provider;
}

describe("a sub-agent's own memory", () => {
  it('recalls into its system prompt, offers its tools and persists what it remembers when run by the task tool', async () => {
    const provider = await seeded('runs#global', ['Last run: revenue 100.']);
    const runs = defineMemory({ name: 'runs', scope: 'global', provider });
    const analystModel = mockModel([{ toolCalls: [{ name: 'remember_runs', args: { text: 'This run: revenue 120.' } }] }, 'Up 20 since last run.']);
    const analyst = createAgent({ provider: analystModel, instructions: 'You analyze.', description: 'Analyzes runs', memory: [runs] });
    const leadModel = mockModel([{ toolCalls: [task('analyst', 'Compare with the last run.')] }, 'Done.']);
    const lead = createAgent({ provider: leadModel, subagents: { analyst } });

    const result = await lead.send('go');

    expect(result.text).toBe('Done.');
    expect(systemOf(analystModel.calls[0])).toContain('<memory name="runs">\n- Last run: revenue 100.\n</memory>');
    expect(toolsOf(analystModel.calls[0])).toEqual(expect.arrayContaining(['remember_runs', 'recall_runs']));
    expect((await provider.list('runs#global')).map((item) => item.text)).toEqual(['This run: revenue 120.', 'Last run: revenue 100.']);
    // The lead has no memory of its own: no block, no memory tools.
    expect(systemOf(leadModel.calls[0])).not.toContain('<memory');
    expect(toolsOf(leadModel.calls[0])).not.toContain('remember_runs');
  });

  it("binds its scope keys to the lead run's metadata", async () => {
    const provider = await seeded('prefs#user:u1', ['Prefers charts.']);
    const prefs = defineMemory({
      name: 'prefs',
      scope: ({ metadata }) => (typeof metadata?.userId === 'string' ? `user:${metadata.userId}` : undefined),
      provider,
    });
    const analystModel = mockModel([{ toolCalls: [{ name: 'remember_prefs', args: { text: 'Wants weekly totals.' } }] }, 'ok']);
    const analyst = createAgent({ provider: analystModel, description: 'Analyzes', memory: [prefs] });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('analyst', 'go')] }, 'Done.']), subagents: { analyst } });

    await lead.send('go', { metadata: { userId: 'u1' } });

    expect(systemOf(analystModel.calls[0])).toContain('- Prefers charts.');
    expect((await provider.list('prefs#user:u1')).map((item) => item.text)).toEqual(['Wants weekly totals.', 'Prefers charts.']);
  });

  it("keeps the lead's memory and the sub-agent's apart, also for slots of the same name", async () => {
    const leadNotes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded('notes#global', ['Lead fact.']) });
    const childNotes = defineMemory({ name: 'notes', scope: 'global', provider: await seeded('notes#global', ['Child fact.']) });
    const analystModel = mockModel(['ok']);
    const analyst = createAgent({ provider: analystModel, description: 'Analyzes', memory: [childNotes] });
    const leadModel = mockModel([{ toolCalls: [task('analyst', 'go')] }, 'Done.']);
    const lead = createAgent({ provider: leadModel, subagents: { analyst }, memory: [leadNotes] });

    await lead.send('go');

    expect(systemOf(leadModel.calls[0])).toContain('- Lead fact.');
    expect(systemOf(leadModel.calls[0])).not.toContain('Child fact.');
    expect(systemOf(analystModel.calls[0])).toContain('- Child fact.');
    expect(systemOf(analystModel.calls[0])).not.toContain('Lead fact.');
  });
});
