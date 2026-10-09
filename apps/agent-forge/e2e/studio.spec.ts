import { test, expect } from '@playwright/test';

/**
 * S3 (LOU-S): full-stack smoke test against the real, BUILT `lousho studio`
 * (see playwright.config.ts's `webServer` - it runs the same
 * `dist-server/index.cjs` production entry `lousho studio --prod` spawns,
 * serving the pre-built client too). This is the guard against regressions
 * across the whole stack: the canvas/graph editor, the Save/PUT-agent
 * round trip, the mock provider's tool-call heuristic, the real
 * human-in-the-loop approval-gate pause/resume machinery
 * (`AgentExecutor`/`RunManager`/`FileApprovalStore`), and the WebSocket
 * chat stream all have to actually work together for this to pass - not
 * just "the page loads".
 *
 * Flow: create an agent from the "Support bot" template (trigger -> llm ->
 * tool -> output) -> retarget its tool node at `demo-approval` (a
 * server-local, always-`needsApproval` tool added in `server/buildAgent.ts`
 * specifically so this flow is reachable through the real UI - see that
 * file's doc comment; none of the core SDK's spec-resolvable built-in
 * tools set `needsApproval`, the same reason
 * `server/__tests__/approvalFlow.test.ts` has to construct a
 * `ToolDescriptor` by hand instead) -> check the agent is saved in the
 * server workspace -> send a chat
 * message that mentions the tool (the mock provider's tool-call heuristic:
 * it calls any registered tool whose name appears in the last user message
 * - see `src/providers/mock.ts`) -> the run pauses awaiting approval ->
 * approve via the Chat tab's inline approval card
 * (`ApprovalCard`/`ChatPanel.tsx`, the same component and endpoint the
 * epic brief calls for) -> the run resumes and completes.
 *
 * Agents live in the server workspace (`HttpAgentStore` over `PUT /agents`,
 * Eve DUI-F2), and Chat sends the canvas's current spec with each message
 * (Eve DUI-F7) - so this test chats on the freshly created agent straight
 * away, with no Run first.
 */
test('create an agent, hit an approval gate via chat, approve it, and complete the run', async ({ page }) => {
  const agentId = `e2e-approval-agent-${Date.now()}`;

  // Eve DUI-F1: the studio URL carries the per-launch token (see playwright.config.ts).
  await page.goto('/?token=e2e-studio-token');
  await expect(page.locator('.app')).toBeVisible();

  // --- Create an agent from the "Support bot" template (trigger -> llm ->
  // tool -> output; its tool node starts pointed at 'http') ---
  await page.getByRole('button', { name: '+ New agent' }).click();
  await page.locator('#new-agent-name').fill(agentId);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // --- Retarget the tool node at the local, always-needsApproval
  // 'demo-approval' tool, and save ---
  const toolNode = page.locator('[data-node-type="tool"]');
  await expect(toolNode).toBeVisible();
  await toolNode.click();

  const toolNameInput = page.locator('#node-tool-name');
  await expect(toolNameInput).toBeVisible();
  await toolNameInput.fill('demo-approval');
  await expect(toolNameInput).toHaveValue('demo-approval');

  // Eve DUI-F2: the new agent is a file in the server workspace, not a
  // browser-only entry.
  await expect
    .poll(async () => {
      const res = await page.request.get('/agents', { headers: { 'x-lousho-studio-token': 'e2e-studio-token' } });
      return ((await res.json()) as { id: string }[]).map((a) => a.id);
    })
    .toContain(agentId);

  // --- Chat (no Run first - Eve DUI-F7: chat on a new agent works, and
  // sends the canvas's current spec): send a message mentioning the tool,
  // hitting the approval gate --- send a message mentioning the tool, hitting the approval gate ---
  const chatInput = page.locator('.chat-input');
  await expect(chatInput).toBeVisible();
  await chatInput.fill('Please call demo-approval to look something up for me.');
  await page.locator('.btn-send').click();

  const approvalCard = page.locator('.chat-approval-card');
  await expect(approvalCard).toBeVisible({ timeout: 15_000 });
  await expect(approvalCard).toContainText('demo-approval');

  // --- Approve via the chat's inline approval card ---
  await approvalCard.getByRole('button', { name: 'Approve', exact: true }).click();

  // --- The run resumes and completes: the approval card is gone, the input
  // is re-enabled, and the final assistant turn is in the transcript. ---
  await expect(approvalCard).toHaveCount(0, { timeout: 15_000 });
  await expect(chatInput).toBeEnabled();
  await expect(page.locator('.chat-msg.agent').last()).toBeVisible();
});
