import { test, expect } from '@playwright/test';
import { checksumAddress } from '../../extension/checksum.js';
import { address, other, record, start, edit, input, save, shownAddress, contrast, tagFor, wallets } from './controller.js';

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

test('switching address books resets comparisons, preserve source-bound drafts and reject older page snapshots', async ({ page }) => {
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
  await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 4, activeBook: 'book-2', bookName: 'Team',
      books: [...window.state.books, { id: 'book-2', name: 'Team', where: 'remote.example' }],
      records: [{ ...window.state.records[0], labels: ['Remote'] }] }));
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await expect(save(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('Local draft');
  await expect(page.locator('.visibility')).toBeDisabled();
  await page.locator('.visibility').dispatchEvent('click');
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await page.evaluate(() => window.controller.updateState(window.state));
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Remote');
  await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 5 }));
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

test('failed and conflicting saves retain the draft; a refusal offers both answers in one click', async ({ page }) => {
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
  // What the book now says, with both answers to it one click away.
  await expect(page.locator('.conflict')).toContainText('Newer name');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ address, labels: ['My edit', 'Operations'], version: 'newer' });
  await page.getByRole('button', { name: 'Use these' }).click();
  await expect(input(page)).toHaveValue('Newer name');
  await expect(page.locator('.conflict')).toBeHidden();
  await page.evaluate(() => { window.saveError=null; });
  await save(page).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ address, labels: ['Newer name'], version: 'newer' });
});

test('a stray space is not an edit, and a link that names nothing opens nothing', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await expect(input(page)).toHaveValue('Treasury');
  // The same name with a space on the end is the same name: a save would store
  // it that way, so nothing here is a draft worth defending.
  await input(page).fill('  Treasury  ');
  await edit(page, 1).click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(other));
  await expect(page.locator('.notice')).toHaveText('');

  // A context menu hands over whatever the page put in the link.
  await input(page).press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.controller.openEditor({ link: 'not a url' }));
  await page.evaluate(() => window.controller.openEditor({ link: 'https://example.com/not/an/address' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(address => window.controller.openEditor({ link: `https://etherscan.io/address/${address}` }), other);
  await expect(shownAddress(page)).toHaveText(checksumAddress(other));
});

test('a draft nobody has touched follows the book; one with typing in it is never overwritten', async ({ page }) => {
  await start(page);
  const elsewhere = labels => page.evaluate(({ address, labels }) => window.controller.updateState({
    ...window.state, stateRevision: window.state.stateRevision + 5,
    records: [{ address, scope: 'global', labels, version: 'from-elsewhere-' + labels.join('-') }],
  }), { address, labels });

  await edit(page).click();
  await expect(input(page)).toHaveValue('Treasury');
  await elsewhere(['Saved in another tab']);
  await expect(input(page)).toHaveValue('Saved in another tab');
  await expect(page.locator('#first')).toHaveAttribute('data-0xlabel-label', 'Saved in another tab');
  // Saving the followed draft carries that record's version, so a book written
  // elsewhere is not asked to resolve a conflict that no longer exists.
  await save(page).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ labels: ['Saved in another tab'], version: 'from-elsewhere-Saved in another tab' });
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await edit(page).click();
  await input(page).fill('Still mine');
  await elsewhere(['Saved again elsewhere']);
  await expect(input(page)).toHaveValue('Still mine');
});

test('editing a search suggestion survives native blur dismissal without selecting the result', async ({ page }) => {
  await start(page, { site: 'https://etherscan.io/', html: `<header>Explorer
    <div class="search-panel-container"><input id="search" aria-label="Search explorer">
    <ul id="suggestions" hidden><li role="option"><span hidden>${address}</span>
      <a id="suggestion" href="/address/${address}">Website name</a>
    </li></ul></div></header><main><button id="outside">Outside</button></main><script>
    const search=document.querySelector('#search'), suggestions=document.querySelector('#suggestions');
    search.onfocus=()=>{suggestions.hidden=false;};
    // Etherscan closes empty-search suggestions after the search input blurs.
    search.onblur=()=>{setTimeout(()=>{suggestions.hidden=true;});};
    document.querySelector('#suggestion').onmousedown=event=>{
      event.preventDefault();window.nativeSearchSelection=event.currentTarget.getAttribute('href');
    };
    document.querySelector('#suggestion').onclick=event=>event.preventDefault();
    </script>` });
  const search = page.getByRole('textbox', { name: 'Search explorer' });
  await search.click();
  const button = tagFor(page, 'suggestion');
  await button.hover();
  await page.mouse.down();
  await expect(search).toBeFocused();
  await expect(page.locator('#suggestions')).toBeVisible();
  await page.mouse.up();
  await expect(input(page)).toBeFocused();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await expect(page.locator('#suggestions')).toBeHidden();
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBeUndefined();
  await input(page).fill('Search tag');
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, labels: ['Search tag', 'Operations'] });
  await search.click();
  await page.locator('#suggestion').click();
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBe('/address/' + address);
  await search.click();
  await button.click();
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves)).toHaveLength(1);
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
  await tagFor(page, 'recent').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBeUndefined();
  await input(page).press('Escape');
  await page.locator('#recent').click();
  expect(await page.evaluate(() => window.nativeSearchSelection)).toBe('/address/' + address);
  await expect(page.locator('#recent')).toHaveText(address);
  for (const [id, identity, text, href] of [['recent-name', address, 'name.eth', '/address/name.eth'], ['recent-tag', other, 'Website organization', '/address/' + other]]) {
    await page.evaluate(() => { delete window.nativeSearchSelection; });
    await tagFor(page, id).click();
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
  await tagFor(page, 'fee').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await input(page).press('Escape');
  await tagFor(page, 'table').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await expect(page.locator('#table')).toHaveText('Preset name');
});

test("an address page keeps its own address beside the name it is given", async ({ page }) => {
  await start(page, { site: `https://etherscan.io/address/${address}`, html: `<header>Explorer</header><main>
    <h1>Contract <span id="mainaddress" data-highlight-target="${address}">${address}</span></h1>
    <p>Seen again in <a id="elsewhere" href="/address/${address}">${address}</a></p></main>` });
  await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xlabel-short', '0xABaB…ABaB');
  expect(await page.locator('#mainaddress').evaluate(element => getComputedStyle(element, '::after').content))
    .toContain('0xABaB…ABaB');
  // Everywhere else on the page the name stands on its own.
  await expect(page.locator('#elsewhere')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(page.locator('#elsewhere')).not.toHaveAttribute('data-0xlabel-short', /./);
  // Nothing of ours outlives the name it belonged to.
  await page.evaluate(() => window.controller.updateState({ ...window.state, records: [], stateRevision: 9 }));
  await expect(page.locator('#mainaddress')).not.toHaveAttribute('data-0xlabel-short', /./);
  await expect(page.locator('#mainaddress')).toHaveText(address);
});

test('a menu of owners is content: rows keep the explorer\'s own name and still take a glyph', async ({ page }) => {
  await start(page, { site: 'https://etherscan.io/', records: [record,
    { address: other, scope: 'global', labels: ['Second owner'], version: 'two' }],
    html: `<style>.dropdown-menu{display:flex;flex-direction:column}.dropdown-item{display:block;width:100%}</style>
    <header>Explorer</header><main><div class="dropdown-menu">
      <a id="named-owner" class="dropdown-item" href="/address/${address}"><span class="hash-tag">Explorer name tag</span></a>
      <a id="plain-owner" class="dropdown-item" href="/address/${other}">0xcdcd…cdcd</a>
    </div><nav><a id="nav-card" class="hash-tag" href="/address/${address}">View address</a></nav></main>` });
  // The explorer's own name stands; knowing whose wallet it is adds the glyph.
  await expect(page.locator('#named-owner .hash-tag')).toHaveText('Explorer name tag');
  await expect(page.locator('#named-owner .hash-tag')).toHaveAttribute('data-0xlabel-address', address);
  await expect(page.locator('#named-owner [data-0xlabel-label]')).toHaveCount(0);
  // A row showing the address itself is named like anywhere else on the site.
  await expect(page.locator('#plain-owner')).toHaveAttribute('data-0xlabel-label', 'Second owner');
  // Neither glyph is pushed onto a line of its own: a row that would do that
  // carries it inside the display instead of after it.
  await expect(page.locator('#named-owner > [data-0xlabel-edit]')).toHaveCount(1);
  await expect(page.locator('#plain-owner > [data-0xlabel-edit]')).toHaveCount(1);
  await expect(page.locator('.dropdown-menu > [data-0xlabel-edit]')).toHaveCount(0);
  // Site navigation is left alone entirely, name and glyph both.
  await expect(page.locator('#nav-card')).not.toHaveAttribute('data-0xlabel-address', /./);
  await expect(page.locator('#nav-card [data-0xlabel-edit]')).toHaveCount(0);
  await tagFor(page, 'named-owner').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
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

// Every theming defect this project has had was invisible to the suite: the
// labels were present and correct, and unreadable. Legibility is the contract.
const legible = async (page, surface) => {
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-0xlabel-surface'))).toBe(surface);
  const behind = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const label = await page.locator('#first').evaluate(element => getComputedStyle(element, '::before').color);
  const tag = await edit(page).evaluate(element => getComputedStyle(element).color);
  expect(contrast(label, behind), `${surface}: label on the page`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tag, behind), `${surface}: tag button on the page`).toBeGreaterThanOrEqual(4.5);
  await edit(page).click();
  const primary = await save(page).evaluate(element => {
    const style = getComputedStyle(element);
    return { ink: style.color, fill: style.backgroundColor };
  });
  expect(contrast(primary.ink, primary.fill), `${surface}: Save label on its own fill`).toBeGreaterThanOrEqual(4.5);
  await input(page).press('Escape');
};

test('labels, tag buttons and editor controls stay legible on light and dark websites', async ({ page }) => {
  // A website already on its surface when labeling starts.
  for (const [surface, colour] of [['light', '#ffffff'], ['dark', '#101113']]) {
    await start(page, { html: `<style>body{background:${colour}}</style>${wallets}` });
    await legible(page, surface);
  }
  // And a website that changes surface under labels already on the page.
  await start(page, { html: `<style>body{background:#ffffff}</style>${wallets}` });
  await legible(page, 'light');
  await page.evaluate(() => { document.body.style.background = '#101113'; });
  await legible(page, 'dark');
  // The address kept beside the name on a page's own subject is ours to read too.
  for (const colour of ['#ffffff', '#101113']) {
    await start(page, { site: `https://etherscan.io/address/${address}`,
      html: `<style>body{background:${colour}}</style><header>Explorer</header>
        <main><h1><span id="mainaddress" data-highlight-target="${address}">${address}</span></h1></main>` });
    await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xlabel-short', /./);
    const [trailer, behind] = await page.locator('#mainaddress').evaluate(element =>
      [getComputedStyle(element, '::after').color, getComputedStyle(document.body).backgroundColor]);
    expect(contrast(trailer, behind), `${colour}: the address beside the name`).toBeGreaterThanOrEqual(4.5);
  }
});

test('a website surface is read from what the browser actually paints', async ({ page }) => {
  const shapes = [
    ['a background painted on the document element', '<style>html{background:#101113}</style>', 'dark'],
    ['supporting both schemes is not the same as being dark', '<style>:root{color-scheme:light dark}html{background:#ffffff}</style>', 'light'],
    ['a translucent dark body over a light document', '<style>html{background:#ffffff}body{background:rgba(0,0,0,.9)}</style>', 'dark'],
  ];
  for (const [shape, style, expected] of shapes) {
    await start(page, { html: style + wallets });
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-0xlabel-surface')),
      { message: shape }).toBe(expected);
  }
});
