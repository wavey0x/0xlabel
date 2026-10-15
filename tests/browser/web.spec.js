import { test, expect, request } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:8723/0xtagger';
const address = '0x' + '12'.repeat(20);
const imported = '0x' + '34'.repeat(20);
const added = '0x' + '56'.repeat(20);
const key = { Authorization: 'Bearer test-only-token' };

test('hosted book: one server, scoped edits, stale writes and file round trip without a browser key', async ({ page }) => {
  const api = await request.newContext({ extraHTTPHeaders: key });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  page.on('request', request => { if (request.url().startsWith(base)) requests.push(request); });
  await page.setExtraHTTPHeaders({ 'Tailscale-User-Login': 'test@example.com' });
  const put = async (scope, at, tags, version = null, source) => {
    const response = await api.put(`${base}/tags/${scope}/${at}`, { data: { tags, version, ...(source ? { source } : {}) } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).record;
  };
  try {
    await put('eip155:1', address, ['Ethereum treasury'], null, 'safe:address-book');
    await put('eip155:8453', address, ['Base treasury']);
    await page.goto(base + '/');
    await expect(page.locator('#results tr')).toHaveCount(2);
    await expect(page.locator('#count')).toHaveText('1 address');
    expect(await page.evaluate(() => Boolean(globalThis.chrome?.runtime))).toBe(false);

    await page.locator('.record', { hasText: 'Ethereum treasury' }).click();
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('Ethereum edited');
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    let records = (await (await api.get(base + '/tags')).json()).records;
    const ethereum = records.find(item => item.scope === 'eip155:1');
    expect(ethereum).toMatchObject({ address, tags: ['Ethereum edited'], source: 'safe:address-book' });
    expect(records.find(item => item.scope === 'eip155:8453').tags).toEqual(['Base treasury']);

    await page.locator('.record', { hasText: 'Ethereum edited' }).click();
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('An older draft');
    await put('eip155:1', address, ['Saved by the extension'], ethereum.version);
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: 'Use these', exact: true })).toBeVisible();
    expect((await (await api.get(base + '/tags')).json()).records.find(item => item.scope === 'eip155:1').tags).toEqual(['Saved by the extension']);
    await page.getByRole('button', { name: 'Use these', exact: true }).click();
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).press('Escape');
    await page.locator('#refresh').click();
    await expect(page.locator('.record', { hasText: 'Saved by the extension' })).toHaveCount(1);

    await page.getByRole('button', { name: '+ Add address', exact: true }).click();
    await page.locator('#manual-address').fill(added);
    await page.locator('#network').fill('10');
    await page.getByRole('button', { name: 'Add tags', exact: true }).click();
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).fill('New Optimism tag');
    await page.getByRole('textbox', { name: 'Tag 1', exact: true }).press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.locator('#import-file').setInputFiles({ name: 'safe.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ records: [{ address: imported, scope: 'eip155:8453', tags: ['Imported'], source: 'safe:address-book' }] })) });
    await expect(page.locator('#review-rows')).toContainText('Imported');
    await page.getByRole('button', { name: 'Import 1 name', exact: true }).click();
    await expect(page.locator('#review')).toBeHidden();
    await page.reload();
    await expect(page.locator('#results tr')).toHaveCount(4);
    records = (await (await api.get(base + '/tags')).json()).records;
    expect(records.find(item => item.address === added)).toMatchObject({ scope: 'eip155:10', tags: ['New Optimism tag'] });
    expect(records.find(item => item.address === imported)).toMatchObject({ scope: 'eip155:8453', source: 'safe:address-book' });

    const downloaded = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloaded;
    expect(JSON.parse(await readFile(await download.path(), 'utf8')).records).toEqual(records);
    expect(requests.every(request => !request.headers().authorization)).toBe(true);
    expect(page.url()).toBe(base + '/');
    expect(errors).toEqual([]);
  } finally { await api.dispose(); }
});

test('hosted book: cross-origin writes fail and a forged remote identity has no access', async ({ page }) => {
  const api = await request.newContext({ extraHTTPHeaders: key });
  try {
    const before = (await (await api.get(base + '/tags')).json()).records;
    await page.setExtraHTTPHeaders({ 'Tailscale-User-Login': 'test@example.com' });
    await page.goto('/tests/fixtures/page.html');
    const result = await page.evaluate(async ({ base, address }) => {
      try {
        await fetch(`${base}/tags/global/${address}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: ['Cross-site'], version: null }) });
        return 'accepted';
      } catch { return 'refused'; }
    }, { base, address: '0x' + '78'.repeat(20) });
    expect(result).toBe('refused');
    expect((await (await api.get(base + '/tags')).json()).records).toEqual(before);
    const denied = await request.newContext({ extraHTTPHeaders: { 'Tailscale-User-Login': 'other@example.com' } });
    try {
      expect((await denied.get(base + '/')).status()).toBe(401);
      expect((await denied.get(base + '/tags')).status()).toBe(401);
    } finally { await denied.dispose(); }
  } finally { await api.dispose(); }
});

test('hosted book: a failed first read never opens a writable empty device book', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Tailscale-User-Login': 'test@example.com' });
  await page.route(base + '/tags', route => route.abort());
  await page.goto(base + '/');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add address', exact: true })).not.toBeVisible();
  await expect(page.locator('#message')).toContainText('could not be reached');
});
