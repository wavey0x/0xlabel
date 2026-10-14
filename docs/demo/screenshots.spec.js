import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('render the README examples with the shipped extension and sample data', async ({ page }) => {
  await mkdir('docs/images', { recursive: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    await page.goto('/docs/demo/transfers.html');
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.addStyleTag({ url: '/extension/page.css' });
    await page.evaluate(async () => {
      const { createPageController } = await import('/extension/page.js');
      window.controller = await createPageController({
        url: () => new URL('https://etherscan.io/tokentxns'),
        state: { connectionKey: 'http://127.0.0.1:8712', connectionName: 'Local', selectionGeneration: 1, stateRevision: 1, records: window.demoRecords },
        save: () => { throw new Error('Screenshots never save labels.'); },
      });
    });
    await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(12);
    await expect(page.locator('[data-0xlabel-label]')).toHaveCount(11);
    await page.screenshot({ path: `docs/images/transfers-${theme}.png` });
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Edit wallet labels', exact: true }).first().click();
      await page.getByRole('textbox', { name: 'Label 1' }).fill('Treasury vault');
      await expect(page.getByRole('switch', { name: 'Show my tags for this address', exact: true })).toBeEnabled();
      await expect(page.getByRole('dialog')).toBeVisible();
      const from = await page.locator('th').nth(2).boundingBox();
      const to = await page.locator('th').nth(3).boundingBox();
      const fourthRow = await page.locator('tbody tr').nth(3).boundingBox();
      await page.screenshot({ path: 'docs/images/editor.png', clip: { x: from.x, y: from.y, width: to.x + to.width - from.x, height: fourthRow.y + fourthRow.height - from.y } });
    }
  }
  expect(errors).toEqual([]);
});
