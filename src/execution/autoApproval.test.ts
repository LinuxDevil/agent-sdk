/**
 * `createAutoApprove` / `modelAutoApprover` / `callScopeHash` / `clipArgs`
 * (R01a): a model-scored approval that approves high scores and defers
 * everything else - it never denies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider } from '../providers';
import type { PendingApproval } from './ApprovalGate';
import {
  AUTO_APPROVAL_STRING_CAP,
  AUTO_APPROVER_SYSTEM_PROMPT,
  AUTO_APPROVAL_THRESHOLD,
  AUTO_APPROVAL_TIMEOUT_MS,
  callScopeHash,
  clipArgs,
  createAutoApprove,
  modelAutoApprover,
  type AutoApprovalDecision,
  type AutoApprovalRequest,
} from './autoApproval';

function request(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-1',
    toolCallId: 'call-1',
    toolName: 'create_issue',
    args: { title: 'Fix the flake' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const auto = (safety: number, reason = 'routine') => vi.fn(async () => ({ safety, reason }));

const isCreateIssue = (toolName: string) => toolName === 'create_issue';

describe('callScopeHash', () => {
  it('is key-order independent and arg-sensitive', async () => {
    await expect(callScopeHash('a', { x: 1, y: 2 })).resolves.toBe(await callScopeHash('a', { y: 2, x: 1 }));
    await expect(callScopeHash('a', { x: 1, y: 2 })).resolves.not.toBe(await callScopeHash('a', { x: 1, y: 3 }));
    await expect(callScopeHash('a', { x: 1 })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('clipArgs', () => {
  it('cuts strings over the cap and flags truncated', () => {
    const long = 'x'.repeat(AUTO_APPROVAL_STRING_CAP + 1000);
    const { args, truncated } = clipArgs({ note: long, n: 1 });
    expect(truncated).toBe(true);
    const clipped = args.note as string;
    expect(clipped.startsWith('x'.repeat(AUTO_APPROVAL_STRING_CAP))).toBe(true);
    expect(clipped).toContain(`(${long.length} chars)`);
    expect(args.n).toBe(1);
  });

  it('passes small args through untouched', () => {
    expect(clipArgs({ a: 'short', b: [1, 'two'] })).toEqual({ args: { a: 'short', b: [1, 'two'] }, truncated: false });
  });
});

describe('createAutoApprove', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('approves at the threshold and defers just below it', async () => {
    const approve = createAutoApprove({ autoApprover: auto(0.8), isAuto: isCreateIssue });
    await expect(approve(request())).resolves.toBe(true);

    const below = createAutoApprove({ autoApprover: auto(0.79), isAuto: isCreateIssue });
    await expect(below(request())).resolves.toBe('defer');
  });

  it('defers when the approver throws', async () => {
    const approve = createAutoApprove({
      autoApprover: vi.fn(async () => {
        throw new Error('provider down');
      }),
      isAuto: isCreateIssue,
    });
    await expect(approve(request())).resolves.toBe('defer');
  });

  it('defers at the timeout and reports the cause', async () => {
    // shouldAdvanceTime keeps crypto.subtle (callScopeHash) resolving while
    // the timeout still fires on the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const decisions: AutoApprovalDecision[] = [];
    const approve = createAutoApprove({
      autoApprover: () => new Promise<never>(() => {}),
      isAuto: isCreateIssue,
      timeoutMs: 50,
      onDecision: (d) => decisions.push(d),
    });

    await expect(approve(request())).resolves.toBe('defer');
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'escalated', cause: 'timeout', safety: null }),
    ]);
  });

  it('escalates to the fallback on a low score; fallback false still defers', async () => {
    const fallback = vi.fn(async () => false);
    const approve = createAutoApprove({ autoApprover: auto(0.1, 'risky'), isAuto: isCreateIssue, fallback });
    await expect(approve(request())).resolves.toBe('defer');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('a non-auto call returns the fallback verdict unchanged', async () => {
    const fallback = vi.fn(async () => false);
    const approve = createAutoApprove({ autoApprover: auto(1), isAuto: isCreateIssue, fallback });
    await expect(approve(request({ toolName: 'send_email' }))).resolves.toBe(false);
    await expect(approve(request({ kind: 'question' }))).resolves.toBe(false);
    await expect(approve(request({ kind: 'sign-in' }))).resolves.toBe(false);
  });

  it('never sends over-long args to the approver and reports truncated', async () => {
    const approver = auto(1);
    const decisions: Array<{ cause?: string }> = [];
    const approve = createAutoApprove({
      autoApprover: approver,
      isAuto: isCreateIssue,
      onDecision: (d) => decisions.push(d),
    });
    const long = 'y'.repeat(AUTO_APPROVAL_STRING_CAP + 1);
    await expect(approve(request({ args: { blob: long } }))).resolves.toBe('defer');
    expect(approver).not.toHaveBeenCalled();
    expect(decisions).toEqual([expect.objectContaining({ outcome: 'escalated', cause: 'truncated', safety: null })]);
  });

  it('reports approved decisions with the score and reason', async () => {
    const decisions: Array<{ outcome: string; safety: number | null; reason: string }> = [];
    const approve = createAutoApprove({
      autoApprover: auto(0.95, 'clearly routine'),
      isAuto: isCreateIssue,
      onDecision: (d) => decisions.push(d),
    });
    await approve(request());
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'approved', safety: 0.95, reason: 'clearly routine' }),
    ]);
  });

  it('a throwing onDecision listener does not change the verdict', async () => {
    const approve = createAutoApprove({
      autoApprover: auto(0.95),
      isAuto: isCreateIssue,
      onDecision: () => {
        throw new Error('listener bug');
      },
    });
    await expect(approve(request())).resolves.toBe(true);
  });

  it('hands the approver the args, the call hash and the agent context', async () => {
    const approver = vi.fn(async (_req: AutoApprovalRequest, _signal: AbortSignal) => ({ safety: 0.9, reason: 'ok' }));
    const approve = createAutoApprove({
      autoApprover: approver,
      isAuto: isCreateIssue,
      describe: () => ({ agentName: 'Support Bot', agentDescription: 'Answers tickets' }),
      lastUserMessage: () => 'please file it',
    });
    await approve(request({ args: { title: 'Fix it', body: 'short' } }));
    const sent = approver.mock.calls[0]![0];
    expect(sent.toolName).toBe('create_issue');
    expect(sent.args).toEqual({ title: 'Fix it', body: 'short' });
    expect(sent.agentName).toBe('Support Bot');
    expect(sent.agentDescription).toBe('Answers tickets');
    expect(sent.lastUserMessage).toBe('please file it');
    expect(sent.callHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the default threshold and timeout constants', () => {
    expect(AUTO_APPROVAL_THRESHOLD).toBe(0.8);
    expect(AUTO_APPROVAL_TIMEOUT_MS).toBe(8000);
  });
});

describe('modelAutoApprover', () => {
  function providerWith(text: string) {
    const generate = vi.fn(async (_options: unknown) => ({ text, finishReason: 'stop' as const }));
    const provider = { name: 'stub', generate } as unknown as LLMProvider;
    return { provider, generate };
  }

  it('parses a verdict out of prose and sends the rubric as the system message', async () => {
    const { provider, generate } = providerWith('Sure: {"safety":0.9,"reason":"ok"}');
    const approver = modelAutoApprover({ provider });
    const verdict = await approver(
      {
        toolName: 'create_issue',
        args: { title: 'Fix the flake' },
        callHash: 'abc',
        agentName: 'Support Bot',
        lastUserMessage: 'file it',
      },
      new AbortController().signal,
    );
    expect(verdict).toEqual({ safety: 0.9, reason: 'ok' });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        messages: [
          { role: 'system', content: AUTO_APPROVER_SYSTEM_PROMPT },
          expect.objectContaining({ role: 'user', content: expect.stringContaining('Tool: create_issue') }),
        ],
      }),
    );
  });

  it('throws LOUSHO_AUTO_APPROVAL_INVALID on an unusable verdict', async () => {
    const { provider } = providerWith('{"safety":"high","reason":"ok"}');
    const approver = modelAutoApprover({ provider });
    await expect(
      approver({ toolName: 't', args: {}, callHash: 'h' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LOUSHO_AUTO_APPROVAL_INVALID' });
  });
});
