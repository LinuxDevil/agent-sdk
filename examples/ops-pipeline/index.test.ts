import { createHmac } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { startOpsPipeline, OpsPipelineHandle } from './index';
import { createDemoProvider } from './demoProvider';
import { createMockGithubTool } from './mocks/mockGithubTool';
import { createMockSlackTool } from './mocks/mockSlackTool';
import { createInMemoryApprovalStore } from './slackInteractions';
import { exampleErrorSignal, sendSyntheticError } from './mocks/mockGrafanaSender';

describe('ops-pipeline end-to-end (LOU-J8, against mocks - zero external network)', () => {
  let handle: OpsPipelineHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('runs the full pipeline: dedup -> approval gate -> Slack "Fix it" -> patch-check-gated GitHub PR', async () => {
    const provider = createDemoProvider();
    const github = createMockGithubTool();
    const slack = createMockSlackTool();
    const approvalStore = createInMemoryApprovalStore();

    handle = await startOpsPipeline({
      provider,
      githubCreatePrTool: github.tool,
      slackTool: slack.tool,
      approvalStore,
      monitorPort: 0,
      slackPort: 0,
    });

    const signal = exampleErrorSignal();
    const webhookUrl = `http://127.0.0.1:${handle.monitor.port}/webhook`;

    // New signature is accepted; a duplicate is deduped.
    const res1 = await sendSyntheticError(webhookUrl, signal);
    expect((await res1.json()).deduped).toBe(false);
    const res2 = await sendSyntheticError(webhookUrl, signal);
    expect((await res2.json()).deduped).toBe(true);

    // Let the async onResult -> Slack post settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The fixer must NOT have run / no PR yet - blocked behind the approval gate.
    expect(slack.posts).toHaveLength(1);
    expect(github.createdPullRequests).toHaveLength(0);

    const approvalId = slack.posts[0].approvalId;
    expect(approvalId).toBeTruthy();

    // Simulate the Slack "Fix it" button click.
    const interactionsUrl = `http://127.0.0.1:${handle.slack.port}/slack/interactions`;
    const interactionRes = await fetch(interactionsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        actions: [{ action_id: 'fix_it', value: approvalId }],
      }),
    });
    expect((await interactionRes.json()).handled).toBe(true);

    // The approval unblocked the fixer, which produced a patch that passed
    // patch checks and resulted in exactly one GitHub PR.
    expect(github.createdPullRequests).toHaveLength(1);
    expect(github.createdPullRequests[0].body).toContain('OrderService.java');
  });
});

describe('ops-pipeline Slack signature verification (LOU-D18)', () => {
  let handle: OpsPipelineHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('rejects unsigned interaction callbacks and accepts correctly signed ones when a signing secret is set', async () => {
    const secret = 'ops-signing-secret';
    handle = await startOpsPipeline({ slackSigningSecret: secret, monitorPort: 0, slackPort: 0 });
    const url = `http://127.0.0.1:${handle.slack.port}/slack/interactions`;
    const body = JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'other', value: 'x' }] });

    const unsigned = await fetch(url, { method: 'POST', body });
    expect(unsigned.status).toBe(401);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    const signed = await fetch(url, {
      method: 'POST',
      headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
      body,
    });
    expect(signed.status).toBe(200);
  });
});
