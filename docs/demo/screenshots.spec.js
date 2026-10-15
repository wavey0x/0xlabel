import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// The one still image the README shows. The moving demo beside it is recorded
// by hand; everything here is drawn by the shipped controller over sample data,
// so the picture cannot drift from what the extension actually does.
test('render the README example with the shipped extension and sample data', async ({ page }) => {
  await mkdir('docs/images', { recursive: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/docs/demo/transfers.html');
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.addStyleTag({ url: '/extension/colors.css' });
  await page.addStyleTag({ url: '/extension/page.css' });
  await page.evaluate(async () => {
    const { createPageController } = await import('/extension/page.js');
    window.controller = await createPageController({
      url: () => new URL('https://etherscan.io/tokentxns'),
      state: { books: [{ id: 'book-1', name: 'Local', where: 'http://127.0.0.1:8712' }],
        activeBook: 'book-1', bookName: 'Local', bookKind: 'server', stateRevision: 1, records: window.demoRecords },
      save: () => { throw new Error('Screenshots never save tags.'); },
    });
  });
  await expect(page.locator('[data-0xtagger-edit]')).toHaveCount(12);
  await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(11);
  await page.getByRole('button', { name: 'Edit wallet tags', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Tag 1' }).fill('Treasury vault');
  await expect(page.getByRole('switch', { name: 'Show my tags for this address', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toBeVisible();
  const from = await page.locator('th').nth(2).boundingBox();
  const to = await page.locator('th').nth(3).boundingBox();
  const fourthRow = await page.locator('tbody tr').nth(3).boundingBox();
  await page.screenshot({ path: 'docs/images/editor.png',
    clip: { x: from.x, y: from.y, width: to.x + to.width - from.x, height: fourthRow.y + fourthRow.height - from.y } });
  expect(errors).toEqual([]);
});
