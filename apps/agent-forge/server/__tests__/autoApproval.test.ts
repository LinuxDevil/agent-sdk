import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoApprovalDecision, AutoApprovalRequest } from '@linuxdevil/lousho';
import { autoApprovalLogEntry, studioAutoApprover } from '../autoApproval';
import { SpendLog } from '../passes/spendLog';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';

function base() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lousho-auto-approval-'));
  return {
    dir,
    settings: new SettingsStore(dir),
    secretsStore: new SecretsStore(dir),
    spend: new SpendLog(path.join(dir, 'spend.jsonl')),
    agentId: 'agent-1',
  };
}

const request: AutoApprovalRequest = {
  toolName: 'github_create_issue',
  args: { title: 'Bug' },
  callHash: 'a'.repeat(64),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('studioAutoApprover', () => {
  it('returns undefined when passes.enabled.auto_approval is false', () => {
    const deps = base();
    deps.settings.setPasses({ enabled: { auto_approval: false } });
    expect(studioAutoApprover(deps)).toBeUndefined();
  });

  it('returns undefined when the auto-approval model has no provider key', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const deps = base();
    deps.settings.setPasses({ autoApprovalModel: 'openai/gpt-4o' });
    expect(studioAutoApprover(deps)).toBeUndefined();
  });

  it('returns an approver for a resolvable provider (mock needs no key)', () => {
    const deps = base();
    deps.settings.setPasses({ autoApprovalModel: 'mock/auto-1' });
    expect(studioAutoApprover(deps)).toBeTypeOf('function');
  });

  it('appends one auto_approval spend record per decision, without blocking the verdict', async () => {
    const deps = base();
    deps.settings.setPasses({ autoApprovalModel: 'mock/auto-1' });
    const approver = studioAutoApprover(deps);
    expect(approver).toBeTypeOf('function');

    // The mock provider's reply is not a usable verdict, so the approver
    // rejects - the spend line is still written (a failed check was billed).
    await expect(approver!(request, new AbortController().signal)).rejects.toThrow();
    await vi.waitFor(async () => {
      expect(await deps.spend.read()).toHaveLength(1);
    });

    const [record] = await deps.spend.read();
    expect(record).toMatchObject({
      kind: 'auto_approval',
      key: request.callHash,
      agentId: 'agent-1',
      model: 'mock/auto-1',
      outcome: 'failed',
    });
    expect(record.ms).toBeTypeOf('number');
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.usage === null || typeof record.usage?.inputTokens === 'number').toBe(true);
    expect(record.costUsd === null || typeof record.costUsd === 'number').toBe(true);
  });
});

describe('autoApprovalLogEntry', () => {
  const decision = (overrides: Partial<AutoApprovalDecision>): AutoApprovalDecision => ({
    toolName: 'github_create_issue',
    callHash: 'b'.repeat(64),
    outcome: 'escalated',
    safety: null,
    reason: 'model reason',
    ms: 12,
    ...overrides,
  });

  it('renders an approved decision with two-decimal safety', () => {
    const entry = autoApprovalLogEntry('agent-1', decision({ outcome: 'approved', safety: 0.91, reason: 'Routine write.' }));
    expect(entry).toMatchObject({ agentId: 'agent-1', level: 'info', phase: 'approval', toolName: 'github_create_issue' });
    expect(entry.message).toBe('Approved automatically (safety 0.91): Routine write.');
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('renders an escalated decision as "Sent to you"', () => {
    const entry = autoApprovalLogEntry('agent-1', decision({ cause: 'below_threshold', safety: 0.2, reason: 'Risky.' }));
    expect(entry.message).toBe('Sent to you: Risky.');
  });

  it('uses Studio wording for timeout and error causes', () => {
    expect(autoApprovalLogEntry('a', decision({ cause: 'timeout' })).message).toBe('Sent to you: The check took longer than 8 s.');
    expect(autoApprovalLogEntry('a', decision({ cause: 'error' })).message).toBe('Sent to you: The check failed.');
  });

  it('uses the R01a truncation reason for truncated args', () => {
    expect(autoApprovalLogEntry('a', decision({ cause: 'truncated' })).message).toBe(
      'Sent to you: Arguments too long to judge safely.'
    );
  });
});
