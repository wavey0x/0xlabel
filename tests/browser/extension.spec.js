import { test, expect, chromium, request } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checksumAddress } from '../../extension/checksum.js';

const address = '0x' + 'ab'.repeat(20);
const local = 'http://127.0.0.1:8721';
const remote = 'https://127.0.0.1:8722';
const headers = { Authorization: 'Bearer test-only-token' };

test('installed extension: authenticated HTTP/HTTPS books, source isolation, alarm pulls, editor and native copy', async () => {
  test.setTimeout(90000);
  const api = await request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: headers });
  const seed = await api.put(`${local}/labels/global/${address}`, { data: { labels: ['Local treasury'], version: null } });
  expect(seed.ok()).toBeTruthy();
  const localRecord = (await seed.json()).record;
  const profile = await mkdtemp(path.join(tmpdir(), '0xlabel-chrome-test-'));
  const extension = path.join(profile, 'extension');
  await cp(path.resolve('extension'), extension, { recursive: true });
  // Native permission dialogs are outside Playwright's headless DOM. Grant only
  // the loopback fixture origins at installation; all shipped JS stays unchanged.
  const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*','https://127.0.0.1/*'];
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors'],
  });
  const errors = [];
  context.on('weberror', error => errors.push(error.error().message));
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write'], {origin:'http://127.0.0.1:8719'});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const website = context.pages()[0]; await website.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    const popup = await context.newPage(); await website.bringToFront();
    await popup.setViewportSize({width:380,height:600});
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator('#api-url').fill(local);
    await popup.locator('#token').fill('test-only-token');
    await popup.locator('#name').fill('Local');
    await popup.locator('#connect').click();
    await expect(popup.locator('#settings')).toBeHidden({ timeout: 10000 });
    await expect(popup.locator('#connection')).toHaveValue(local);
    const siteSwitch = popup.getByRole('switch', { name: 'Show my labels on this site' });
    await expect(siteSwitch).not.toBeChecked();
    await expect(popup.locator('#site-view')).toHaveText('Website defaults');
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).toBeChecked();
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local treasury');
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(500);
    const websiteTabId = (await popup.evaluate(() => chrome.tabs.query({url:'http://127.0.0.1:8719/*'})))[0].id;
    const [content] = await worker.evaluate(async tabId => chrome.scripting.executeScript({ target:{tabId}, func:async () => {
      const state = await chrome.runtime.sendMessage({type:'State'});
      let storage;
      try { await chrome.storage.local.get(null); storage='accessible'; } catch { storage='restricted'; }
      const config = await chrome.runtime.sendMessage({type:'Select',url:'https://arbitrary.example'});
      return { state, storage, config };
    } }), websiteTabId);
    expect(JSON.stringify(content.result.state)).not.toContain('test-only-token');
    expect(content.result.storage).toBe('restricted');
    expect(content.result.config.ok).toBe(false);

    await popup.locator('#settings-toggle').click();
    await popup.locator('#api-url').fill(remote); await popup.locator('#token').fill('test-only-token'); await popup.locator('#name').fill('Remote');
    await popup.locator('#connect').click();
    await expect(popup.locator('#settings')).toBeHidden();
    await expect(popup.locator('#connection')).toHaveValue(remote);
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label');
    expect((await (await api.get(local+'/labels')).json()).records).toEqual([localRecord]);
    const caches = await worker.evaluate(async ({local,remote}) => {
      const result = await chrome.storage.local.get([`connection:${local}`, `connection:${remote}`]);
      return { local: result[`connection:${local}`].records, remote: result[`connection:${remote}`].records };
    }, {local,remote});
    expect(caches.local).toEqual([localRecord]); expect(caches.remote).toEqual([]);

    const remoteRecord = (await (await api.put(`${remote}/labels/global/${address}`, { data:{labels:['Remote vault'],version:null} })).json()).record;
    // Exercise the real alarm listener with an accelerated one-shot test alarm.
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Remote vault', { timeout:10000 });
    await api.put(`${remote}/labels/global/${address}`, { data:{labels:[],version:remoteRecord.version} });
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label', /./, { timeout:10000 });
    await popup.locator('#connection').selectOption(local);
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Local treasury');
    await website.getByRole('button',{name:'Edit wallet labels',exact:true}).first().click();
    await website.getByRole('textbox',{name:'Label 1'}).fill('Local edited');
    await website.getByRole('textbox',{name:'Label 1'}).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Local edited');
    expect((await (await api.get(remote+'/labels')).json()).records).toEqual([]);
    await website.locator('#copy').click();
    expect(await website.evaluate(async address=>(await navigator.clipboard.readText())===address,address)).toBe(true);

    const another = await context.newPage();
    await another.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    const savedBeforeReveal = (await (await api.get(local + '/labels')).json()).records;
    await website.getByRole('button', { name: 'Edit wallet labels', exact: true }).first().click();
    await website.getByRole('button', { name: 'Show website original', exact: true }).click();
    await expect(website.locator('[data-0xlabel-label]')).toHaveCount(0);
    await expect(website.locator('[data-0xlabel-edit]')).toHaveCount(500);
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    expect((await (await api.get(local + '/labels')).json()).records).toEqual(savedBeforeReveal);
    await website.reload();
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).not.toBeChecked();
    await expect(popup.locator('#site-view')).toHaveText('Website defaults');
    await expect(website.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(another.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(website.locator('#wallet')).toHaveText(address);
    await website.reload();
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(0);
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).toBeChecked();
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(website.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await another.close();
    const added='0x'+'ef'.repeat(20);
    await popup.locator('#manual-address').fill(added); await popup.locator('#network').fill('8453');
    await popup.getByRole('button',{name:'Label address',exact:true}).click();
    await popup.getByRole('textbox',{name:'Label 1'}).fill('New Base wallet');
    await popup.getByRole('button',{name:'Add label',exact:false}).click();
    await popup.getByRole('textbox',{name:'Label 2'}).fill('Second alias');
    await popup.getByRole('textbox',{name:'Label 2'}).press('Enter');
    await expect(popup.getByRole('dialog')).toHaveCount(0);
    const addedRecord=(await (await api.get(local+'/labels')).json()).records.find(record=>record.address===added);
    expect(addedRecord).toMatchObject({address:added,scope:'eip155:8453',labels:['New Base wallet','Second alias']});
    await popup.locator('#search').fill('Second alias');
    await expect(popup.locator('.record')).toHaveCount(1);
    await expect(popup.locator('.record')).toContainText('New Base wallet');
    await expect(popup.locator('.record')).toHaveAttribute('title', checksumAddress(added));
    await popup.locator('#search').fill(added.toUpperCase());
    await expect(popup.locator('#manual-address')).toHaveValue(checksumAddress(added));
    await popup.bringToFront();
    await popup.locator('#results .copy').click();
    // Keep the popup focused until the clipboard write completes.
    await expect(popup.getByRole('button', { name: `Copied ${checksumAddress(added)}`, exact: true })).toBeVisible();
    await website.bringToFront();
    expect(await website.evaluate(() => navigator.clipboard.readText())).toBe(checksumAddress(added));
    await popup.bringToFront();
    const downloadPromise=popup.waitForEvent('download');
    await popup.locator('#export').click(); const download=await downloadPromise;
    const exported=JSON.parse(await readFile(await download.path(),'utf8'));
    expect(exported.records).toContainEqual(addedRecord);
    expect(JSON.stringify(exported)).not.toContain('token');
    expect(errors).toEqual([]);
  } finally {
    await context.close(); await api.dispose(); await rm(profile,{recursive:true,force:true});
  }
});
