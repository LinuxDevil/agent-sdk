import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentDir } from './agentDir/loadAgentDir';
import { createAgent } from './createAgent';
import type { Span, TraceExporter } from './execution/tracing';
import { routesToCandidate } from './improve/canaryArm';
import { harnessHash, readAgentHarness } from './improve/revisions';
import { loadImproveSettings } from './improve/settings';
import { startCanary, stopCanary } from './improve/trafficCanary';
import type { ImproveResult } from './improve/types';
import { openDb } from './observe/store';
import { defineSkill } from './skills/defineSkill';
import { memoryStore } from './storage/agentStore';
import { mockModel } from './testing';

function recording(): TraceExporter & { ended: Span[] } {
  const ended: Span[] = [];
  return { ended, onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };
}

const revisionOf = (spans: Span[]) => spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent').at(-1)!.attributes['lousho.harness.revision'];
const systemOf = (model: ReturnType<typeof mockModel>) => JSON.stringify(model.calls.at(-1)!.messages.filter((message) => message.role === 'system'));
const ids = Array.from({ length: 400 }, (_, i) => `session-${i}`);
const routed = ids.find((id) => routesToCandidate(id, 0.1)) as string;
const unrouted = ids.find((id) => !routesToCandidate(id, 0.1)) as string;
const routedLater = ids.filter((id) => routesToCandidate(id, 0.1))[1];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-canary-agent-'));
  fs.writeFileSync(path.join(dir, 'instructions.md'), 'Answer refund questions.\n');
  fs.mkdirSync(path.join(dir, 'skills', 'refunds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'refunds', 'SKILL.md'), '---\nname: refunds\ndescription: Refund rules\n---\n\nCheck the receipt first.\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const optIn = () => fs.writeFileSync(path.join(dir, 'improve.json'), JSON.stringify({ canary: { traffic: { share: 0.1, sessions: 10 } } }));

async function start() {
  const base = readAgentHarness(dir);
  const candidate = { instructions: 'Answer refund questions. Quote the policy.', skills: { ...base.skills, tone: { description: 'Tone rules', content: 'Be warm.' } } };
  const result: ImproveResult = { outcome: 'proposal', reason: 'Gate passed.', harness: candidate, base: { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 1 }, stages: [], spend: { tokens: 0 } };
  const db = openDb(':memory:');
  try {
    return await startCanary(db, dir, { result, base }, loadImproveSettings(dir, {}, {}));
  } finally {
    db.close();
  }
}

async function send(sessionId: string) {
  const model = mockModel(['Hi.']);
  const exporter = recording();
  await (await loadAgentDir(dir, { provider: model, exporter, store: memoryStore() })).send('Hello', { sessionId });
  return { system: systemOf(model), revision: revisionOf(exporter.ended) };
}

describe('the live traffic canary in loadAgentDir', () => {
  it('with no canary.json the system prompt is byte-identical, opted in or not', async () => {
    const plain = await send(routed);
    optIn();
    const opted = await send(routed);
    expect(opted).toEqual(plain);
    expect(plain.revision).toBe(harnessHash(readAgentHarness(dir)));
  });

  it('serves the candidate to a routed session and stamps its revision', async () => {
    optIn();
    const canary = await start();
    const served = await send(routed);
    expect(served.system).toContain('Quote the policy.');
    expect(served.system).toContain('tone');
    expect(served.revision).toBe(canary.revision);
    const other = await send(unrouted);
    expect(other.system).not.toContain('Quote the policy.');
    expect(other.revision).toBe(canary.baseRevision);
  });

  it('stops serving the candidate to new sessions on the next run after the canary ends', async () => {
    optIn();
    await start();
    const model = mockModel(['One.', 'Two.']);
    const exporter = recording();
    const agent = await loadAgentDir(dir, { provider: model, exporter, store: memoryStore() });
    await agent.send('Hello', { sessionId: routed });
    expect(systemOf(model)).toContain('Quote the policy.');
    await stopCanary(dir, { actor: 'scheduler', reason: 'Stopped.' });
    await agent.send('Hello', { sessionId: routedLater });
    expect(systemOf(model)).not.toContain('Quote the policy.');
    expect(revisionOf(exporter.ended)).toBe(harnessHash(readAgentHarness(dir)));
  });

  it('a caller override of instructions or skills turns the canary off', async () => {
    optIn();
    await start();
    const model = mockModel(['Hi.']);
    await (await loadAgentDir(dir, { provider: model, instructions: 'Overridden.', store: memoryStore() })).send('Hello', { sessionId: routed });
    expect(systemOf(model)).not.toContain('Quote the policy.');
  });
});

describe('createAgent({ harnessCanary })', () => {
  const skills = [defineSkill({ name: 'refunds', description: 'Refund rules', content: 'Check the receipt first.' })];

  it('serves the arm the callback returns, per run, and stamps its revision', async () => {
    const model = mockModel(['A.', 'B.']);
    const exporter = recording();
    const arm = { instructions: 'Be bold.', skills: [] };
    const agent = createAgent({ name: 'a', instructions: 'Be careful.', skills, provider: model, exporter, store: memoryStore(), harnessCanary: (ctx) => (ctx.sessionId === 'x' ? arm : undefined) });
    await agent.send('Hello', { sessionId: 'x' });
    expect(systemOf(model)).toContain('Be bold.');
    expect(systemOf(model)).not.toContain('refunds');
    expect(revisionOf(exporter.ended)).toBe(harnessHash({ instructions: 'Be bold.', skills: {} }));
    await agent.send('Hello', { sessionId: 'y' });
    expect(systemOf(model)).toContain('Be careful.');
    expect(revisionOf(exporter.ended)).toBe(harnessHash({ instructions: 'Be careful.', skills: { refunds: { description: 'Refund rules', content: 'Check the receipt first.' } } }));
  });

  it('serves the base when the callback throws', async () => {
    const model = mockModel(['A.']);
    const agent = createAgent({ name: 'a', instructions: 'Be careful.', provider: model, store: memoryStore(), harnessCanary: () => { throw new Error('broken'); } });
    await agent.send('Hello', { sessionId: 'x' });
    expect(systemOf(model)).toContain('Be careful.');
  });
});
