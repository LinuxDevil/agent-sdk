import { test, expect } from '@playwright/test';

/**
 * S3 (LOU-S): full-stack smoke test against the real, BUILT `loushy studio`
 * (see playwright.config.ts's `webServer` - it runs the same
 * `dist-server/index.cjs` production entry `loushy studio --prod` spawns,
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
 * `ToolDescriptor` by hand instead) -> click Run once with the default
 * "Run the agent." input (which doesn't mention the tool, so it just
 * completes normally - see below for why this step exists) -> send a chat
 * message that mentions the tool (the mock provider's tool-call heuristic:
 * it calls any registered tool whose name appears in the last user message
 * - see `src/providers/mock.ts`) -> the run pauses awaiting approval ->
 * approve via the Chat tab's inline approval card
 * (`ApprovalCard`/`ChatPanel.tsx`, the same component and endpoint the
 * epic brief calls for) -> the run resumes and completes.
 *
 * The graph editor's own "Save" button (`Topbar.tsx`) only persists to the
 * BROWSER's `LocalStorageAgentStore` (`src/state/AppState.tsx`'s `store`) -
 * it never PUTs to the server. `POST /agents/:id/run` (the "Run" button)
 * DOES send its current in-memory spec along in the request body, and
 * `RunManager.launch()` persists that spec server-side as a side effect
 * (`server/runRegistry.ts`) before executing it - which is what
 * `POST /agents/:id/message` (Chat) needs, since IT sends no spec at all
 * and falls back to loading whatever was last saved server-side
 * (`runtimeClient.ts`'s `sendMessage()`). So this test clicks Run once,
 * purely to get the edited spec persisted server-side, before switching to
 * Chat to actually trigger the approval gate.
 */
test('create an agent, hit an approval gate via chat, approve it, and complete the run', async ({ page }) => {
  const agentId = `e2e-approval-agent-${Date.now()}`;

  await page.goto('/');
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

  // Run once (see the file-level doc comment above for why) to persist
  // this edited spec server-side, and wait for it to actually finish.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled({ timeout: 15_000 });

  // --- Chat: send a message mentioning the tool, hitting the approval gate ---
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
