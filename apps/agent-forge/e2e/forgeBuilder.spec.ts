import { test, expect } from '@playwright/test';

/**
 * X08: the cross-phase happy path with no API keys. The Author's model is
 * the scripted `mockModel` that `LOUSHO_FORGE_AUTHOR_SCRIPT` installs
 * (server/author/authorScript.ts; the fixture proposes a "Greeter" agent),
 * so this spec drives the real built Studio end to end: propose -> apply
 * -> edit on the canvas -> save a version -> test run on the mock
 * provider -> publish -> version history.
 *
 * The scripted draft names a catalog model (`openai/gpt-4o-mini`) because
 * `proposeAgent` rejects ids the model catalog does not know; the canvas
 * step then switches the agent to `mock/mock-1` so the Test chat needs no
 * key. Assertions use roles and labels, not CSS classes, wherever the UI
 * exposes them.
 */
const TOKEN = 'e2e-studio-token';

test('create with the Author, edit on canvas, test and publish an agent', async ({ page }) => {
  // 1. The agents list.
  await page.goto(`/?token=${TOKEN}#/agents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();

  // 2. The Agent Author dock (Ctrl/Cmd+J).
  await page.keyboard.press('Control+j');
  const author = page.getByRole('region', { name: 'Agent Author' });
  await expect(author).toBeVisible();

  // 3. Ask for an agent; the scripted model proposes "Greeter".
  const composer = author.getByRole('textbox', { name: 'Message the Agent Author' });
  await composer.fill('Make an agent that greets people');
  await composer.press('Enter');

  // 4. The proposal card names Greeter; Apply saves it (the composer
  //    re-enables once the turn finishes, so the card is settled).
  const card = author.locator('article').filter({ hasText: 'Greeter' });
  await expect(card).toBeVisible();
  await expect(composer).toBeEnabled();
  await card.getByRole('button', { name: /Save agent|Apply changes/ }).click();

  // 5. The success card deep-links into the new agent's canvas.
  const success = page.getByRole('status').filter({ hasText: 'Greeter' });
  await expect(success.getByRole('button', { name: 'Open in canvas' })).toBeVisible();
  await success.getByRole('button', { name: 'Open in canvas' }).click();
  await expect(page).toHaveURL(/#\/agents\/[^/]+\/canvas/);

  // 6. Canvas edit: select the agent node, point its model at the keyless
  //    mock provider (the draft's catalog id has no stored key), and
  //    rewrite its instructions.
  await page.locator('[data-node-kind="agent"]').first().click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();

  const model = inspector.locator('#node-agent-model');
  await model.selectOption('__other__');
  await inspector.locator('#node-agent-model').fill('mock/mock-1');

  const instructions = inspector.getByRole('textbox', { name: 'Instructions', exact: true });
  await instructions.fill('Greet the user by name and wish them a good day.');

  // 7. Save writes a version; the toast names it.
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast-message').filter({ hasText: /Saved version v\d+/ })).toBeVisible();

  // 8. Test drawer: chat with the agent; the mock provider answers.
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const chatInput = page.locator('.chat-input');
  await expect(chatInput).toBeVisible();
  await chatInput.fill('Hi, I am Sam');
  await page.locator('.btn-send').click();
  await expect(page.locator('.chat-msg.agent').last()).toContainText('This is a mock response.', {
    timeout: 15_000,
  });

  // 9. Publish pins the version; the toast and the pill name it.
  const pill = page.getByRole('button', { name: /Publish state:/ });
  // ArrowDown opens the menu with the first item focused; Enter selects it.
  // (A pointer click races the menu's outside-pointerdown/scroll close.)
  await pill.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast-message').filter({ hasText: /Published v\d+/ })).toBeVisible();
  await expect(pill).toContainText(/Published v\d+/);

  // 10. Versions: at least two entries, the pin carries the Published badge.
  const agentId = /#\/agents\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  expect(agentId).not.toBe('');
  await page.goto(`/?token=${TOKEN}#/agents/${agentId}/versions`);
  const items = page.locator('li.version-item');
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
});
