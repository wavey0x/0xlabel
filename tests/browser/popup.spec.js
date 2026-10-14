import { test, expect } from '@playwright/test';

async function popup(page, count = 0) {
  // Only browser APIs are stubbed; exercise the shipped popup, editor and CSS.
  await page.addInitScript(count => {
    const records = Array.from({ length: count }, (_, index) => ({
      address: '0x' + (index + 1).toString(16).padStart(40, '0'),
      scope: 'global', labels: [`Macbook ${index}`, 'Desk'], version: 'one',
    }));
    window.fixtureState = { records, connections: [{ name: 'Local', url: 'http://127.0.0.1:8712' }], connectionKey: 'http://127.0.0.1:8712', connectionName: 'Local', selectionGeneration: 1, stateRevision: 1, syncedAt: 1 };
    window.fixtureMessages = [];
    window.chrome = {
      tabs: { query: async () => [{ id: 1, url: 'https://etherscan.io/accounts' }] },
      runtime: {
        onMessage: { addListener: listener => { window.fixtureUpdate = listener; } },
        sendMessage: async message => {
          window.fixtureMessages.push(message.type);
          return { ok: true, result: { state: window.fixtureState, sites: { 'https://etherscan.io': true } } };
        },
      },
    };
  }, count);
  await page.goto('/extension/popup.html');
  await expect(page.locator('#sync')).toContainText('Last synced');
}

test('clicking the popup backdrop dismisses the editor without saving and allows a fresh editor', async ({ page }) => {
  await popup(page, 1);
  await page.locator('.record').click();
  const dialog = page.getByRole('dialog');
  await expect(page.getByRole('button', { name: 'Close editor' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show (my label|website original)$/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Unsaved popup draft');
  await dialog.locator('code').click();
  await expect(dialog).toBeVisible();
  await page.locator('#editor-host').click({ position: { x: 370, y: 300 } });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#editor-host')).toBeHidden();
  expect(await page.evaluate(() => window.fixtureMessages)).not.toContain('Save');
  await page.locator('.record').click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Macbook 0');
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await expect(dialog).toHaveCount(0);
});

for (const count of [0, 1000]) {
  test(`search ${count} records: typing reuses unchanged rows and causes no result mutations or RPCs`, async ({ page }) => {
    await popup(page, count);
    await page.evaluate(() => {
      window.originalRows = [...document.querySelector('#results').children];
      window.searchMutations = 0;
      const observer = new MutationObserver(changes => window.searchMutations += changes.length);
      for (const id of ['results', 'empty']) observer.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true });
      window.messagesBeforeTyping = window.fixtureMessages.length;
    });
    await page.locator('#search').pressSequentially('Macbook', { delay: 1 });
    expect(await page.evaluate(() => window.searchMutations)).toBe(0);
    expect(await page.evaluate(() => window.fixtureMessages.length)).toBe(await page.evaluate(() => window.messagesBeforeTyping));
    expect(await page.evaluate(() => [...document.querySelector('#results').children].every((row, index) => row === window.originalRows[index]))).toBe(true);
    await expect(page.locator('#results .record')).toHaveCount(Math.min(count, 100));
    if (count) {
      await page.locator('#search').fill('Macbook 999');
      await expect(page.locator('.record')).toHaveCount(1);
      await expect(page.locator('.record')).toContainText('Macbook 999');
      await page.evaluate(() => {
        const { stateRevision, ...incomplete } = window.fixtureState;
        window.fixtureUpdate({ type: 'Updated', state: { ...incomplete, records: [] } });
      });
      await expect(page.locator('.record')).toHaveCount(1);
      await page.evaluate(() => window.fixtureUpdate({ type: 'Updated', state: { ...window.fixtureState, connectionKey: 'https://remote.example', selectionGeneration: 2, stateRevision: 2, records: [] } }));
      await expect(page.locator('.record')).toHaveCount(0);
    }
  });
}
