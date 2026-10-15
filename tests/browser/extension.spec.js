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
  const seed = await api.put(`${local}/tags/global/${address}`, { data: { tags: ['Local treasury'], version: null } });
  expect(seed.ok()).toBeTruthy();
  const localRecord = (await seed.json()).record;
  const profile = await mkdtemp(path.join(tmpdir(), '0xtagger-chrome-test-'));
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
    // tagged, so record which icon the worker actually asks Chrome to show.
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
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-16.png', title: '0xtagger · Active on this page' });
    // Tag an address with no server anywhere in the picture. One name changing
    // is announced as that name: the book is not sent to every tab again.
    await popup.evaluate(() => {
      window.heard = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type === 'Updated') window.heard.push(message.state ? 'book' : 'record');
      });
    });
    await website.getByRole('button', { name: 'Edit wallet tags', exact: true }).first().click();
    await website.getByRole('textbox', { name: 'Tag 1' }).fill('Kept on this device');
    await website.getByRole('textbox', { name: 'Tag 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Kept on this device');
    expect(await popup.evaluate(() => window.heard)).toEqual(['record']);

    // Connecting a server takes one pasted line and nothing else: no name to
    // invent before seeing what is there, and no decision about copying.
    const addBook = async (url, key) => {
      await popup.locator('#location').click();
      await popup.getByRole('menuitem', { name: 'Connect to a server' }).click();
      await popup.locator('#connect-link').fill(`${url}#key=${key}`);
      await popup.locator('#connect').click();
    };
    // A book is named in its own row, wherever it is kept.
    const renameBook = async name => {
      await popup.locator('#location').click();
      await popup.locator('.book-option:has([aria-checked="true"]) .rename').click();
      await popup.locator('.name-edit').fill(name);
      await popup.locator('.name-edit').press('Enter');
      // The list stays open after a rename, so it is put away deliberately.
      await expect(popup.locator('.name-edit')).toHaveCount(0);
      await popup.keyboard.press('Escape');
      await expect(popup.locator('#location-menu')).toBeHidden();
    };
    const switchTo = async name => {
      await popup.locator('#location').click();
      await popup.getByRole('menuitemradio', { name: new RegExp(name) }).click();
    };
    await addBook(local, 'test-only-token');
    // The server already holds a book, so nothing is offered and it just opens,
    // named for being on this machine until it is called something else.
    await expect(popup.locator('#server')).toBeHidden({ timeout: 10000 });
    await expect(popup.locator('#location')).toHaveText('Local server');
    await renameBook('Local');
    await expect(popup.locator('#location')).toHaveText('Local');
    // The new book holds what its server holds, and nothing was copied into it.
    expect((await (await api.get(local+'/tags')).json()).records).toEqual([localRecord]);
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local treasury');
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local treasury');
    await expect(external.locator('[data-0xtagger-address],[data-0xtagger-ui]')).toHaveCount(0);
    await expect(website.locator('[data-0xtagger-address]')).toHaveCount(500);
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
    await expect(foreign.frameLocator('iframe').locator('[data-0xtagger-address],[data-0xtagger-ui]')).toHaveCount(0);
    await foreign.close(); await website.bringToFront();

    // A key the server refuses never becomes a book.
    await addBook(remote, 'wrong-token');
    await expect(popup.locator('#server-error')).toContainText('rejected');
    await popup.locator('#connect-link').press('Escape');
    await expect(popup.locator('#server')).toBeHidden();
    await expect(popup.locator('#location')).toHaveText('Local');
    // Books are separate: a second one shows what its own server holds.
    await addBook(remote, 'test-only-token');
    // This one is empty and the last one was not, which is the only moment
    // carrying names over is worth asking about. Asked once, here, and never
    // raised again by itself.
    // Connecting asks nothing about copying: the book opens as it is.
    await expect(popup.locator('#server')).toBeHidden({ timeout: 10000 });
    expect((await (await api.get(remote+'/tags')).json()).records).toEqual([]);
    await renameBook('Remote');
    await expect(popup.locator('#location')).toHaveText('Remote');
    // A browser popup is only as tall as its document, so an open menu has to
    // fit inside it: every book stays reachable rather than clipped by the frame.
    await popup.setViewportSize({ width: 380, height: 240 });
    await popup.locator('#location').click();
    await expect.poll(() => popup.evaluate(() => {
      const menu = document.querySelector('#location-menu');
      return menu.getBoundingClientRect().bottom + 20 <= document.body.getBoundingClientRect().height;
    })).toBe(true);
    await popup.keyboard.press('Escape');
    await popup.setViewportSize({ width: 380, height: 600 });
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xtagger-tag');
    await expect(embedded.locator('#wallet')).not.toHaveAttribute('data-0xtagger-tag');
    expect((await (await api.get(local+'/tags')).json()).records).toEqual([localRecord]);

    const remoteRecord = (await (await api.put(`${remote}/tags/global/${address}`, { data:{tags:['Remote vault'],version:null} })).json()).record;
    // Exercise the real alarm listener with an accelerated one-shot test alarm.
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Remote vault', { timeout:10000 });
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Remote vault');
    await api.put(`${remote}/tags/global/${address}`, { data:{tags:[],version:remoteRecord.version} });
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await expect(website.locator('#wallet')).not.toHaveAttribute('data-0xtagger-tag', /./, { timeout:10000 });
    // A pull that learns nothing changes nothing: no new revision, so no view
    // is told anything and no page repaints.
    const revisionNow = async () => (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'State' }))).result.state.stateRevision;
    const settled = await revisionNow();
    await worker.evaluate(() => chrome.alarms.create('sync', { when:Date.now()+100 }));
    await popup.waitForTimeout(1000);
    expect(await revisionNow()).toBe(settled);
    await switchTo('Local');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag','Local treasury');
    await website.getByRole('button',{name:'Edit wallet tags',exact:true}).first().click();
    await website.getByRole('textbox',{name:'Tag 1'}).fill('Local edited');
    await website.getByRole('textbox',{name:'Tag 1'}).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag','Local edited');
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await embedded.getByRole('button', { name: 'Edit wallet tags', exact: true }).click();
    await embedded.getByRole('textbox', { name: 'Tag 1' }).fill('Edited in embedded view');
    await embedded.getByRole('textbox', { name: 'Tag 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Edited in embedded view');
    await embedded.getByRole('button', { name: 'Edit wallet tags', exact: true }).click();
    await embedded.getByRole('textbox', { name: 'Tag 1' }).fill('Local edited');
    await embedded.getByRole('textbox', { name: 'Tag 1' }).press('Enter');
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await embedded.locator('#copy').click();
    expect(await website.evaluate(() => navigator.clipboard.readText())).toBe(address);
    expect((await (await api.get(remote+'/tags')).json()).records).toEqual([]);
    await website.locator('#copy').click();
    expect(await website.evaluate(async address=>(await navigator.clipboard.readText())===address,address)).toBe(true);

    const another = await context.newPage();
    await another.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await another.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'late-frame'; frame.src = '/tests/fixtures/frame.html'; document.body.append(frame);
    });
    await expect(another.frameLocator('#late-frame').locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    const savedBeforeReveal = (await (await api.get(local + '/tags')).json()).records;
    await website.getByRole('button', { name: 'Edit wallet tags', exact: true }).first().click();
    const addressSwitch = website.getByRole('switch', { name: 'Show my tags for this address', exact: true });
    await expect(addressSwitch).toBeChecked();
    await addressSwitch.click();
    await expect(addressSwitch).not.toBeChecked();
    await expect(website.locator('[data-0xtagger-tag]')).toHaveCount(0);
    await expect(website.locator('[data-0xtagger-edit]')).toHaveCount(500);
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    expect((await (await api.get(local + '/tags')).json()).records).toEqual(savedBeforeReveal);
    await website.reload();
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await website.evaluate(() => {
      const frame = document.createElement('iframe'); frame.id = 'embedded'; frame.src = '/tests/fixtures/frame.html'; document.body.prepend(frame);
    });
    await expect(embedded.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).not.toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-idle-16.png', title: '0xtagger' });
    await expect(website.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
    await expect(another.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
    await expect(embedded.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
    await expect(another.frameLocator('#late-frame').locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
    await expect(website.locator('#wallet')).toHaveText(address);
    await website.reload();
    await expect(website.locator('[data-0xtagger-address]')).toHaveCount(0);
    await popup.locator('#site-toggle').click();
    await expect(siteSwitch).toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-16.png', title: '0xtagger · Active on this page' });
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await expect(another.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(website.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
    // Chrome's question can outlive the popup that asked it, and Brave closes
    // that popup outright. The note the switch leaves behind is enough: the
    // worker turns the website on, with no Site message from anywhere.
    await worker.evaluate(origin => chrome.storage.session.set({ pendingSite: { origin, at: Date.now() } }), 'http://127.0.0.1:8719');
    await popup.reload();
    await expect(siteSwitch).toBeChecked();
    await expect.poll(toolbar).toEqual({ icon: 'icons/mark-16.png', title: '0xtagger · Active on this page' });
    await expect(website.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Local edited');
    await popup.locator('#site-toggle').click();
    await expect(website.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
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
    await book.getByRole('textbox',{name:'Tag 1'}).fill('New Base wallet');
    // Switching books under an open draft must not let it save into the new one.
    await switchTo('Remote');
    await expect(book.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(book.getByRole('textbox', { name: 'Tag 1' })).toHaveValue('New Base wallet');
    await switchTo('Local');
    await expect(book.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await book.getByRole('button',{name:'Add tag',exact:false}).click();
    await book.getByRole('textbox',{name:'Tag 2'}).fill('Second alias');
    await book.getByRole('textbox',{name:'Tag 2'}).press('Enter');
    await expect(book.getByRole('dialog')).toHaveCount(0);
    const addedRecord=(await (await api.get(local+'/tags')).json()).records.find(record=>record.address===added);
    expect(addedRecord).toMatchObject({address:added,scope:'eip155:8453',tags:['New Base wallet','Second alias']});
    await book.locator('#search').fill('Second alias');
    await expect(book.locator('.record')).toHaveCount(1);
    await expect(book.locator('.record')).toContainText('New Base wallet');
    await expect(book.locator('.record')).toHaveAttribute('data-tip', checksumAddress(added));
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
    expect((await (await api.get(local+'/tags')).json()).records).toContainEqual(addedRecord);
    await book.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(book.getByRole('dialog')).toHaveCount(0);
    expect((await (await api.get(local+'/tags')).json()).records.some(record=>record.address===added)).toBe(false);
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    expect(context.pages().filter(page=>page.url()===`chrome-extension://${id}/book.html`)).toHaveLength(1);
    // Reopening the book preserves a user's search and unsaved draft.
    await book.locator('#search').fill('Local');
    await book.locator('.record').click();
    await book.getByRole('textbox', { name: 'Tag 1' }).fill('Unsaved book edit');
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    await expect(book.locator('#search')).toHaveValue('Local');
    await expect(book.getByRole('textbox', { name: 'Tag 1' })).toHaveValue('Unsaved book edit');
    expect(context.pages().filter(page=>page.url()===`chrome-extension://${id}/book.html`)).toHaveLength(1);
    await book.close();
    const reopenedPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open address book', exact: false }).click();
    const reopened = await reopenedPromise;
    await reopened.waitForURL(`chrome-extension://${id}/book.html`);
    await expect(reopened.locator('.record')).toHaveCount(1);
    await expect(reopened.locator('.record')).toContainText('Local edited');
    // A book is renamed in its own row in the menu, and a name another book
    // already holds is refused in that row rather than anywhere else.
    await reopened.bringToFront();
    await reopened.locator('#location').click();
    await reopened.getByRole('menuitem', { name: 'Rename Local', exact: true }).click();
    const nameField = reopened.getByRole('textbox', { name: 'Rename Local', exact: true });
    await nameField.fill('default');
    await nameField.press('Enter');
    await expect(reopened.locator('#location-menu .message')).toContainText('already have an address book');
    await expect(reopened.locator('#location')).toHaveText('Local');
    await nameField.fill('Local notebook');
    await nameField.press('Enter');
    await expect(reopened.locator('#location')).toHaveText('Local notebook');
    await reopened.keyboard.press('Escape');
    // The two removals: forgetting a server book leaves the server holding it,
    // while removing one kept here is the only way addresses are lost.
    await reopened.locator('#remove-book').click();
    await expect(reopened.locator('#remove-copy')).toContainText('keeps its 1 address');
    await expect(reopened.locator('#confirm-remove')).toHaveText('Remove');
    // Forgetting a book the server still holds costs nothing, so nothing is asked.
    await expect(reopened.locator('#remove-name')).toBeHidden();
    await reopened.locator('#confirm-remove').click();
    await expect(reopened.locator('#remove-dialog')).toBeHidden();
    // The server still has every record the forgotten book was showing.
    expect((await (await api.get(local+'/tags')).json()).records.length).toBeGreaterThan(0);
    await expect(reopened.locator('#location')).not.toHaveText('Local notebook');
    await reopened.locator('#remove-book').click();
    await expect(reopened.locator('#remove-copy')).toContainText('cannot be undone');
    await expect(reopened.locator('#confirm-remove')).toHaveText('Delete');
    // Addresses are only ever lost on purpose: the book's own name unlocks it.
    await expect(reopened.locator('#confirm-remove')).toBeDisabled();
    await reopened.locator('#remove-name').fill('Default');
    await expect(reopened.locator('#confirm-remove')).toBeDisabled();
    await reopened.locator('#remove-name').fill(' default ');
    await expect(reopened.locator('#confirm-remove')).toBeEnabled();
    await reopened.locator('#keep-book').click();
    await expect(reopened.locator('#remove-dialog')).toBeHidden();
    // A book large enough to be worth searching shows a screenful, not all of
    // it, and carrying one in is a single pass over its pages.
    const carried = Array.from({ length: 300 }, (_, index) => ({
      address: '0x' + index.toString(16).padStart(40, '0'), scope: 'global',
      tags: ['Carried in ' + index], version: 'from-file',
    }));
    const importing = Date.now();
    expect(await reopened.evaluate(async records =>
      (await chrome.runtime.sendMessage({ type: 'Import', records })).result.added, carried)).toBe(300);
    expect(Date.now() - importing).toBeLessThan(5000);
    await expect(reopened.locator('#results tr')).toHaveCount(250);
    await expect(reopened.locator('#shown')).toContainText('Showing 250 of 301');
    await reopened.locator('#search').fill('Carried in 199');
    await expect(reopened.locator('#results tr')).toHaveCount(1);
    await expect(reopened.locator('#shown')).toBeHidden();

    // Connecting and copying stay separate, and the copy waits where the
    // emptiness is rather than demanding an answer on the way in. The remote
    // server was emptied above, so forgetting that book and connecting again
    // is a book opening empty beside one holding three hundred names.
    const pick = async name => {
      await reopened.locator('#location').click();
      await reopened.getByRole('menuitemradio', { name: new RegExp(name) }).click();
    };
    await pick('Remote');
    await reopened.locator('#remove-book').click();
    // Forgetting a server book loses nothing, so it asks for nothing typed.
    await expect(reopened.locator('#remove-name')).toBeHidden();
    await reopened.locator('#confirm-remove').click();
    await expect(reopened.locator('#remove-dialog')).toBeHidden();
    await expect(reopened.locator('#shown')).toContainText('Showing 250 of 301');

    await reopened.locator('#location').click();
    await reopened.getByRole('menuitem', { name: 'Connect to a server' }).click();
    await reopened.locator('#connect-link').fill(`${remote}#key=test-only-token`);
    await reopened.locator('#connect').click();
    await expect(reopened.locator('#server')).toBeHidden({ timeout: 10000 });
    await expect(reopened.locator('#copy-in')).toHaveText('Copy 301 addresses from default');
    await reopened.locator('#copy-in').click();
    // Carried over into the book it was offered for, and the one it came from
    // still holds every name it had.
    await expect(reopened.locator('#shown')).toContainText('Showing 250 of 301', { timeout: 15000 });
    await expect(reopened.locator('#copy-in')).toBeHidden();
    expect((await (await api.get(remote+'/tags')).json()).records).toHaveLength(301);
    await pick('default');
    await expect(reopened.locator('#shown')).toContainText('Showing 250 of 301');

    expect(errors).toEqual([]);
  } finally {
    await context.close(); await api.dispose(); await rm(profile,{recursive:true,force:true});
  }
});

// Importing is one screen you read: what is going where, what is already
// yours, and one button. The write that follows comes from the book page,
// never from the website the names were read on.
test('installed extension: a file is reviewed before it lands, and a page cannot import', async () => {
  test.setTimeout(90000);
  const other = '0x' + 'cd'.repeat(20);
  const profile = await mkdtemp(path.join(tmpdir(), '0xtagger-chrome-import-'));
  const extension = path.join(profile, 'extension');
  await cp(path.resolve('extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://127.0.0.1/*'];
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors'],
  });
  const errors = [];
  context.on('weberror', error => errors.push(error.error().message));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const book = await context.newPage();
    await book.goto(`chrome-extension://${id}/book.html`);
    await expect(book.locator('.book')).toBeVisible();

    // Something already in the book, so the review has a name to keep.
    await book.evaluate(async at => {
      await chrome.runtime.sendMessage({ type: 'Save',
        draft: { book: (await chrome.runtime.sendMessage({ type: 'State' })).result.state.activeBook,
          address: at, scope: 'global', tags: ['Treasury'], version: null } });
    }, address);
    await expect(book.locator('#results tr')).toHaveCount(1);

    // A file carried onto the page is the same file as one picked from a
    // dialog, and the page itself is the target: no small area to find, and
    // nothing on screen until something is actually being carried over it.
    await expect(book.locator('#drop')).toBeHidden();
    const carried = await book.evaluateHandle(text => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'carried.json', { type: 'application/json' }));
      return transfer;
    }, JSON.stringify({ records: [{ address: '0x' + '34'.repeat(20), scope: 'global', tags: ['Dropped in'] }] }));
    await book.dispatchEvent('body', 'dragenter', { dataTransfer: carried });
    await expect(book.locator('#drop')).toBeVisible();
    await book.dispatchEvent('body', 'drop', { dataTransfer: carried });
    await expect(book.locator('#drop')).toBeHidden();
    await expect(book.locator('#review')).toBeVisible();
    await expect(book.locator('#review-into')).toContainText('carried.json');
    await expect(book.locator('#review-rows')).toContainText('Dropped in');
    await book.locator('#cancel-import').click();

    // One book is one decision, so a handful at once is refused rather than
    // guessed at — and the reason stays up, instead of being wiped by the
    // review that would otherwise have opened over it.
    const several = await book.evaluateHandle(text => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'one.json', { type: 'application/json' }));
      transfer.items.add(new File([text], 'two.json', { type: 'application/json' }));
      return transfer;
    }, JSON.stringify({ records: [{ address: '0x' + '56'.repeat(20), scope: 'global', tags: ['Not read'] }] }));
    await book.dispatchEvent('body', 'drop', { dataTransfer: several });
    await expect(book.locator('#message')).toHaveText('2 files. Drop one book at a time.');
    await expect(book.locator('#review')).toBeHidden();
    await expect(book.locator('#message')).toHaveText('2 files. Drop one book at a time.');

    // Safe's signer export: no header, no network, and a signer nobody named.
    const file = [`${address},Safe calls it this`, `${other},dudesahn`, `${'0x' + 'ef'.repeat(20)},`].join('\n');
    await book.locator('#import-file').setInputFiles({ name: '1-signers.csv', mimeType: 'text/csv', buffer: Buffer.from(file) });

    await expect(book.locator('#review')).toBeVisible();
    await expect(book.locator('.book-panel')).toBeHidden();
    await expect(book.locator('#review-rows tr')).toHaveCount(1);
    await expect(book.locator('#review-rows')).toContainText('dudesahn');
    await expect(book.locator('#review-summary')).toContainText('1 name you already have was kept');
    await expect(book.locator('#review-summary')).toContainText('1 unnamed row skipped');
    // The file named no network, so the choice is shown rather than asked.
    await expect(book.locator('#review-scope')).toBeVisible();
    await expect(book.locator('#review-rows')).toContainText('All networks');
    await expect(book.locator('#confirm-import')).toHaveText('Import 1 name');

    // Changing the one network choice reworks the screen before anything lands.
    await book.locator('#review-network').fill('8453');
    await expect(book.locator('#review-rows')).toContainText('Base');
    await book.locator('#review-network').fill('');

    await book.locator('#confirm-import').click();
    await expect(book.locator('#review')).toBeHidden();
    await expect(book.locator('#message')).toContainText('1 name imported');
    await expect(book.locator('#results tr')).toHaveCount(2);
    // Where a name came from is answerable from the book, under the name, with
    // the network it stands on — and searchable, so one question finds them all.
    await expect(book.locator('#results tr', { hasText: 'dudesahn' }).locator('small'))
      .toHaveText("All networks · from Safe's address book");
    await expect(book.locator('#results tr', { hasText: 'Treasury' }).locator('small'))
      .toHaveText('All networks');
    await book.locator('#search').fill('safe');
    await expect(book.locator('#results tr')).toHaveCount(1);
    await expect(book.locator('#results tr')).toContainText('dudesahn');
    await book.locator('#search').fill('');
    // The name already held was never touched, and the new one kept its origin.
    const held = await book.evaluate(async () =>
      (await chrome.runtime.sendMessage({ type: 'State' })).result.state.records);
    expect(held.find(item => item.address === address).tags).toEqual(['Treasury']);
    expect(held.find(item => item.address === other)).toMatchObject({ tags: ['dudesahn'], scope: 'global' });

    // A website can be asked what it keeps; it never decides what is done with
    // the answer. The extension declares no externally_connectable, so a page
    // has nothing to send with, and the worker refuses these verbs from
    // anything that is not one of its own views regardless.
    // Making a book on this device is one click and a name typed where the
    // name lives. No dialog stands between the two.
    await book.locator('#location').click();
    await book.getByRole('menuitem', { name: 'New on this device' }).click();
    await expect(book.locator('.name-edit')).toBeFocused();
    await book.locator('.name-edit').fill('Scratch');
    await book.locator('.name-edit').press('Enter');
    await expect(book.locator('#location')).toHaveText('Scratch');
    await expect(book.locator('#results tr')).toHaveCount(0);
    await book.keyboard.press('Escape');

    // A link is read as it is typed and never reached for: a bad one is named
    // before Connect, and Connect is the only thing that goes anywhere.
    await book.locator('#location').click();
    await book.getByRole('menuitem', { name: 'Connect to a server' }).click();
    await expect(book.locator('#connect-link')).toBeFocused();
    await book.locator('#connect-link').fill('http://127.0.0.1:8712');
    await expect(book.locator('#server-error')).toContainText('no access key');
    await expect(book.locator('#location')).toHaveText('Scratch');
    // The key goes with the dialog rather than lingering in the field.
    await book.getByRole('button', { name: 'Cancel' }).click();
    await book.locator('#location').click();
    await book.getByRole('menuitem', { name: 'Connect to a server' }).click();
    await expect(book.locator('#connect-link')).toHaveValue('');
    await book.keyboard.press('Escape');

    const site = await context.newPage();
    await site.goto('http://127.0.0.1:8719/tests/fixtures/generic.html');
    expect(await site.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime?.sendMessage)).toBe(true);

    // The whole asking round trip, through the real worker: a trusted view asks
    // a tab what it keeps, the answer is held for the book page, and reading it
    // takes it away so the same names cannot arrive twice.
    const tabId = await worker.evaluate(async () =>
      (await chrome.tabs.query({ url: 'http://127.0.0.1:8719/*' }))[0].id);
    // A website that was never turned on is not asked anything at all.
    const refused = await book.evaluate(async id =>
      await chrome.runtime.sendMessage({ type: 'Harvest', tabId: id }), tabId);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/Enable this website/);

    // Turning a website on is a trusted view's call, so it comes from here.
    const turnedOn = await book.evaluate(async id =>
      await chrome.runtime.sendMessage({ type: 'Site', tabId: id, enabled: true }), tabId);
    expect(turnedOn.ok, turnedOn.error).toBe(true);
    await site.reload();
    const asked = await book.evaluate(async id =>
      await chrome.runtime.sendMessage({ type: 'Harvest', tabId: id }), tabId);
    expect(asked.ok).toBe(true);
    // This page's adapter keeps no book of its own, so there is nothing to bring.
    expect(asked.result.count).toBe(0);
    expect((await worker.evaluate(() => chrome.storage.session.get('pendingImport'))).pendingImport).toBeUndefined();

    // A book page that was already open hears about names a website was asked
    // for, rather than only looking once while it was starting up. Opening the
    // tab the popup focuses must not be the difference between a review and a
    // book that sits there saying nothing.
    const third = '0x' + 'ef'.repeat(20);
    await worker.evaluate(async records =>
      chrome.storage.session.set({ pendingImport: { records, origin: 'https://app.safe.global' } }),
      [{ address: third, scope: 'global', tags: ['dudesahn'], source: 'safe:address-book' }]);
    // Waking the worker and opening the book can take a moment; the point is
    // that it arrives without the tab being reopened, not that it is instant.
    await expect(book.locator('#review')).toBeVisible({ timeout: 15000 });
    await expect(book.locator('#review-rows')).toContainText('dudesahn');
    await expect(book.locator('#review-into')).toContainText("Safe's address book");
    // Read once and taken away, so the same names cannot arrive twice.
    expect((await book.evaluate(async () =>
      await chrome.runtime.sendMessage({ type: 'PendingImport' }))).result).toBe(null);

    // A second import arriving while this one is being read waits its turn
    // rather than interrupting, and is not stranded there by waiting: closing
    // the open review is the moment to look again.
    const fourth = '0x' + '12'.repeat(20);
    await worker.evaluate(async records =>
      chrome.storage.session.set({ pendingImport: { records, origin: 'https://app.safe.global' } }),
      [{ address: fourth, scope: 'global', tags: ['wavey'], source: 'safe:address-book' }]);
    await expect(book.locator('#review-rows')).toContainText('dudesahn');
    await expect(book.locator('#review-rows')).not.toContainText('wavey');
    await book.locator('#cancel-import').click();
    await expect(book.locator('#review')).toBeVisible({ timeout: 15000 });
    await expect(book.locator('#review-rows')).toContainText('wavey');
    await book.locator('#cancel-import').click();
    await expect(book.locator('#review')).toBeHidden();

    // Both extension views load and run clean; a typo in either is a trial
    // that fails on its first morning.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#location')).toBeVisible();
    // No website keeping names of its own, so the row is not there at all.
    await expect(popup.locator('#import-site')).toBeHidden();
    await popup.close();

    expect(errors).toEqual([]);
  } finally {
    await context.close(); await rm(profile, { recursive: true, force: true });
  }
});
