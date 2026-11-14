import { test, expect, type Page } from '@playwright/test';

/**
 * S3: full-stack smoke test against the real, BUILT `lousho studio`
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
 * (`ApprovalCard`/`ChatPanel.tsx`, the same component and endpoint
 * the Approve button uses) -> the run resumes and completes.
 *
 * Agents live in the server workspace (`HttpAgentStore` over `PUT /agents`),
 * and Chat sends the canvas's current spec with each message
 * - so this test chats on the freshly created agent straight
 * away, with no Run first.
 */
const API = { headers: { 'x-lousho-studio-token': 'e2e-studio-token' } };

/**
 * A builder URL that survives the unknown-id fallback to `#/agents`: the first
 * saved agent's canvas tab, or the unsaved default's when none are saved yet.
 */
async function builderHash(page: Page): Promise<string> {
  const res = await page.request.get('/agents', API);
  const ids = ((await res.json()) as { id: string }[]).map((a) => a.id);
  return `#/w/${await launchWorkspaceId(page)}/agents/${ids[0] ?? 'untitled-agent'}/canvas`;
}

/** The launch workspace id for '#/w/<ws>/…' hash assertions (W04b). */
async function launchWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get('/workspace', API);
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

test('create an agent, hit an approval gate via chat, approve it, and complete the run', async ({ page }) => {
  const agentId = `e2e-approval-agent-${Date.now()}`;

  // The studio URL carries the per-launch token (see playwright.config.ts);
  // the builder lives at `#/agents/:id/canvas`.
  await page.goto(`/?token=e2e-studio-token${await builderHash(page)}`);
  await expect(page.locator('.app')).toBeVisible();

  // --- Create an agent from the "Support bot" template (trigger -> llm ->
  // tool -> output; its tool node starts pointed at 'http') ---
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(agentId);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // --- Retarget the tool node at the local, always-needsApproval
  // 'demo-approval' tool, and save ---
  const toolNode = page.locator('[data-node-kind="tool"]');
  await expect(toolNode).toBeVisible();
  await toolNode.click();

  const toolNameInput = page.locator('#node-tool-name');
  await expect(toolNameInput).toBeVisible();
  await toolNameInput.fill('demo-approval');
  await expect(toolNameInput).toHaveValue('demo-approval');

  // The new agent is a file in the server workspace, not a
  // browser-only entry.
  await expect
    .poll(async () => {
      const res = await page.request.get('/agents', { headers: { 'x-lousho-studio-token': 'e2e-studio-token' } });
      return ((await res.json()) as { id: string }[]).map((a) => a.id);
    })
    .toContain(agentId);

  // --- Chat (no Run first - chat on a new agent works, and
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

/** `inner` is drawn whole inside `outer` (not clipped by its overflow). */
async function expectInside(inner: ReturnType<Page['locator']>, outer: ReturnType<Page['locator']>) {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  expect(a && b).toBeTruthy();
  expect(a!.width).toBeGreaterThan(0);
  expect(a!.x).toBeGreaterThanOrEqual(b!.x - 0.5);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5);
}

/**
 * R2: with a tool approval pending, the wide builder toolbar still links to the
 * run's trace (icon-only once the bar is short) and keeps the MOCK badge next to
 * the inline approval, at 1280 and at 1024 wide.
 */
test('a pending approval keeps "Open trace" and the MOCK badge in the toolbar at 1280 and 1024 wide', async ({ page }) => {
  const agentId = `e2e-pending-trace-${Date.now()}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/?token=e2e-studio-token${await builderHash(page)}`);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(agentId);
  await page.locator('#new-agent-template').selectOption('support-bot');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('[data-node-kind="tool"]').click();
  await page.locator('#node-tool-name').fill('demo-approval');
  await page.locator('.chat-input').fill('Please call demo-approval to look something up for me.');
  await page.locator('.btn-send').click();

  const toolbar = page.locator('.topbar-builder');
  await expect(toolbar.locator('.approval-card-inline')).toBeVisible({ timeout: 15_000 });
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const trace = toolbar.getByRole('link', { name: 'Open trace', exact: true });
    await expect(trace).toBeVisible();
    await expect(trace).toHaveAttribute('href', /^#\/traces\/[^/]+$/);
    await expectInside(trace, toolbar.locator('.topbar-left'));
    const mock = toolbar.locator('.topbar-center .mock-badge');
    await expect(mock).toHaveText('MOCK');
    await expectInside(mock, toolbar.locator('.topbar-center'));
  }
});

/** F5: the builder lives at `#/agents/:id/canvas`; the hash names the open agent. */
async function createAgent(page: Page, id: string) {
  // Landing on `#/agents` (the list) first? Open the builder through it:
  // an agent's link, or the empty state's builder link when there are none.
  if ((await page.getByRole('button', { name: 'New agent', exact: true }).count()) === 0) {
    const agentLink = page.locator('.agent-list-placeholder a').first();
    if ((await agentLink.count()) > 0) await agentLink.click();
    else await page.getByRole('link', { name: 'Open the builder' }).click();
  }
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await page.locator('#new-agent-name').fill(id);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.crumbs b')).toHaveText(id);
}

test('selecting an agent updates the URL, a reload restores it, an unknown id falls back to #/agents', async ({ page }) => {
  const first = `e2e-url-a-${Date.now()}`;
  const second = `e2e-url-b-${Date.now()}`;
  await page.goto('/?token=e2e-studio-token');
  await expect(page.locator('.app')).toBeVisible();

  await createAgent(page, first);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));
  await createAgent(page, second);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));

  await page.locator('.agent-card-main', { hasText: first }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(first);

  // The token moved to sessionStorage on the first load, so the reload has none in the URL.
  await page.reload();
  await expect(page.locator('.crumbs b')).toHaveText(first);
  await expect(page.locator('.agent-card.selected')).toContainText(first);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${first}/canvas$`));

  // The legacy `#/agents/:id` URL still opens the builder, redirected to its canvas tab.
  await page.goto(`/?token=e2e-studio-token#/agents/${second}`);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);

  // Unknown id: no error screen; falls back to the agents list at #/agents.
  await page.goto('/#/agents/no-such-agent');
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(page.locator('.agent-list-screen')).toBeVisible();

  // From the list an agent link opens its builder; Agents -> Traces -> Agents lands back on the list.
  await page.locator(`.agent-list-placeholder a[href$="/agents/${second}/overview"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Traces' }).click();
  await expect(page).toHaveURL(/#\/traces$/);
  await nav.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page).toHaveURL(/#\/agents$/);
});

test('unsaved changes ask before switching agents or leaving Agents; cancelling keeps the URL', async ({ page }) => {
  const first = `e2e-dirty-a-${Date.now()}`;
  const second = `e2e-dirty-b-${Date.now()}`;
  await page.goto('/?token=e2e-studio-token');
  await createAgent(page, first);
  await createAgent(page, second);

  // Fail autosave for the open agent so its edit stays unsaved.
  await page.route(`**/agents/${second}`, (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: 'no' }) : route.continue(),
  );
  await page.getByRole('tab', { name: 'Nodes' }).click();
  await page.getByRole('button', { name: 'LLM step' }).click();
  await expect(page.locator('.dirty-dot').first()).toBeVisible();

  const dialogs: string[] = [];
  page.once('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Traces' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain(second);
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.canvas-wrap')).toBeVisible();

  await page.getByRole('tab', { name: 'Agents' }).click();
  page.once('dialog', (d) => void d.dismiss());
  await page.locator('.agent-card-main', { hasText: first }).click();
  await expect(page).toHaveURL(new RegExp(`#/w/[^/]+/agents/${second}/canvas$`));
  await expect(page.locator('.crumbs b')).toHaveText(second);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Traces' }).click();
  await expect(page).toHaveURL(/#\/traces$/);
  await expect(page.locator('.canvas-wrap')).toHaveCount(0);
});
