import { describe, it, expect, vi } from 'vitest';
import { handleFixerPatch } from './guardedPr';
import { ToolDescriptor } from '../../src/types';

describe('handleFixerPatch (LOU-J7)', () => {
  const CLEAN_PATCH = '--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const SECRET_PATCH = `--- a/config.txt\n+++ b/config.txt\n@@ -1 +1 @@\n-old\n+AKIA${'A'.repeat(16)}\n`;

  function makeSpiedTool(name: string): ToolDescriptor & { execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn().mockResolvedValue({ ok: true, tool: name });
    return {
      displayName: name,
      tool: { description: name, parameters: {}, execute } as any,
      execute,
    } as any;
  }

  it('a clean patch results in exactly one GitHub PR-creation call with the patch content, and never calls Slack', async () => {
    const githubCreatePrTool = makeSpiedTool('github_create_pull_request');
    const slackTool = makeSpiedTool('slack');

    const result = await handleFixerPatch(CLEAN_PATCH, {
      githubCreatePrTool,
      slackTool,
      channel: '#incidents',
      approvalId: 'approval-1',
      head: 'fix/auto',
    });

    expect(result.pass).toBe(true);
    expect(githubCreatePrTool.execute).toHaveBeenCalledTimes(1);
    expect(slackTool.execute).not.toHaveBeenCalled();

    const prArgs = githubCreatePrTool.execute.mock.calls[0][0];
    expect(prArgs.body).toContain('+new');
  });

  it('a patch containing a fake API-key-shaped string never reaches the GitHub tool, and Slack is notified instead', async () => {
    const githubCreatePrTool = makeSpiedTool('github_create_pull_request');
    const slackTool = makeSpiedTool('slack');

    const result = await handleFixerPatch(SECRET_PATCH, {
      githubCreatePrTool,
      slackTool,
      channel: '#incidents',
      approvalId: 'approval-2',
      head: 'fix/auto',
    });

    expect(result.pass).toBe(false);
    expect(githubCreatePrTool.execute).not.toHaveBeenCalled();
    expect(slackTool.execute).toHaveBeenCalledTimes(1);

    const slackArgs = slackTool.execute.mock.calls[0][0];
    expect(slackArgs.approvalId).toBe('approval-2');
    expect(slackArgs.message).toContain('secret-scan');
  });

  it('a patch exceeding the diff-size cap never reaches the GitHub tool either', async () => {
    const githubCreatePrTool = makeSpiedTool('github_create_pull_request');
    const slackTool = makeSpiedTool('slack');

    const bigPatch = Array.from({ length: 600 }, (_, i) => `+line ${i}`).join('\n');

    const result = await handleFixerPatch(bigPatch, {
      githubCreatePrTool,
      slackTool,
      channel: '#incidents',
      approvalId: 'approval-4',
      head: 'fix/auto',
    });

    expect(result.pass).toBe(false);
    expect(githubCreatePrTool.execute).not.toHaveBeenCalled();
    expect(slackTool.execute).toHaveBeenCalledTimes(1);
  });

  it('the guardrail check completes before the GitHub call is even considered (sequential, not parallel)', async () => {
    const order: string[] = [];
    const githubCreatePrTool: any = {
      displayName: 'github',
      tool: {
        description: 'github',
        parameters: {},
        execute: vi.fn(async () => {
          order.push('github');
          return { ok: true };
        }),
      },
    };
    const slackTool: any = {
      displayName: 'slack',
      tool: { description: 'slack', parameters: {}, execute: vi.fn() },
    };

    const { createDiffSizeGuardrail, secretScanGuardrail } = await import('../../src/execution/guardrails');
    const trackedGuardrails = [
      secretScanGuardrail,
      {
        name: 'diff-size-cap',
        check: async (action: { diff: string }) => {
          order.push('guardrail');
          return createDiffSizeGuardrail(500).check(action);
        },
      },
    ];

    await handleFixerPatch(CLEAN_PATCH, {
      githubCreatePrTool,
      slackTool,
      channel: '#incidents',
      approvalId: 'approval-3',
      head: 'fix/auto',
      guardrails: trackedGuardrails as any,
    });

    expect(order).toEqual(['guardrail', 'github']);
  });
});
