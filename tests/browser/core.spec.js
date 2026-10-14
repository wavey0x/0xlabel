import { test, expect } from '@playwright/test';
import { checksumAddress } from '../../extension/checksum.js';
import { address, other, record, start, edit, input, save, shownAddress } from './controller.js';

test('500 addresses retain native text, navigation, selection and copying; disabling removes only our UI', async ({ page }) => {
  const row = `<p><a href="/address/${address}">0xabab…abab</a><button data-copy="${address}">Copy</button></p>`;
  await start(page, { html: `<header>Explorer</header><main>${row.repeat(500)}</main><script>
    document.querySelectorAll('[data-copy]').forEach(button=>{button.onclick=()=>{window.nativeCopied=button.dataset.copy;};});
    document.querySelector('a').onclick=event=>{event.preventDefault();window.nativeClick={href:event.currentTarget.getAttribute('href'),ctrl:event.ctrlKey};};
    </script>` });
  const link = page.locator('main a').first();
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(500);
  await expect(edit(page)).toBeVisible();
  await expect(link).toHaveText('0xabab…abab');
  await link.dispatchEvent('click', { ctrlKey: true });
  expect(await page.evaluate(() => window.nativeClick)).toEqual({ href: '/address/' + address, ctrl: true });
  await page.locator('[data-copy]').first().click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  await link.evaluate(element => { const range=document.createRange();range.selectNodeContents(element);getSelection().removeAllRanges();getSelection().addRange(range); });
  expect(await page.evaluate(() => getSelection().toString())).toBe('0xabab…abab');
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
  await expect(link).toHaveText('0xabab…abab');
  await page.locator('[data-copy]').first().click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
});

test('switching addresses preserves unsaved edits; ranking and Enter save the captured list', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await edit(page, 1).click(); // An untouched editor can be replaced.
  await expect(shownAddress(page)).toHaveText(checksumAddress(other));
  await input(page).fill('Unsaved');
  await edit(page).click();
  await expect(input(page)).toHaveValue('Unsaved');
  await expect(shownAddress(page)).toHaveText(checksumAddress(other));
  await input(page).press('Escape');
  await edit(page).click();
  await page.getByRole('button', { name: 'Move up 2' }).click();
  await input(page).fill('Operations desk');
  await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  await input(page).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'global', labels: ['Operations desk', 'Treasury'], version: 'one' });
});

test('a pending save sends one write and its late completion cannot close a newer draft', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await page.evaluate(() => { window.saveGate = new Promise(resolve => { window.releaseSave = resolve; }); });
  await save(page).click();
  await expect(input(page)).toBeDisabled();
  await page.locator('body > header').click();
  await edit(page, 1).click();
  await input(page).fill('Next draft');
  await page.evaluate(() => window.releaseSave());
  await expect.poll(() => page.evaluate(() => window.saveCompleted)).toBe(true);
  await expect(shownAddress(page)).toHaveText(checksumAddress(other));
  await expect(input(page)).toHaveValue('Next draft');
  expect(await page.evaluate(() => window.saves)).toHaveLength(1);
  expect(await page.evaluate(() => window.saves[0].address)).toBe(address);
});

test('outside dismissal cancels the draft and preserves native focus and copy actions', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('Unsaved');
  await shownAddress(page).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#native-input').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#native-input')).toBeFocused();
  await page.locator('#native-input').fill('Native typing');
  await edit(page).click();
  await expect(input(page)).toHaveValue('Treasury');
  await page.locator('#native-copy').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
});

test('website-script clicks and keypresses cannot submit edits', async ({ page }) => {
  for (const gesture of ['click', 'Enter']) {
    await start(page);
    await edit(page).click();
    await input(page).fill('Scripted edit');
    if (gesture === 'click') await save(page).dispatchEvent('click');
    else await input(page).dispatchEvent('keydown', { key: 'Enter' });
    expect(await page.evaluate(() => window.saves.length)).toBe(0);
    await expect(input(page)).toHaveValue('Scripted edit');
  }
});

test('the address switch reveals all matching addresses without changing the draft or book, and retains the comparison through updates and saves', async ({ page }) => {
  await start(page, { records: [{ ...record, labels: ['Treasury'] }], html: `<header>Explorer</header><main>
    <a id="first" class="hash-tag" href="/address/${address}"><span>Website name</span></a>
    <a id="second" class="hash-tag" href="/address/${address}">Website name</a></main>` });
  await edit(page).click();
  await input(page).fill('Edited tag');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await expect(input(page)).toHaveValue('Edited tag');
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await expect(page.locator('#first')).toHaveText('Website name');
  expect(await page.evaluate(() => window.state.records[0].labels)).toEqual(['Treasury']);
  await page.evaluate(({ address }) => {
    document.querySelector('#first span').textContent = 'Updated website name';
    const row=document.createElement('p');row.innerHTML='<a class="hash-tag" href="/address/'+address+'">Added address</a>';document.querySelector('main').append(row);
    window.state = { ...window.state, stateRevision: 2, records: window.state.records.map(record => ({ ...record, labels: ['Synced tag'] })) };
    window.controller.updateState(window.state);
  }, { address });
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(3);
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await edit(page).click();
  await expect(input(page)).toHaveValue('Edited tag');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await expect(page.locator('[data-0xlabel-label="Edited tag"]')).toHaveCount(3);
  await expect(page.locator('#first')).toHaveText('Updated website name');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await input(page).press('Escape');
  await page.evaluate(() => { window.site = new URL('https://etherscan.io/accounts?p=2'); window.controller.retry(); });
  await expect(page.locator('[data-0xlabel-label="Edited tag"]')).toHaveCount(3);
});

test('Safe resolves loading and composed addresses; the address switch isolates chains and suppresses global fallback after scoped deletion', async ({ page }) => {
  const records = [{ ...record, labels: ['Global'] }, { ...record, scope: 'eip155:1', labels: ['Ethereum'], version: 'network' }];
  const html = `<header><span id="wallet" data-testid="safe-selector-trigger-address"><b>0xabab</b><span>${'ab'.repeat(16)}</span><b>abab</b></span>
    <a data-testid="safe-item-explorer-link" href="https://etherscan.io/address/${address}">Explorer</a></header>
    <main><a id="base" href="https://basescan.org/address/${address}">${address}</a><div id="loading" role="progressbar"></div></main>`;
  await start(page, { html, site: 'https://app.safe.global/home?safe=eth:' + address, records });
  expect(await page.evaluate(() => window.controller.health.status)).toBe('waiting');
  await page.locator('#loading').evaluate(element => element.remove());
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Ethereum');
  await expect(page.locator('#base')).toHaveAttribute('data-0xlabel-label', 'Global');
  await edit(page).click();
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await page.getByRole('button', { name: 'Remove name 1' }).click();
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'eip155:1', labels: [], version: 'network' });
  await expect(page.locator('#wallet')).not.toHaveAttribute('data-0xlabel-label');
  await expect(page.locator('#base')).toHaveAttribute('data-0xlabel-label', 'Global');
  await start(page, { html: html.replace('<div id="loading" role="progressbar"></div>', ''), site: 'https://app.safe.global/home?safe=unknown:' + address, records });
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Global');
});

test('book switches reset comparisons, preserve source-bound drafts and reject older page snapshots', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.controller.updateState({ ...window.state, stateRevision: 3, records: [{ ...window.state.records[0], labels: ['Latest'] }] });
    window.controller.updateState({ ...window.state, stateRevision: 2 });
    const { stateRevision, ...incomplete } = window.state;
    window.controller.updateState({ ...incomplete, records: [] });
  });
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Latest');
  await edit(page).click();
  await input(page).fill('Local draft');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await page.evaluate(() => window.controller.updateState({ ...window.state, connectionKey: 'https://remote.example', connectionName: 'Remote', selectionGeneration: 2, records: [{ ...window.state.records[0], labels: ['Remote'] }] }));
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await expect(save(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('Local draft');
  await expect(page.locator('.visibility')).toBeDisabled();
  await page.locator('.visibility').dispatchEvent('click');
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await page.evaluate(() => window.controller.updateState(window.state));
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await page.evaluate(() => window.controller.updateState({ ...window.state, selectionGeneration: 3 }));
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(save(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('Local draft');
});

test('recycled rows cannot redirect an open draft or its visibility control to another address', async ({ page }) => {
  await start(page, { records: [record, { ...record, address: other, labels: ['Other wallet'] }] });
  await edit(page).click();
  await input(page).fill('Captured original');
  const link = page.locator('#first');
  await link.evaluate((element, other) => { element.href='/address/'+other; element.textContent=other; }, other);
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  await expect(page.locator('.visibility')).toBeDisabled();
  await page.locator('.visibility').dispatchEvent('click');
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  await save(page).click();
  expect(await page.evaluate(() => window.saves[0].address)).toBe(address);
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Other wallet');
});

test('an inconsistent integration clears annotations but preserves its draft; retry only resumes with valid landmarks', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('Still safe');
  await page.locator('body > header').evaluate(element => element.remove());
  await expect.poll(() => page.evaluate(() => window.controller.health.status)).toBe('stale');
  await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label]')).toHaveCount(0);
  await expect(input(page)).toHaveValue('Still safe');
  await expect(page.locator('.visibility')).toBeDisabled();
  await save(page).click();
  expect(await page.evaluate(() => window.saves[0].labels[0])).toBe('Still safe');
  await page.evaluate(() => window.controller.retry());
  expect(await page.evaluate(() => window.controller.health.status)).toBe('stale');
  await page.evaluate(() => { document.body.prepend(document.createElement('header')); window.controller.retry(); });
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Still safe');
});

test('failed and conflicting saves retain the draft; replacing a newer record requires explicit review', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('My edit');
  await page.evaluate(() => { window.saveError='Offline'; });
  await save(page).click();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('My edit');
  await page.evaluate(({ record }) => { window.saveError='Conflict'; window.conflict={ ...record, labels:['Newer name'], version:'newer' }; }, { record });
  await save(page).click();
  await expect(input(page)).toHaveValue('My edit');
  await page.getByRole('button', { name: 'Keep my labels' }).click();
  await page.evaluate(() => { window.saveError=null; });
  await save(page).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ address, labels: ['My edit', 'Operations'], version: 'newer' });
});

test('explorer identities come from complete sources, including search suggestions, named fee recipients and transaction-table spans', async ({ page }) => {
  await start(page, { site: 'https://etherscan.io/', html: `<header>Explorer
    <div class="search-panel-container"><ul><li role="option" data-address="${address}">
      <span style="display:none">${address}</span>
      <a id="recent" class="nav-link" href="/address/${address}" style="display:block;width:100%"><h6 style="display:flex;margin:0"><i></i><div class="text-truncate">${address}</div></h6></a>
    </li><li role="option" data-address="${address}">
      <span style="display:none">${address}</span>
      <a id="recent-name" class="nav-link" href="/address/name.eth"><h6><i></i><div class="text-truncate">name.eth</div></h6></a>
    </li><li role="option" data-address="${other}">
      <span style="display:none">${other}</span>
      <a id="recent-tag" class="nav-link" href="/address/${other}"><h6><i></i><div class="text-truncate">Website organization</div></h6></a>
    </li><li role="option">
      <span style="display:none">${address}</span>
      <a id="suggested-name" class="nav-link" href="/address/name.eth"><div><h6>name.eth</h6><span>${address}</span></div></a>
    </li><li role="option" data-address="name.eth">
      <a id="unresolved-search" href="/name-lookup-search?id=name.eth">name.eth</a>
    </li><li role="option">
      <a id="search-page" href="/api">Etherscan API</a>
    </li></ul></div></header><main>
    <a href="/address/${address}"><span id="ens" class="hash-tag">name.eth</span></a>
    <a id="fragment" href="/address/${address}">0xabab…abab</a>
    <a id="fee" data-highlight-value href="/address/${address}"><span title="${address}">Titan Builder</span></a>
    <span id="table" class="hash-tag" data-full-address="${address}">Preset name</span>
    <span id="unknown" class="hash-tag">0xabab…abab</span>
    <a id="unresolved" class="hash-tag" href="/address/name.eth">name.eth</a>
    <nav><a class="hash-tag" href="/address/${address}">View address</a></nav>
    </main><script>
    document.querySelectorAll('.search-panel-container a').forEach(link=>{
      link.onmousedown=event=>{event.preventDefault();window.nativeSearchSelection=event.currentTarget.getAttribute('href');};
      link.onclick=event=>event.preventDefault();
    });
    </script>` });
  for (const id of ['recent','recent-name','suggested-name','ens','fragment','fee','table']) await expect(page.locator('#'+id)).toHaveAttribute('data-0xlabel-address', address);
  await expect(page.locator('#recent-tag')).toHaveAttribute('data-0xlabel-address', other);
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(8);
  await page.locator('#recent + [data-0xlabel-edit]').getByRole('button').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBeUndefined();
  await input(page).press('Escape');
  await page.locator('#recent').click();
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBe('/address/' + address);
  await expect(page.locator('#recent')).toHaveText(address);
  for (const [id, identity, text, href] of [['recent-name', address, 'name.eth', '/address/name.eth'], ['recent-tag', other, 'Website organization', '/address/' + other]]) {
    await page.evaluate(() => { delete window.nativeSearchSelection; });
    await page.locator('#'+id+' + [data-0xlabel-edit]').getByRole('button').click();
    await expect(shownAddress(page)).toHaveText(checksumAddress(identity));
    expect(await page.evaluate(() => window.nativeSearchSelection)).toBeUndefined();
    await input(page).press('Escape');
    await page.locator('#'+id).click();
    expect(await page.evaluate(() => window.nativeSearchSelection)).toBe(href);
    await expect(page.locator('#'+id)).toHaveText(text);
  }
  await page.locator('#suggested-name').evaluate(element => { element.querySelector('h6').textContent = 'Updated website name'; });
  await expect(page.locator('#suggested-name')).toHaveAttribute('data-0xlabel-address', address);
  await page.locator('#fee span').evaluate(element => { element.dataset.bsOriginalTitle=element.title; element.removeAttribute('title'); });
  await page.locator('#fee + [data-0xlabel-edit]').getByRole('button').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await input(page).press('Escape');
  await page.locator('#table + [data-0xlabel-edit]').getByRole('button').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await expect(page.locator('#table')).toHaveText('Preset name');
});

test('contradictory address evidence disqualifies only that element; generic detection skips fragments and editable or interactive content', async ({ page }) => {
  const sound = `<a id="sound" href="/address/${address}">${address}</a>`;
  for (const conflict of [
    `<a id="conflict" href="/address/${other}" data-full-address="${address}">${address}</a>`,
    `<div class="search-panel-container"><li role="option"><span>${other}</span><a id="conflict" href="/address/name.eth"><h6>name.eth</h6><span>${address}</span></a></li></div>`,
  ]) {
    // One element's disagreement must never cost the rest of the page its tags.
    await start(page, { html: `<header></header><main>${conflict}${sound}</main>` });
    expect(await page.evaluate(() => window.controller.health.status)).toBe('ready');
    await expect(page.locator('#conflict')).not.toHaveAttribute('data-0xlabel-address');
    await expect(page.locator('#sound')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  }
  await start(page, { site: 'https://plain.example', html: `<main><p id="wallet">${address}</p><p>0xabab…abab</p>
    <button>${address}</button><input value="${address}"><div contenteditable="true">${address}</div></main>` });
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(1);
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xlabel-label', 'Treasury');
});
