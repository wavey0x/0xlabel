import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('installed toolbar: green only while ready, paused warning, navigation, worker restart and disabling', async () => {
  test.setTimeout(60000);
  const profile = await mkdtemp(path.join(tmpdir(), '0xlabel-toolbar-test-'));
  const extension = path.join(profile, 'extension');
  await cp(path.resolve('extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // The explorer is completely intercepted by a local fixture, never contacted.
  manifest.host_permissions = ['https://etherscan.io/*'];
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const errors = [];
  context.on('weberror', error => errors.push(error.error().message));
  try {
    const html = await readFile('tests/fixtures/page.html', 'utf8');
    await context.route('https://etherscan.io/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const website = context.pages()[0]; await website.goto('https://etherscan.io/accounts');
    const popup = await context.newPage(); await website.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const tabId = (await popup.evaluate(() => chrome.tabs.query({ url: 'https://etherscan.io/*' })))[0].id;
    await worker.evaluate(() => {
      self.fixtureIcons = [];
      const setIcon = chrome.action.setIcon.bind(chrome.action);
      chrome.action.setIcon = details => { self.fixtureIcons.push(details); return setIcon(details); };
    });
    const title = () => popup.evaluate(tabId => chrome.action.getTitle({ tabId }), tabId);
    const badge = () => popup.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId);
    await expect.poll(title).toBe('0xlabel');
    await popup.locator('#site-toggle').click();
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(500);
    await expect.poll(title).toBe('0xlabel · Active on this page');
    expect(await worker.evaluate(tabId => self.fixtureIcons.filter(call => call.tabId === tabId).at(-1).path, tabId)).toEqual({
      16: 'icons/book-active-16.png', 24: 'icons/book-active-24.png', 32: 'icons/book-active-32.png', 48: 'icons/book-active-48.png',
    });
    await expect.poll(badge).toBe('');

    await website.locator('body > header').evaluate(element => element.remove());
    await expect.poll(title).toBe('0xlabel · Labeling paused');
    await expect.poll(badge).toBe('!');
    expect(await worker.evaluate(tabId => self.fixtureIcons.filter(call => call.tabId === tabId).at(-1).path[16], tabId)).toBe('icons/book-16.png');
    await website.reload();
    await expect.poll(title).toBe('0xlabel · Active on this page');
    await expect.poll(badge).toBe('');

    // A new worker recovers status from the existing controller, without Retry.
    await website.bringToFront();
    const cdp = await context.newCDPSession(popup);
    const workerStates = [];
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      for (const version of event.versions) {
        if (version.scriptURL === worker.url()) workerStates.push(version.runningStatus);
      }
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await expect.poll(() => workerStates.includes('stopped')).toBe(true);
    await popup.reload();
    expect(await worker.evaluate(() => self.fixtureIcons)).toBeUndefined();
    const recovered = await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'State', tabId }), tabId);
    expect(recovered.result.health.status).toBe('ready');
    await expect(popup.getByRole('switch', { name: 'Show my labels on this site' })).toBeChecked();
    await expect(popup.locator('#site-view')).toHaveText('Your labels');
    await expect.poll(title).toBe('0xlabel · Active on this page');
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(500);

    await website.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    await expect.poll(title).toBe('0xlabel');
    await website.goto('https://etherscan.io/accounts');
    await expect.poll(title).toBe('0xlabel · Active on this page');
    await website.bringToFront(); await popup.reload();
    await popup.locator('#site-toggle').click();
    await expect.poll(title).toBe('0xlabel');
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(0);
    await popup.locator('#site-toggle').click();
    await expect.poll(title).toBe('0xlabel · Active on this page');
    await popup.locator('#site-toggle').click();
    await expect.poll(title).toBe('0xlabel');
    await expect.poll(badge).toBe('');
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
