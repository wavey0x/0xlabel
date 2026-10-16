import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { address, record, start } from '../../tests/browser/controller.js';

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
  // Settled, or the shot catches the dialog on its way in: the toggle half
  // thrown and Save still fading up. Two runs disagreed before this.
  await page.screenshot({ path: 'docs/images/editor.png', animations: 'disabled',
    clip: { x: from.x, y: from.y, width: to.x + to.width - from.x, height: fourthRow.y + fourthRow.height - from.y } });
  expect(errors).toEqual([]);
});

test('capture the address heading, creator row, and narrow To cell for visual review', async ({ page }) => {
  await mkdir('docs/images', { recursive: true });
  const icon = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill="#087ac8" d="M7 0 14 7 7 14 0 7Z"/></svg>');
  const style = `<style>body{margin:0;background:#f6f7fa;color:#20232b;font:14px/1.5 system-ui,sans-serif}
    main{padding:28px}.frame{width:540px;padding:22px;background:#fff;border:1px solid #e9ecf2;border-radius:8px}
    a{color:#367a9e;text-decoration:none}</style>`;
  const frames = [
    // Modelled on etherscan.io/address/0x425d16B0e08a28A3Ff9e4404AE99D78C0a076C5A
    // (2026-10-16).
    { name: 'address-heading', tag: 'Convex Governance Multisig', html: `<div class="frame">
      <div style="color:#858b96;font-size:12px">Contract</div><h1 style="font-size:28px;line-height:1.5;margin:4px 0">
      <span id="mainaddress" data-highlight-target="${address}">${address}</span></h1></div>` },
    // Modelled on etherscan.io/address/0xa3C5A1e09150B75ff251c1a7815A07182c3de2FB,
    // where the contract creator link holds an ENS icon (2026-10-16).
    { name: 'creator-row', tag: 'C2tP', html: `<div class="frame" style="display:flex;align-items:center;gap:4px">
      <span style="color:#858b96;margin-right:12px">Creator</span><a id="creator" class="hash-tag"
      href="/address/${address}"><img src="${icon}" width="14" height="14"
      style="margin-right:4px">c2tp.eth</a><span>|</span><a href="#">5 hrs 173 min</a></div>` },
    // Modelled on the inner-span To cell at
    // etherscan.io/address/0x425d16B0e08a28A3Ff9e4404AE99D78C0a076C5A
    // (2026-10-16); a plain link does not reproduce the trimming behavior.
    { name: 'narrow-to-cell', tag: 'Convex Governance Multisig', html: `<div class="frame">
      <span style="display:inline-block;width:70px;color:#858b96">To</span><a id="cell" class="hash-tag"
      href="/address/${address}" style="display:inline-block;max-width:160px;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;vertical-align:middle"><img src="${icon}"
      width="14" height="14" style="margin-right:4px"><span id="name" class="hash-tag"
      >Curve: CRV Token</span></a></div>` },
  ];
  for (const frame of frames) {
    await start(page, { records: [{ ...record, tags: [frame.tag] }], html: `${style}<header>Explorer</header><main>${frame.html}</main>` });
    await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.frame').screenshot({ path: `docs/images/${frame.name}.png`, animations: 'disabled' });
  }
});
