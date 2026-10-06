/**
 * The inbox-triage kit, tested offline: `loadAgentDir()` reads the kit's own
 * directory and a scripted `mockModel` drives the triage loop - classify,
 * draft, pause on `send_reply`, deny (nothing leaves) and approve (the reply
 * lands in the outbox). The store is a temp dir via INBOX_TRIAGE_HOME so the
 * kit's seeded data/ stays untouched.
 *
 * The kit's files import `@lousho/build-ai-agent` by name, which resolves to
 * the workspace self-link (dist/) inside this repo - like
 * examples/coding-harness/kit.test.ts this needs `npm run build` to have run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentDir, resolveAgentDir, startSchedules } from '@lousho/build-ai-agent';
import type { ChannelContext, ChannelInbound, ChannelRequest } from '@lousho/build-ai-agent';
import { mockModel, type MockModel } from '@lousho/build-ai-agent/testing';

const KIT = __dirname;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-triage-'));
process.env.INBOX_TRIAGE_HOME = home;

const SEED = [
  { id: 'm-budget', from: 'priya@acme.com', subject: 'Invoice #1042 question', body: 'Hi - the invoice lists 12 seats but we only have 10. Confirm before Friday?', receivedAt: '2026-01-05T09:12:00.000Z', status: 'new' },
  { id: 'm-spam', from: 'winner@lottery-prizes.example', subject: 'You WON $5,000,000', body: 'Claim your prize now - reply with your bank details.', receivedAt: '2026-01-05T07:30:00.000Z', status: 'new' },
];

function resetHome() {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'inbox.json'), `${JSON.stringify(SEED, null, 2)}\n`, 'utf8');
}

interface JsonRecord {
  [key: string]: unknown;
}

function readJson(name: string): JsonRecord[] {
  return JSON.parse(fs.readFileSync(path.join(home, name), 'utf8')) as JsonRecord[];
}

const exists = (name: string): boolean => fs.existsSync(path.join(home, name));

const toolOutputs = (provider: MockModel): string =>
  provider.calls[provider.calls.length - 1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');

const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);

beforeEach(resetHome);
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('the kit directory, resolved', () => {
  it('discovers tools, the poll schedule, the inbound channel and the senders memory', async () => {
    const { config, manifest, schedules, channels } = await resolveAgentDir(KIT, { provider: mockModel(['x']) });

    expect(manifest.name).toBe('inbox-triage');
    expect([...manifest.tools].sort()).toEqual(
      ['classify_message', 'delete_message', 'draft_reply', 'list_drafts', 'list_messages', 'mark_processed', 'read_message', 'send_reply'].sort()
    );
    expect(manifest.schedules).toEqual(['poll-inbox']);
    expect(manifest.channels).toEqual(['inbound']);
    expect(manifest.memory).toEqual(['senders']);
    expect(schedules[0].cron).toBe('*/15 * * * *');
    expect(schedules[0].prompt).toContain('list_messages');
    expect(channels[0].name).toBe('inbound');
    expect(manifest.files.some((file) => file.endsWith('hooks.ts'))).toBe(true);
  });

  it('appends instructions/openai.md when the model id names the openai family', async () => {
    const { config } = await resolveAgentDir(KIT, { provider: mockModel(['x']), model: 'openai/test-model' });
    expect(String(config.instructions)).toContain('one tool call at a time');
  });
});

describe('the loaded kit, offline', () => {
  it('classifies, drafts, pauses send_reply for the human and sends only on approval', async () => {
    const audit: string[] = [];
    const provider = mockModel([
      { toolCalls: [{ name: 'list_messages', args: { status: 'new' } }] },
      { toolCalls: [{ name: 'classify_message', args: { id: 'm-budget', category: 'reply-needed', reason: 'customer billing question' } }] },
      { toolCalls: [{ name: 'remember_senders', args: { text: 'priya@acme.com - billing contact at Acme, wants plain acknowledgements' } }] },
      { toolCalls: [{ name: 'draft_reply', args: { messageId: 'm-budget', body: 'Hi Priya - you are right, it is 10 seats. A corrected invoice goes out Friday.' } }] },
      { toolCalls: [{ name: 'send_reply', args: { messageId: 'm-budget', draftId: 'draft-m-budget-1' } }] },
      // the run continues after the denial
      { toolCalls: [{ name: 'mark_processed', args: { id: 'm-spam' } }] },
      { text: 'Held the reply to Priya for review; processed the spam message.' },
      // second run: the human approves
      { toolCalls: [{ name: 'send_reply', args: { messageId: 'm-budget', draftId: 'draft-m-budget-1' } }] },
      { text: 'Sent the corrected-invoice reply to Priya.' },
      // third run: recall surfaces the sender fact in the system prompt
      { text: 'Done.' },
    ]);
    const agent = await loadAgentDir(KIT, {
      provider,
      onPermissionDecision: (entry) => audit.push(`${entry.toolName}:${entry.decision}`),
    });

    const paused = await agent.send('Triage the inbox.');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(exists('outbox.json')).toBe(false); // nothing leaves before the human decides

    const denied = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'Not yet' });
    expect(denied.finishReason).toBe('stop');
    expect(exists('outbox.json')).toBe(false);

    const drafts = readJson('drafts.json');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: 'draft-m-budget-1', messageId: 'm-budget', to: 'priya@acme.com', status: 'draft' });
    const message = readJson('inbox.json').find((m) => m.id === 'm-budget');
    expect(message).toMatchObject({ category: 'reply-needed', status: 'triaged' });
    expect(readJson('inbox.json').find((m) => m.id === 'm-spam')).toMatchObject({ status: 'processed' });
    expect(audit).toContain('send_reply:ask');

    // memory was written: senders slot, shared scope (no sender principal in a bare send)
    const memoryFile = path.join(home, 'memory', 'shared.json');
    expect(fs.existsSync(memoryFile)).toBe(true);
    expect(fs.readFileSync(memoryFile, 'utf8')).toContain('priya@acme.com');

    const pausedAgain = await agent.send('Send the pending reply.');
    expect(pausedAgain.finishReason).toBe('awaiting-approval');
    const done = await agent.approvals.resolve({ id: pausedAgain.approvalId!, approved: true });
    expect(done.text).toContain('Sent');

    const outbox = readJson('outbox.json');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ messageId: 'm-budget', draftId: 'draft-m-budget-1', to: 'priya@acme.com' });
    expect(String(outbox[0].body)).toContain('10 seats');
    expect(readJson('inbox.json').find((m) => m.id === 'm-budget')).toMatchObject({ status: 'replied' });
    expect(readJson('drafts.json')[0]).toMatchObject({ status: 'sent' });

    // the remembered sender fact is recalled into the next run's system prompt
    await agent.send('Anything new?');
    expect(systemOf(provider.calls[provider.calls.length - 1])).toContain('<memory name="senders">');
    expect(systemOf(provider.calls[provider.calls.length - 1])).toContain('priya@acme.com');
  }, 30_000);

  it('denies delete_message outright and refuses a send_reply with placeholders before the pause', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'delete_message', args: { id: 'm-spam' } }] },
      { toolCalls: [{ name: 'send_reply', args: { messageId: 'm-budget', body: 'Hi [NAME], thanks for writing in.' } }] },
      { text: 'Deletion denied; the placeholder draft was refused too.' },
    ]);
    const agent = await loadAgentDir(KIT, { provider });

    const result = await agent.send('Delete the spam and reply to the invoice mail.');

    expect(result.finishReason).toBe('stop'); // no pause: deny rule + hook, not an approval
    expect(readJson('inbox.json').find((m) => m.id === 'm-spam')).toMatchObject({ status: 'new' });
    const outputs = toolOutputs(provider);
    expect(outputs).toContain('Triage never deletes');
    expect(outputs).toContain('[NAME]');
    expect(exists('outbox.json')).toBe(false);
  });
});

describe('intake', () => {
  it('poll-inbox fires its sweep prompt on the cron tick', async () => {
    const provider = mockModel([{ text: 'Nothing new.' }]);
    const agent = await loadAgentDir(KIT, { provider });
    const { schedules } = await resolveAgentDir(KIT, { provider });

    let now = Date.parse('2026-01-05T12:00:00Z');
    let fire: (() => void) | undefined;
    const running = startSchedules(agent, schedules, {
      now: () => now,
      setTimer: (fn) => {
        fire = fn;
        return () => {};
      },
    });
    try {
      expect(fire).toBeDefined();
      now += 15 * 60 * 1000; // past the next quarter-hour boundary
      fire!();
      await vi.waitFor(() => expect(provider.calls.length).toBe(1));
      const prompt = String(provider.calls[0].messages.at(-1)?.content);
      expect(prompt).toContain('list_messages');
      expect(prompt).toContain('classify_message');
    } finally {
      running.stop();
    }
  });

  it('the inbound channel files a posted message and hands the turn to the sender', async () => {
    const { channels } = await resolveAgentDir(KIT, { provider: mockModel(['x']) });
    const channel = channels[0];

    const body = JSON.stringify({ from: 'bob@corp.example', subject: 'Pricing?', body: 'What does the team plan cost?' });
    const req: ChannelRequest = { method: 'POST', url: '/channels/inbound', headers: {}, rawBody: new TextEncoder().encode(body), text: body };
    const ctx: ChannelContext = {
      approval: async () => undefined,
      sessionId: (key) => `inbound:${key}`,
      hasSession: async () => false,
      pendingQuestion: async () => undefined,
    };

    expect(await channel.verify?.(req)).toBe(true); // INBOUND_TOKEN unset: open intake
    const inbound = (await channel.parse(req, () => {}, ctx)) as ChannelInbound;
    expect(inbound.sessionKey).toBe('bob@corp.example');
    expect(inbound.metadata).toMatchObject({ sender: 'bob@corp.example' });
    expect(inbound.principal).toMatchObject({ id: 'bob@corp.example' });
    expect(String(inbound.input)).toContain('Pricing?');

    const message = readJson('inbox.json').find((m) => m.from === 'bob@corp.example');
    expect(message).toMatchObject({ subject: 'Pricing?', status: 'new' });

    let responded: unknown;
    await channel.reply({ inbound, sessionId: 's-1', text: 'triaged', respond: (_status, out) => (responded = out) });
    expect(responded).toMatchObject({ ok: true, messageId: message?.id });
  });
});

describe('live', () => {
  it.skipIf(!process.env.OPENROUTER_API_KEY)('triages the seeded inbox on the real model', async () => {
    const agent = await loadAgentDir(KIT);
    const result = await agent.send('Triage the inbox: classify everything new, draft a reply where one is needed.');
    // whatever it does, it must stop at a send for a human - or stop cleanly
    if (result.finishReason === 'awaiting-approval') {
      await agent.approvals.resolve({ id: result.approvalId!, approved: false, note: 'test: do not actually send' });
    }
    const inbox = readJson('inbox.json');
    expect(inbox.every((message) => message.status !== 'new')).toBe(true);
    expect(exists('outbox.json')).toBe(false);
  }, 120_000);
});
