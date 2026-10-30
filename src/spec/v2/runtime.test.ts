import { describe, it, expect } from 'vitest';
import { issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function parse(key: string, value: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, [key]: value });
}

function accept(key: string, values: unknown[]): void {
  for (const value of values) {
    const result = parse(key, value);
    expect(result.success, `${key} ${JSON.stringify(value)}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
  }
}

/** Asserts every value fails; `path`/`message` (when given) are checked on the first issue. */
function reject(key: string, cases: ReadonlyArray<{ value: unknown; path?: string; message?: string | RegExp }>): void {
  for (const { value, path, message } of cases) {
    const result = parse(key, value);
    expect(result.success, `${key} ${JSON.stringify(value)} should fail`).toBe(false);
    if (result.success) continue;
    const first = result.error.issues[0];
    if (path !== undefined) expect(issuePath(first), `${key} ${JSON.stringify(value)} first issue path`).toBe(path);
    if (message !== undefined) {
      const text = first.message;
      if (typeof message === 'string') expect(text).toContain(message);
      else expect(text).toMatch(message);
    }
  }
}

describe('agentSpecV2Schema runtime keys', () => {
  it('modelSettings accepts SDK settings and rejects unknown keys with a did-you-mean', () => {
    accept('modelSettings', [{ temperature: 0.2, maxTokens: 1024, toolChoice: 'auto' }]);
    reject('modelSettings', [
      { value: { maxOutputTokens: 10 }, path: 'modelSettings.maxOutputTokens', message: "did you mean 'maxTokens'" },
      { value: { temperature: 3 }, path: 'modelSettings.temperature' },
    ]);
  });

  it('reasoning accepts an effort or a settings object', () => {
    accept('reasoning', ['high', { effort: 'low', budgetTokens: 2048 }]);
    reject('reasoning', [{ value: 'off', path: 'reasoning' }, { value: { budget: 1 }, path: 'reasoning' }]);
  });

  it('limits accepts the RunLimits shape', () => {
    accept('limits', [{ maxCostUsd: 0.05, onExceeded: 'stop' }]);
    reject('limits', [{ value: { maxCost: 1 } }, { value: { maxSteps: 0 } }]);
  });

  it('maxSteps accepts a positive integer', () => {
    accept('maxSteps', [8]);
    reject('maxSteps', [{ value: 0, path: 'maxSteps' }, { value: 1.5, path: 'maxSteps' }]);
  });

  it('compaction accepts a boolean or the data part of AgentCompactionOptions', () => {
    accept('compaction', [true, { thresholdPercent: 0.8, summarizer: 'openai/gpt-4o-mini' }]);
    reject('compaction', [{ value: { thresholdPercent: 0 } }, { value: { strategy: 'x' } }]);
  });

  it('retry accepts false or the data part of WithRetryOptions', () => {
    accept('retry', [false, { maxRetries: 3, backoff: { initialMs: 500, jitter: false } }]);
    reject('retry', [{ value: true, path: 'retry' }, { value: { backoff: 'exponential' } }]);
  });

  it('rateLimit accepts RateLimitOptions', () => {
    accept('rateLimit', [{ requestsPerMinute: 60 }]);
    reject('rateLimit', [{ value: { rpm: 60 } }]);
  });

  it("promptCaching accepts 'auto' or false", () => {
    accept('promptCaching', ['auto', false]);
    reject('promptCaching', [{ value: true, path: 'promptCaching', message: "must be 'auto' or false" }]);
  });

  it('toolSearch accepts false or the data part of ToolSearchOptions', () => {
    accept('toolSearch', [false, { maxResults: 5 }]);
    reject('toolSearch', [{ value: { enabled: true } }]);
  });

  it('codeMode accepts a boolean or CodeModeOptions', () => {
    accept('codeMode', [true, { exclusive: true }]);
    reject('codeMode', [{ value: { enabled: true } }]);
  });

  it('permissionMode accepts each PermissionMode and rejects others', () => {
    accept('permissionMode', ['default', 'plan', 'acceptEdits', 'dontAsk']);
    reject('permissionMode', [{ value: 'bypass', path: 'permissionMode' }]);
  });

  it('approvalTtlMs accepts a positive bounded number of milliseconds', () => {
    accept('approvalTtlMs', [60000]);
    reject('approvalTtlMs', [{ value: 0, path: 'approvalTtlMs' }, { value: -1, path: 'approvalTtlMs' }, { value: 4e12, path: 'approvalTtlMs' }]);
  });

  it('askQuestion accepts a boolean', () => {
    accept('askQuestion', [true]);
    reject('askQuestion', [{ value: 'yes', path: 'askQuestion' }]);
  });

  it('subagentOptions accepts the data part of SubagentOptions', () => {
    accept('subagentOptions', [{ maxConcurrent: 2, background: false }]);
    reject('subagentOptions', [{ value: { parallel: true } }]);
  });

  it('maxSubagentDepth and maxHandoffs accept non-negative integers', () => {
    accept('maxSubagentDepth', [0, 3]);
    accept('maxHandoffs', [0, 3]);
    reject('maxSubagentDepth', [{ value: -1, path: 'maxSubagentDepth' }]);
    reject('maxHandoffs', [{ value: -1, path: 'maxHandoffs' }]);
  });
});
