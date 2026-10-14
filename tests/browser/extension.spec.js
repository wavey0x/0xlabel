import { test, expect, chromium, request } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checksumAddress } from '../../extension/checksum.js';

const address = '0x' + 'ab'.repeat(20);
const local = 'http://127.0.0.1:8721';
const remote = 'https://127.0.0.1:8722';
const headers = { Authorization: 'Bearer test-only-token' };

test('installed extension: a book that works with no setup, moving it to a server, alarm pulls, editor and native copy', async () => {
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
    // The toolbar is the only at-a-glance signal of whether a website is being
    // labeled, so record which icon the worker actually asks Chrome to show.
    await worker.evaluate(() => {
      const setIcon = chrome.action.setIcon.bind(chrome.action);
      chrome.action.setIcon = details => { globalThis.shownIcon = details.path?.[16]; return setIcon(details); };
    });
    const toolbar = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8719/*' });
      return { icon: globalThis.shownIcon, title: await chrome.action.getTitle({ tabId: tab.id }) };
    });
    const website = context.pages()[0]; await website.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    await website.evaluate(() => {
      for (const [id, src] of [['embedded', '/tests/fixtures/frame.html'], ['external', 'http://localhost:8719/tests/fixtures/frame.html']]) {
        const frame = document.createElement('iframe'); frame.id = id; frame.src = src; document.body.prepend(frame);
      }
    });
    const embedded = website.frameLocator('#embedded');
    const external = website.frameLocator('#external');
    await expect(embedded.locator('#wallet')).toHaveText(address);
    await expect(external.locator('#wallet')).toHaveText(address);
    const popup = await context.newPage(); await website.bringToFront();
    await popup.setViewportSize({width:380,height:600});
    await popup.goto(`chrome-extension://${id}/popup.html`);
    // Nothing has been set up, so there is a book and it is on this device.
    await expect(popup.locator('#site-name')).toHaveText('127.0.0.1');
    await expect(popup.locator('#location')).toHaveText('default');
    const siteSwitch = popup.getByRole('switch', { name: 'Show my tags on this website' });
    await expect(siteSwitch).not.toBeChecked();
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-16.png', title: '0xlabel · Active on this page' });
    // Label an address with no server anywhere in the picture.
    await website.getByRole('button', { name: 'Edit wallet labels', exact: true }).first().click();
    await website.getByRole('textbox', { name: 'Label 1' }).fill('Kept on this device');
    await website.getByRole('textbox', { name: 'Label 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Kept on this device');

    // Moving the book onto a server takes one pasted line and nothing else.
    const addBook = async (url, key, name) => {
      await popup.locator('#location').click();
      await popup.getByRole('menuitem', { name: /Add an address book/ }).click();
      await popup.getByRole('radio', { name: /On a server/ }).check();
      await popup.locator('#connect-link').fill(`${url}#key=${key}`);
      if (name) await popup.locator('#book-name').fill(name);
      await popup.locator('#connect').click();
    };
    const switchTo = async name => {
      await popup.locator('#location').click();
      await popup.getByRole('menuitemradio', { name: new RegExp(name) }).click();
    };
    await addBook(local, 'test-only-token', 'Local');
    await expect(popup.locator('#server')).toBeHidden({ timeout: 10000 });
    await expect(popup.locator('#location')).toHaveText('Local');
    // The new book holds what its server holds, and nothing was copied into it.
    expect((await (await api.get(local+'/labels')).json()).records).toEqual([localRecord]);
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local treasury');
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local treasury');
    await expect(external.locator('[data-0xlabel-address],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(500);
    const websiteTabId = (await popup.evaluate(() => chrome.tabs.query({url:'http://127.0.0.1:8719/*'})))[0].id;
    const contents = await worker.evaluate(async tabId => chrome.scripting.executeScript({ target:{tabId, allFrames: true}, func:async () => {
      const state = await chrome.runtime.sendMessage({type:'State'});
      let storage;
      try { await chrome.storage.local.get(null); storage='accessible'; } catch { storage='restricted'; }
      const config = await chrome.runtime.sendMessage({type:'Select',url:'https://arbitrary.example'});
      return { state, storage, config };
    } }), websiteTabId);
    expect(contents).toHaveLength(2);
    for (const content of contents) {
      expect(content.result.state.result.enabled).toBe(true);
      expect(JSON.stringify(content.result.state)).not.toContain('test-only-token');
      expect(content.result.storage).toBe('restricted');
      expect(content.result.config.ok).toBe(false);
    }
    // An enabled origin embedded by a different, disabled origin cannot read
    // the book or start an editor, even when both hosts have API permissions.
    const foreign = await context.newPage();
    await foreign.goto(local + '/frame-parent');
    await foreign.setContent('<iframe src="http://127.0.0.1:8719/tests/fixtures/frame.html"></iframe>');
    await expect(foreign.frameLocator('iframe').locator('#wallet')).toHaveText(address);
    const foreignTabId = (await popup.evaluate(url => chrome.tabs.query({ url }), local + '/frame-parent'))[0].id;
    const rejected = await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: async () => {
      return { state: await chrome.runtime.sendMessage({ type: 'State' }), save: await chrome.runtime.sendMessage({ type: 'Save', draft: {} }) };
    } }), foreignTabId);
    expect(rejected).toHaveLength(2);
    for (const frame of rejected) {
      expect(frame.result.state.result).toEqual({ enabled: false });
      expect(frame.result.save.ok).toBe(false);
    }
    await expect(foreign.frameLocator('iframe').locator('[data-0xlabel-address],[data-0xlabel-ui]')).toHaveCount(0);
    await foreign.close(); await website.bringToFront();

    // A key the server refuses never becomes a book.
    await addBook(remote, 'wrong-token', 'Remote');
    await expect(popup.locator('#server-error')).toContainText('rejected');
    await popup.locator('#connect-link').press('Escape');
    await expect(popup.locator('#server')).toBeHidden();
    await expect(popup.locator('#location')).toHaveText('Local');
    // Books are separate: a second one shows what its own server holds.
    await addBook(remote, 'test-only-token', 'Remote');
    await expect(popup.locator('#server')).toBeHidden({ timeout: 10000 });
    await expect(popup.locator('#location')).toHaveText('Remote');
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label');
    await expect(embedded.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label');
    expect((await (await api.get(local+'/labels')).json()).records).toEqual([localRecord]);

    const remoteRecord = (await (await api.put(`${remote}/labels/global/${address}`, { data:{labels:['Remote vault'],version:null} })).json()).record;
    // Exercise the real alarm listener with an accelerated one-shot test alarm.
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Remote vault', { timeout:10000 });
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Remote vault');
    await api.put(`${remote}/labels/global/${address}`, { data:{labels:[],version:remoteRecord.version} });
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label', /./, { timeout:10000 });
    await switchTo('Local');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Local treasury');
    await website.getByRole('button',{name:'Edit wallet labels',exact:true}).first().click();
    await website.getByRole('textbox',{name:'Label 1'}).fill('Local edited');
    await website.getByRole('textbox',{name:'Label 1'}).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label','Local edited');
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await embedded.getByRole('button', { name: 'Edit wallet labels', exact: true }).click();
    await embedded.getByRole('textbox', { name: 'Label 1' }).fill('Edited in embedded view');
    await embedded.getByRole('textbox', { name: 'Label 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Edited in embedded view');
    await embedded.getByRole('button', { name: 'Edit wallet labels', exact: true }).click();
    await embedded.getByRole('textbox', { name: 'Label 1' }).fill('Local edited');
    await embedded.getByRole('textbox', { name: 'Label 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await embedded.locator('#copy').click();
    expect(await website.evaluate(() => navigator.clipboard.readText())).toBe(address);
    expect((await (await api.get(remote+'/labels')).json()).records).toEqual([]);
    await website.locator('#copy').click();
    expect(await website.evaluate(async address=>(await navigator.clipboard.readText())===address,address)).toBe(true);

    const another = await context.newPage();
    await another.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await another.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'late-frame'; frame.src = '/tests/fixtures/frame.html'; document.body.append(frame);
    });
    await expect(another.frameLocator('#late-frame').locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    const savedBeforeReveal = (await (await api.get(local + '/labels')).json()).records;
    await website.getByRole('button', { name: 'Edit wallet labels', exact: true }).first().click();
    const addressSwitch = website.getByRole('switch', { name: 'Show my tags for this address', exact: true });
    await expect(addressSwitch).toBeChecked();
    await addressSwitch.click();
    await expect(addressSwitch).not.toBeChecked();
    await expect(website.locator('[data-0xlabel-label]')).toHaveCount(0);
    await expect(website.locator('[data-0xlabel-edit]')).toHaveCount(500);
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    expect((await (await api.get(local + '/labels')).json()).records).toEqual(savedBeforeReveal);
    await website.reload();
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await website.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'embedded'; frame.src = '/tests/fixtures/frame.html'; document.body.prepend(frame);
    });
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).not.toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-idle-16.png', title: '0xlabel' });
    await expect(website.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(another.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(embedded.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(another.frameLocator('#late-frame').locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await expect(website.locator('#wallet')).toHaveText(address);
    await website.reload();
    await expect(website.locator('[data-0xlabel-address]')).toHaveCount(0);
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-16.png', title: '0xlabel · Active on this page' });
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(website.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
    await another.close();
    const bookPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    const book = await bookPromise;
    await book.waitForURL(`chrome-extension://${id}/book.html`);
    await book.setViewportSize({ width: 1200, height: 800 });
    await expect(book.locator('.record')).toHaveCount(1);
    await book.getByRole('button', { name: '+ Add address', exact: true }).click();
    await book.locator('#manual-address').fill('0x123');
    await book.getByRole('button', { name: 'Add tags', exact: true }).click();
    await expect(book.locator('#address-error')).toContainText('full hexadecimal');
    await book.getByRole('button', { name: 'Cancel', exact: true }).click();
    const added='0x'+'ef'.repeat(20);
    await book.getByRole('button', { name: '+ Add address', exact: true }).click();
    await book.locator('#manual-address').fill(added); await book.locator('#network').fill('8453');
    await book.getByRole('button',{name:'Add tags',exact:true}).click();
    await book.getByRole('textbox',{name:'Label 1'}).fill('New Base wallet');
    // Switching books under an open draft must not let it save into the new one.
    await switchTo('Remote');
    await expect(book.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(book.getByRole('textbox', { name: 'Label 1' })).toHaveValue('New Base wallet');
    await switchTo('Local');
    await expect(book.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await book.getByRole('button',{name:'Add label',exact:false}).click();
    await book.getByRole('textbox',{name:'Label 2'}).fill('Second alias');
    await book.getByRole('textbox',{name:'Label 2'}).press('Enter');
    await expect(book.getByRole('dialog')).toHaveCount(0);
    const addedRecord=(await (await api.get(local+'/labels')).json()).records.find(record=>record.address===added);
    expect(addedRecord).toMatchObject({address:added,scope:'eip155:8453',labels:['New Base wallet','Second alias']});
    await book.locator('#search').fill('Second alias');
    await expect(book.locator('.record')).toHaveCount(1);
    await expect(book.locator('.record')).toContainText('New Base wallet');
    await expect(book.locator('.record')).toHaveAttribute('title', checksumAddress(added));
    await book.locator('#search').fill(added.toUpperCase());
    await expect(book.locator('.record')).toHaveCount(1);
    await book.bringToFront();
    await book.locator('#results .copy').click();
    // Keep the book focused until the clipboard write completes.
    await expect(book.getByRole('button', { name: `Copied ${checksumAddress(added)}`, exact: true })).toBeVisible();
    await website.bringToFront();
    expect(await website.evaluate(() => navigator.clipboard.readText())).toBe(checksumAddress(added));

    await book.bringToFront();
    const downloadPromise=book.waitForEvent('download');
    await book.locator('#export').click(); const download=await downloadPromise;
    const exported=JSON.parse(await readFile(await download.path(),'utf8'));
    expect(exported.records).toContainEqual(addedRecord);
    expect(JSON.stringify(exported)).not.toContain('token');
    await book.locator('.record').click();
    await book.getByRole('button', { name: 'Remove tags', exact: true }).click();
    expect((await (await api.get(local+'/labels')).json()).records).toContainEqual(addedRecord);
    await book.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(book.getByRole('dialog')).toHaveCount(0);
    expect((await (await api.get(local+'/labels')).json()).records.some(record=>record.address===added)).toBe(false);
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    expect(context.pages().filter(page=>page.url()===`chrome-extension://${id}/book.html`)).toHaveLength(1);
    // Reopening the book preserves a user's search and unsaved draft.
    await book.locator('#search').fill('Local');
    await book.locator('.record').click();
    await book.getByRole('textbox', { name: 'Label 1' }).fill('Unsaved book edit');
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    await expect(book.locator('#search')).toHaveValue('Local');
    await expect(book.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Unsaved book edit');
    expect(context.pages().filter(page=>page.url()===`chrome-extension://${id}/book.html`)).toHaveLength(1);
    await book.close();
    const reopenedPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    const reopened = await reopenedPromise;
    await reopened.waitForURL(`chrome-extension://${id}/book.html`);
    await expect(reopened.locator('.record')).toHaveCount(1);
    await expect(reopened.locator('.record')).toContainText('Local edited');
    // Renaming, and the two removals: forgetting a server book leaves the server
    // holding it, while removing one kept here is the only way addresses are lost.
    await reopened.bringToFront();
    await reopened.locator('#book-settings').click();
    await reopened.locator('#book-rename').fill('Local notebook');
    await reopened.locator('#save-manage').click();
    await expect(reopened.locator('#location')).toHaveText('Local notebook');
    await reopened.locator('#book-settings').click();
    await reopened.locator('#remove-book').click();
    await expect(reopened.locator('#remove-copy')).toContainText('keeps everything in it');
    await expect(reopened.locator('#confirm-remove')).toHaveText('Remove');
    await reopened.locator('#confirm-remove').click();
    await expect(reopened.locator('#manage-dialog')).toBeHidden();
    // The server still has every record the forgotten book was showing.
    expect((await (await api.get(local+'/labels')).json()).records.length).toBeGreaterThan(0);
    await expect(reopened.locator('#location')).not.toHaveText('Local notebook');
    await reopened.locator('#book-settings').click();
    await reopened.locator('#remove-book').click();
    await expect(reopened.locator('#remove-copy')).toContainText('cannot be undone');
    await expect(reopened.locator('#confirm-remove')).toHaveText('Delete');
    await reopened.locator('#keep-book').click();
    await expect(reopened.locator('#remove-confirm')).toBeHidden();
    await reopened.locator('#cancel-manage').click();
    await expect(reopened.locator('#manage-dialog')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close(); await api.dispose(); await rm(profile,{recursive:true,force:true});
  }
});
