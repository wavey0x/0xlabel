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
  await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(500);
  await expect(edit(page)).toBeVisible();
  await expect(link).toHaveText('0xabab…abab');
  await link.dispatchEvent('click', { ctrlKey: true });
  expect(await page.evaluate(() => window.nativeClick)).toEqual({ href: '/address/' + address, ctrl: true });
  await page.locator('[data-copy]').first().click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  await link.evaluate(element => { const range=document.createRange();range.selectNodeContents(element);getSelection().removeAllRanges();getSelection().addRange(range); });
  expect(await page.evaluate(() => getSelection().toString())).toBe('0xabab…abab');
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
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
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'global', tags: ['Operations desk', 'Treasury'], version: 'one' });
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
  await start(page, { records: [{ ...record, tags: ['Treasury'] }], html: `<header>Explorer</header><main>
    <a id="first" class="hash-tag" href="/address/${address}"><span>Website name</span></a>
    <a id="second" class="hash-tag" href="/address/${address}">Website name</a></main>` });
  await edit(page).click();
  await input(page).fill('Edited tag');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await expect(input(page)).toHaveValue('Edited tag');
  await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(0);
  await expect(page.locator('#first')).toHaveText('Website name');
  expect(await page.evaluate(() => window.state.records[0].tags)).toEqual(['Treasury']);
  await page.evaluate(({ address }) => {
    document.querySelector('#first span').textContent = 'Updated website name';
    const row=document.createElement('p');row.innerHTML='<a class="hash-tag" href="/address/'+address+'">Added address</a>';document.querySelector('main').append(row);
    window.state = { ...window.state, stateRevision: 2, records: window.state.records.map(record => ({ ...record, tags: ['Synced tag'] })) };
    window.controller.updateState(window.state);
  }, { address });
  await expect(page.locator('[data-0xtagger-address]')).toHaveCount(3);
  await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(0);
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(0);
  await edit(page).click();
  await expect(input(page)).toHaveValue('Edited tag');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await expect(page.locator('[data-0xtagger-tag="Edited tag"]')).toHaveCount(3);
  await expect(page.locator('#first')).toHaveText('Updated website name');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await input(page).press('Escape');
  await page.evaluate(() => { window.site = new URL('https://etherscan.io/accounts?p=2'); window.controller.retry(); });
  await expect(page.locator('[data-0xtagger-tag="Edited tag"]')).toHaveCount(3);
});

test('Safe resolves loading and composed addresses; the address switch isolates chains and suppresses global fallback after scoped deletion', async ({ page }) => {
  const records = [{ ...record, tags: ['Global'] }, { ...record, scope: 'eip155:1', tags: ['Ethereum'], version: 'network' }];
  const html = `<header><span id="wallet" data-testid="safe-selector-trigger-address"><b>0xabab</b><span>${'ab'.repeat(16)}</span><b>abab</b></span>
    <a data-testid="safe-item-explorer-link" href="https://etherscan.io/address/${address}">Explorer</a></header>
    <main><a id="base" href="https://basescan.org/address/${address}">${address}</a><div id="loading" role="progressbar"></div></main>`;
  await start(page, { html, site: 'https://app.safe.global/home?safe=eth:' + address, records });
  expect(await page.evaluate(() => window.controller.health.status)).toBe('waiting');
  await page.locator('#loading').evaluate(element => element.remove());
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Ethereum');
  await expect(page.locator('#base')).toHaveAttribute('data-0xtagger-tag', 'Global');
  await edit(page).click();
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await page.getByRole('button', { name: 'Remove tag 1' }).click();
  await save(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'eip155:1', tags: [], version: 'network' });
  await expect(page.locator('#wallet')).not.toHaveAttribute('data-0xtagger-tag');
  await expect(page.locator('#base')).toHaveAttribute('data-0xtagger-tag', 'Global');
  await start(page, { html: html.replace('<div id="loading" role="progressbar"></div>', ''), site: 'https://app.safe.global/home?safe=unknown:' + address, records });
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Global');
});

test('switching address books resets comparisons, preserve source-bound drafts and reject older page snapshots', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.controller.updateState({ ...window.state, stateRevision: 3, records: [{ ...window.state.records[0], tags: ['Latest'] }] });
    window.controller.updateState({ ...window.state, stateRevision: 2 });
    const { stateRevision, ...incomplete } = window.state;
    window.controller.updateState({ ...incomplete, records: [] });
  });
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Latest');
  await edit(page).click();
  await input(page).fill('Local draft');
  await page.getByRole('switch', { name: 'Show my tags for this address' }).click();
  await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 4, activeBook: 'book-2', bookName: 'Team',
      books: [...window.state.books, { id: 'book-2', name: 'Team', where: 'remote.example' }],
      records: [{ ...window.state.records[0], tags: ['Remote'] }] }));
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Remote');
  await expect(save(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('Local draft');
  await expect(page.locator('.visibility')).toBeDisabled();
  await page.locator('.visibility').dispatchEvent('click');
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Remote');
  await page.evaluate(() => window.controller.updateState(window.state));
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Remote');
  await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 5 }));
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  await expect(save(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('Local draft');
});

test('recycled rows cannot redirect an open draft or its visibility control to another address', async ({ page }) => {
  await start(page, { records: [record, { ...record, address: other, tags: ['Other wallet'] }] });
  await edit(page).click();
  await input(page).fill('Captured original');
  const link = page.locator('#first');
  await link.evaluate((element, other) => { element.href='/address/'+other; element.textContent=other; }, other);
  await expect(link).toHaveAttribute('data-0xtagger-tag', 'Other wallet');
  await expect(page.locator('.visibility')).toBeDisabled();
  await page.locator('.visibility').dispatchEvent('click');
  await expect(link).toHaveAttribute('data-0xtagger-tag', 'Other wallet');
  await save(page).click();
  expect(await page.evaluate(() => window.saves[0].address)).toBe(address);
  await expect(link).toHaveAttribute('data-0xtagger-tag', 'Other wallet');
});

test('an inconsistent integration clears annotations but preserves its draft; retry only resumes with valid landmarks', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('Still safe');
  await page.locator('body > header').evaluate(element => element.remove());
  await expect.poll(() => page.evaluate(() => window.controller.health.status)).toBe('stale');
  await expect(page.locator('[data-0xtagger-address],[data-0xtagger-tag]')).toHaveCount(0);
  await expect(input(page)).toHaveValue('Still safe');
  await expect(page.locator('.visibility')).toBeDisabled();
  await save(page).click();
  expect(await page.evaluate(() => window.saves[0].tags[0])).toBe('Still safe');
  await page.evaluate(() => window.controller.retry());
  expect(await page.evaluate(() => window.controller.health.status)).toBe('stale');
  await page.evaluate(() => { document.body.prepend(document.createElement('header')); window.controller.retry(); });
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Still safe');
});

test('failed and conflicting saves retain the draft; a refusal offers both answers in one click', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('My edit');
  // A failure that only writes a line of small print is easy to miss, so the
  // button it was pressed on wears the refusal for a moment. Recorded as it is
  // asked for, because it is over long before an assertion could look for it.
  await page.evaluate(() => {
    window.refusals = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const running = animate.call(this, frames, options);
      if (JSON.stringify(frames).includes('warning-pulse')) window.refusals.push(this.className);
      return running;
    };
  });
  await page.evaluate(() => { window.saveError='Offline'; });
  await save(page).click();
  await expect(input(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('My edit');
  await expect.poll(() => page.evaluate(() => window.refusals)).toEqual(['primary save']);
  await page.evaluate(({ record }) => { window.saveError='Conflict'; window.conflict={ ...record, tags:['Newer name'], version:'newer' }; }, { record });
  await save(page).click();
  await expect(input(page)).toHaveValue('My edit');
  // A book answering with something else shows its own panel, which says it
  // plainly enough without the button saying it too.
  await expect(page.locator('.conflict')).toBeVisible();
  expect(await page.evaluate(() => window.refusals)).toEqual(['primary save']);
  // What the book now says, with both answers to it one click away.
  await expect(page.locator('.conflict')).toContainText('Newer name');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ address, tags: ['My edit', 'Operations'], version: 'newer' });
  await page.getByRole('button', { name: 'Use these' }).click();
  await expect(input(page)).toHaveValue('Newer name');
  await expect(page.locator('.conflict')).toBeHidden();
  await page.evaluate(() => { window.saveError=null; });
  await save(page).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ address, tags: ['Newer name'], version: 'newer' });
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
  const elsewhere = tags => page.evaluate(({ address, tags }) => window.controller.updateState({
    ...window.state, stateRevision: window.state.stateRevision + 5,
    records: [{ address, scope: 'global', tags, version: 'from-elsewhere-' + tags.join('-') }],
  }), { address, tags });

  await edit(page).click();
  await expect(input(page)).toHaveValue('Treasury');
  await elsewhere(['Saved in another tab']);
  await expect(input(page)).toHaveValue('Saved in another tab');
  await expect(page.locator('#first')).toHaveAttribute('data-0xtagger-tag', 'Saved in another tab');
  // Saving the followed draft carries that record's version, so a book written
  // elsewhere is not asked to resolve a conflict that no longer exists.
  await save(page).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ tags: ['Saved in another tab'], version: 'from-elsewhere-Saved in another tab' });
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
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, tags: ['Search tag', 'Operations'] });
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
  for (const id of ['recent','recent-name','suggested-name','ens','fragment','fee','table']) await expect(page.locator('#'+id)).toHaveAttribute('data-0xtagger-address', address);
  await expect(page.locator('#recent-tag')).toHaveAttribute('data-0xtagger-address', other);
  await expect(page.locator('[data-0xtagger-address]')).toHaveCount(8);
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
  await expect(page.locator('#suggested-name')).toHaveAttribute('data-0xtagger-address', address);
  await page.locator('#fee span').evaluate(element => { element.dataset.bsOriginalTitle=element.title; element.removeAttribute('title'); });
  await tagFor(page, 'fee').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await input(page).press('Escape');
  await tagFor(page, 'table').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
  await expect(page.locator('#table')).toHaveText('Preset name');
});

// Who first funded an address is a wallet like any other. Where the explorer
// has a name for them it prints the name by itself, without the markers its
// tables carry, so the link naming the address whole is the only evidence the
// row gives — and it is enough, the same as it is for a fee recipient.
test('a funder the explorer has a name for is still a wallet to tag', async ({ page }) => {
  // Both shapes the row takes: a name on its own, and a shortened address.
  const subject = '0x' + '11'.repeat(20);
  await start(page, { site: `https://etherscan.io/address/${subject}`, records: [record],
    html: `<header>Explorer</header><main>
      <h1><span id="mainaddress" data-highlight-target="${subject}">${subject}</span></h1>
      <h4>Funded By</h4>
      <div id="conFundedMainChain"><a id="funder" class="d-flex" href="/address/${address}">
        <span class="d-block text-truncate" data-bs-toggle="tooltip"
          style="display:block;max-width:9.3rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >Michael Egorov 2</span></a>
        <a id="funder-bare" class="d-flex" href="/address/${other}">
        <span><span class="hash-tag text-truncate">${other.slice(0, 10)}…${other.slice(-8)}</span></span></a></div>
    </main>` });
  // The explorer's own name gives way to the one that was saved for it.
  await expect(page.locator('#funder')).toHaveAttribute('data-0xtagger-address', address);
  await expect(page.locator('#funder span.d-block')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  // A shortened address names the wallet by itself, and the explorer marks it,
  // so that half of the row was always read; it is the named half that was not.
  await expect(page.locator('#funder-bare .hash-tag')).toHaveAttribute('data-0xtagger-address', other);
  // Our button is never left inside the link: one thing that answers a press
  // inside another is a shape no page should be given, and a press meant for
  // the glyph would be a press on the link.
  await expect(page.locator('#funder [data-0xtagger-edit]')).toHaveCount(0);
  await expect(page.locator('#funder + [data-0xtagger-edit]')).toHaveCount(1);
  // And it opens on the wallet the row is about, not on the page's own.
  await tagFor(page, 'funder').click();
  await expect(shownAddress(page)).toHaveText(checksumAddress(address));
});

// An explorer sets an icon of its own beside the name in a row. Standing in
// for the whole row would hide that icon along with the name it replaces, so
// the name is painted on the text and the icon is left as the site drew it.
test('a name beside a site\'s own icon leaves the icon alone', async ({ page }) => {
  const subject = '0x' + '22'.repeat(20);
  await start(page, { site: `https://etherscan.io/address/${subject}`, records: [record],
    html: `<header>Explorer</header><main>
      <h1><span id="mainaddress" data-highlight-target="${subject}">${subject}</span></h1>
      <table><tbody><tr><td><div style="display:flex;align-items:center;gap:4px">
        <a id="cell" class="hash-tag" href="/address/${address}"
          style="display:block;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          ><i id="icon" style="display:inline-block;width:14px;height:12px"></i><span
          id="name" class="ms-1">Curve: CRV Token</span></a></div></td></tr></tbody></table>
    </main>` });
  await expect(page.locator('#name')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  // The row is still the site's: its icon keeps the type it was drawn in.
  expect(await page.locator('#icon').evaluate(element =>
    getComputedStyle(element).fontSize)).not.toBe('0px');
  await expect(page.locator('#cell [data-0xtagger-edit]')).toHaveCount(0);
});

test("an address page keeps its own address beside the name it is given", async ({ page }) => {
  await start(page, { site: `https://etherscan.io/address/${address}`, html: `<header>Explorer</header><main>
    <h1>Contract <span id="mainaddress" data-highlight-target="${address}">${address}</span></h1>
    <p>Seen again in <a id="elsewhere" href="/address/${address}">${address}</a></p></main>` });
  await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xtagger-short', '0xABaB…ABaB');
  expect(await page.locator('#mainaddress').evaluate(element => getComputedStyle(element, '::after').content))
    .toContain('0xABaB…ABaB');
  // Everywhere else on the page the name stands on its own.
  await expect(page.locator('#elsewhere')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  await expect(page.locator('#elsewhere')).not.toHaveAttribute('data-0xtagger-short', /./);
  // Nothing of ours outlives the name it belonged to.
  await page.evaluate(() => window.controller.updateState({ ...window.state, records: [], stateRevision: 9 }));
  await expect(page.locator('#mainaddress')).not.toHaveAttribute('data-0xtagger-short', /./);
  await expect(page.locator('#mainaddress')).toHaveText(address);
});

test('a menu of owners is content: rows keep the explorer\'s own name and still take a glyph', async ({ page }) => {
  await start(page, { site: 'https://etherscan.io/', records: [record,
    { address: other, scope: 'global', tags: ['Second owner'], version: 'two' }],
    html: `<style>.dropdown-menu{display:flex;flex-direction:column}.dropdown-item{display:block;width:100%}</style>
    <header>Explorer</header><main><div class="dropdown-menu">
      <a id="named-owner" class="dropdown-item" href="/address/${address}"><span class="hash-tag">Explorer name tag</span></a>
      <a id="plain-owner" class="dropdown-item" href="/address/${other}">0xcdcd…cdcd</a>
    </div><nav><a id="nav-card" class="hash-tag" href="/address/${address}">View address</a></nav></main>` });
  // The explorer's own name stands; knowing whose wallet it is adds the glyph.
  await expect(page.locator('#named-owner .hash-tag')).toHaveText('Explorer name tag');
  await expect(page.locator('#named-owner .hash-tag')).toHaveAttribute('data-0xtagger-address', address);
  await expect(page.locator('#named-owner [data-0xtagger-tag]')).toHaveCount(0);
  // A row showing the address itself is named like anywhere else on the site.
  await expect(page.locator('#plain-owner')).toHaveAttribute('data-0xtagger-tag', 'Second owner');
  // Neither glyph is pushed onto a line of its own: a row that would do that
  // carries it inside the display instead of after it.
  await expect(page.locator('#named-owner > [data-0xtagger-edit]')).toHaveCount(1);
  await expect(page.locator('#plain-owner > [data-0xtagger-edit]')).toHaveCount(1);
  await expect(page.locator('.dropdown-menu > [data-0xtagger-edit]')).toHaveCount(0);
  // Site navigation is left alone entirely, name and glyph both.
  await expect(page.locator('#nav-card')).not.toHaveAttribute('data-0xtagger-address', /./);
  await expect(page.locator('#nav-card [data-0xtagger-edit]')).toHaveCount(0);
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
    await expect(page.locator('#conflict')).not.toHaveAttribute('data-0xtagger-address');
    await expect(page.locator('#sound')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  }
  await start(page, { site: 'https://plain.example', html: `<main><p id="wallet">${address}</p><p>0xabab…abab</p>
    <button>${address}</button><input value="${address}"><div contenteditable="true">${address}</div></main>` });
  await expect(page.locator('[data-0xtagger-address]')).toHaveCount(1);
  await expect(page.locator('#wallet')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
});

// Every theming defect this project has had was invisible to the suite: the
// tags were present and correct, and unreadable. Legibility is the contract.
const legible = async (page, surface) => {
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-0xtagger-surface'))).toBe(surface);
  const behind = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const painted = await page.locator('#first').evaluate(element => getComputedStyle(element, '::before').color);
  const glyph = await edit(page).evaluate(element => getComputedStyle(element).color);
  expect(contrast(painted, behind), `${surface}: tag on the page`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(glyph, behind), `${surface}: tag button on the page`).toBeGreaterThanOrEqual(4.5);
  await edit(page).click();
  const primary = await save(page).evaluate(element => {
    const style = getComputedStyle(element);
    return { ink: style.color, fill: style.backgroundColor };
  });
  expect(contrast(primary.ink, primary.fill), `${surface}: Save tag on its own fill`).toBeGreaterThanOrEqual(4.5);
  await input(page).press('Escape');
};

test('tags, tag buttons and editor controls stay legible on light and dark websites', async ({ page }) => {
  // A website already on its surface when tagging starts.
  for (const [surface, colour] of [['light', '#ffffff'], ['dark', '#101113']]) {
    await start(page, { html: `<style>body{background:${colour}}</style>${wallets}` });
    await legible(page, surface);
  }
  // And a website that changes surface under tags already on the page.
  await start(page, { html: `<style>body{background:#ffffff}</style>${wallets}` });
  await legible(page, 'light');
  await page.evaluate(() => { document.body.style.background = '#101113'; });
  await legible(page, 'dark');
  // The address kept beside the name on a page's own subject is ours to read too.
  for (const colour of ['#ffffff', '#101113']) {
    await start(page, { site: `https://etherscan.io/address/${address}`,
      html: `<style>body{background:${colour}}</style><header>Explorer</header>
        <main><h1><span id="mainaddress" data-highlight-target="${address}">${address}</span></h1></main>` });
    await expect(page.locator('#mainaddress')).toHaveAttribute('data-0xtagger-short', /./);
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
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-0xtagger-surface')),
      { message: shape }).toBe(expected);
  }
});

// What a website already calls an address is a starting value, offered only
// once the editor is open. It is never a claim about who the address is, and
// it never competes with a name already saved.
test.describe('a name the website already shows', () => {
  const labelled = (id, at, name) =>
    `<p><a id="${id}" href="/address/${at}"><span class="hash-tag">${name}</span></a></p>`;
  const open = (page, html, records) =>
    start(page, { html: `<header>Explorer</header><main>${html}</main>`, records });
  const fromSite = page => page.getByRole('dialog').locator('.row .from');
  const offer = page => page.getByRole('dialog').locator('.offer');

  test('fills an unnamed address with the site\'s name, selected and marked as theirs', async ({ page }) => {
    await open(page, labelled('row', other, 'Uniswap V3: Router'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('Uniswap V3: Router');
    // Set in the ink of any other tag, because it is one keystroke from being
    // one: muted would say the field was empty while it holds what Save would
    // store. Whose words they are is said beside them, never on its own line.
    await expect(fromSite(page)).toHaveText('(from Etherscan)');
    const [ink, plain] = await page.getByRole('dialog').evaluate(panel => [
      getComputedStyle(panel.querySelector('.row input')).color,
      getComputedStyle(panel.querySelector('code')).color]);
    expect(ink).toBe(plain);
    // Selected, so typing replaces it rather than appending to it.
    expect(await input(page).evaluate(field => [field.selectionStart, field.selectionEnd]))
      .toEqual([0, 'Uniswap V3: Router'.length]);
  });

  test('saving it keeps where it came from; rewriting it first does not', async ({ page }) => {
    await open(page, labelled('row', other, 'Uniswap V3: Router'), [record]);
    await tagFor(page, 'row').click();
    await save(page).click();
    // The aside is never part of what is stored.
    await expect.poll(() => page.evaluate(() => window.saves.at(-1)))
      .toMatchObject({ address: other, tags: ['Uniswap V3: Router'], source: 'etherscan:page' });

    await open(page, labelled('row', other, 'Uniswap V3: Router'), [record]);
    await tagFor(page, 'row').click();
    await input(page).fill('The router we use');
    await expect(fromSite(page)).toHaveCount(0);
    await save(page).click();
    const written = await page.evaluate(() => window.saves.at(-1));
    expect(written.tags).toEqual(['The router we use']);
    expect(written.source).toBe(undefined);
  });

  // A saved address is settled. The site's name is shown, never substituted,
  // and adding it appends: the preferred name stays the preferred name.
  test('an address already named is offered the site\'s name, never filled with it', async ({ page }) => {
    await open(page, labelled('row', address, 'Uniswap V3: Router'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('Treasury');
    await expect(fromSite(page)).toHaveCount(0);
    await expect(offer(page)).toContainText('Uniswap V3: Router');
    await offer(page).getByRole('button', { name: 'Add tag' }).click();
    await save(page).click();
    await expect.poll(() => page.evaluate(() => window.saves.at(-1))).toMatchObject({
      tags: ['Treasury', 'Operations', 'Uniswap V3: Router'],
    });
  });

  test('says nothing when the site agrees with a name already saved', async ({ page }) => {
    await open(page, labelled('row', address, 'Treasury'), [record]);
    await tagFor(page, 'row').click();
    await expect(offer(page)).toBeHidden();
    await expect(fromSite(page)).toHaveCount(0);
  });

  // A label belongs to the chain the page was showing it on. Saving an
  // Ethereum contract's name to every network would put it against whatever
  // sits at that address on Base.
  test('saves a name to the network the website was showing', async ({ page }) => {
    await open(page, labelled('row', other, 'Uniswap V3: Router'), [record]);
    await tagFor(page, 'row').click();
    await save(page).click();
    await expect.poll(() => page.evaluate(() => window.saves.at(-1)))
      .toMatchObject({ address: other, scope: 'eip155:1' });
  });

  // A name this editor put in the field itself is not something anyone typed,
  // so moving to another address must not ask anyone to save work they did not
  // do. Typing makes it a draft, and then it does.
  test('an untouched suggestion is not an unsaved draft', async ({ page }) => {
    // Far enough apart that the open editor does not sit over the second row.
    await open(page, labelled('one', other, 'Uniswap V3: Router')
      + '<div style="height:420px"></div>' + labelled('two', address, 'Treasury'), [record]);
    await tagFor(page, 'one').click();
    await expect(input(page)).toHaveValue('Uniswap V3: Router');
    await tagFor(page, 'two').click();
    await expect(shownAddress(page)).toHaveText(checksumAddress(address));
    await expect(page.getByRole('dialog')).not.toContainText('Save or close');

    await tagFor(page, 'one').click();
    await input(page).fill('Mine now');
    await tagFor(page, 'two').click();
    await expect(shownAddress(page)).toHaveText(checksumAddress(other));
    await expect(page.getByRole('dialog')).toContainText('Save or close');
  });

  // An address, or a piece of one, is not a name worth offering back.
  test('never offers an address as a name', async ({ page }) => {
    await open(page, labelled('row', other, '0xcdcd…cdcd'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('');
    await expect(fromSite(page)).toHaveCount(0);
  });

  // Every row below is the explorer's markup as the page runs it, not as it is
  // served: what a shortened display holds whole was in a title, and the
  // explorer's own script takes that title away into a tooltip of its own
  // before anyone can open a row. Only what is still written can be read.
  const titled = (id, at, shown) =>
    `<p><a id="${id}" href="/address/${at}">` +
    `<span class="hash-tag text-truncate" data-bs-toggle="tooltip">${shown}</span></a></p>`;

  test('fills a name tag with the name its row shows', async ({ page }) => {
    await open(page, titled('row', other, 'Yearn: yvWETH-1 Token'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('Yearn: yvWETH-1 Token');
    await expect(fromSite(page)).toHaveText('(from Etherscan)');
  });

  // Half a name is worse than none: it would be saved as the whole of one.
  test('offers nothing where the row was cut short to show a name', async ({ page }) => {
    await open(page, titled('row', other, 'Uniswap V3: Univers...'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('');
    await expect(fromSite(page)).toHaveCount(0);
  });

  // A transferred token is named in its own row, with no name tag anywhere in
  // it: the row leads with the token's name and sets its symbol beside it in
  // muted text, each under a tooltip of its own.
  const tokenRow = (id, at, name, symbol) =>
    `<p><a id="${id}" data-highlight-value data-highlight-target="${at}" href="/token/${at}">` +
    `<img src="/token/images/t.svg" width="16">` +
    `<span><span><span class="text-wrap text-truncate" data-bs-toggle="tooltip">${name}</span></span>` +
    `<span class="text-muted"> (<span class="text-wrap text-truncate" data-bs-toggle="tooltip">${symbol}</span>)</span>` +
    `</span></a></p>`;

  test('names a token by the name its row leads with, not the symbol beside it', async ({ page }) => {
    await open(page, tokenRow('row', other, 'Mog Coin', 'MOG'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('Mog Coin');
    await expect(fromSite(page)).toHaveText('(from Etherscan)');
    await save(page).click();
    await expect.poll(() => page.evaluate(() => window.saves.at(-1)))
      .toMatchObject({ address: other, scope: 'eip155:1', tags: ['Mog Coin'], source: 'etherscan:page' });
  });

  test('offers nothing for a token the row was cut short to name', async ({ page }) => {
    await open(page, tokenRow('row', other, 'Wrapped Ethe...', 'WETH'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('');
    await expect(fromSite(page)).toHaveCount(0);
  });

  // A token the explorer has no name of its own for leads with its symbol,
  // which is short enough to be shown whole.
  test('fills a token the explorer has no name for with its symbol', async ({ page }) => {
    await open(page, tokenRow('row', other, 'stETH', 'stETH'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('stETH');
    await expect(fromSite(page)).toHaveText('(from Etherscan)');
  });

  // A block's fee recipient is named by the link itself, with no name tag in
  // it and the address kept in the tooltip rather than shown. Once that
  // tooltip is the site's own, the name is all the row has left.
  const recipient = (id, at, shown) =>
    `<p><a id="${id}" data-highlight-value class="text-truncate d-block" style="max-width: 8rem;" ` +
    `href="/address/${at}"> <span data-bs-toggle="tooltip">${shown}</span></a></p>`;

  test('fills a link whose text is the name and whose address is out of sight', async ({ page }) => {
    await open(page, recipient('row', other, 'quasarbuilder'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('quasarbuilder');
    await expect(fromSite(page)).toHaveText('(from Etherscan)');
  });

  // A row set too narrow for its name is cut short by the browser, which
  // leaves the whole of it in the row to be read.
  test('fills it with the whole name a narrow row paints cut short', async ({ page }) => {
    await open(page, recipient('row', other, 'Lido: Execution Layer Rewards Vault'), [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('Lido: Execution Layer Rewards Vault');
  });

  // Anywhere the address is written out, it is the address being shown, and a
  // name standing beside it is not what the row is calling the wallet.
  test('offers nothing from a row that writes out any of the address', async ({ page }) => {
    await open(page, `<p><a id="row" data-highlight-value href="/address/${other}">vitalik.eth 0xcdcd…cdcd</a></p>`, [record]);
    await tagFor(page, 'row').click();
    await expect(input(page)).toHaveValue('');
    await expect(fromSite(page)).toHaveCount(0);
  });
});

// The accent does two jobs: words on a dark website have to be light enough to
// read, and words on a filled control have to be dark enough to sit under
// white. One colour cannot do both, so the filled surfaces keep their own.
test('a filled control writes in white, on a purple dark enough to carry it', async ({ page }) => {
  for (const [scheme, surface] of [['light', '#ffffff'], ['dark', '#101113']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page, { html: `<style>html{background:${surface}}</style>` + wallets });
    await tagFor(page, 'first').click();
    const button = page.getByRole('dialog').locator('.save');
    const [ink, fill] = await button.evaluate(node =>
      [getComputedStyle(node).color, getComputedStyle(node).backgroundColor]);
    expect(ink, `${scheme}: a filled control writes in white`).toBe('rgb(255, 255, 255)');
    expect(contrast(ink, fill), `${scheme}: Save against its own fill`).toBeGreaterThanOrEqual(4.5);
    // The switch knob is the same white on the same fill.
    const knob = page.getByRole('dialog').locator('.visibility span');
    expect(await knob.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  }
  await page.emulateMedia({ colorScheme: null });
});

// A tick drawn in the accent on a button filled with the accent is a
// confirmation nobody can see.
test('the saved tick is drawn in the colour the button writes in', async ({ page }) => {
  await start(page);
  await tagFor(page, 'first').click();
  await input(page).fill('Treasury rename');
  await save(page).click();
  const stroke = page.getByRole('dialog').locator('.save svg path');
  await expect(stroke).toHaveAttribute('stroke-dasharray', '14.2');
  const [drawn, ink] = await stroke.evaluate(node =>
    [getComputedStyle(node).stroke, getComputedStyle(node.closest('button')).color]);
  expect(drawn).toBe(ink);
  expect(drawn).toBe('rgb(74, 222, 128)');
  // The button is held shut while it confirms, and a faded fill would leave
  // the tick with nothing to be read against — a declared colour says 5:1
  // while the eye sees the panel behind it.
  const [fill, faded] = await page.getByRole('dialog').locator('.save')
    .evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).opacity]);
  expect(faded, 'a confirming button is locked, not faded').toBe('1');
  expect(contrast(drawn, fill)).toBeGreaterThanOrEqual(3);
});

// A record already saved carries its words as its own, whatever they were
// first read from, so nothing beside them claims otherwise.
test('a saved name is never labelled with where the record came from', async ({ page }) => {
  const labelled = `<p><a id="row" href="/address/${address}"><span class="hash-tag">Binance 16</span></a></p>`;
  await start(page, { html: `<header>Explorer</header><main>${labelled}</main>`,
    records: [{ ...record, tags: ['My own words'], source: 'safe:address-book' }] });
  await tagFor(page, 'row').click();
  await expect(input(page)).toHaveValue('My own words');
  await expect(page.getByRole('dialog').locator('.row .from')).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('from Safe');
});

// The panel 0xtagger draws lives in the page's own DOM, so a website's scripts
// can reach its controls. Nothing they press may write to the book: Save has
// always answered only to a real press, and the conflict panel's own write
// answers to the same rule.
test('a website script cannot settle a conflict on the book', async ({ page }) => {
  await start(page);
  await edit(page).click();
  await input(page).fill('My edit');
  await page.evaluate(({ record }) => { window.saveError = 'Conflict'; window.conflict = { ...record, tags: ['Newer name'], version: 'newer' }; }, { record });
  await save(page).click();
  await expect(page.locator('.conflict')).toBeVisible();
  const asked = await page.evaluate(() => window.saves.length);
  // What a script on the page can do: find our panel and press the answer that
  // writes, which would settle the conflict for the draft without being asked.
  const pressed = await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-0xtagger-ui]')) {
      for (const button of node.shadowRoot?.querySelectorAll('.conflict button') || []) {
        if (button.textContent === 'Keep mine') { button.click(); return true; }
      }
    }
    return false;
  });
  expect(pressed).toBe(true);
  // Nothing was sent, and the draft is still the one that was typed.
  expect(await page.evaluate(() => window.saves.length)).toBe(asked);
  await expect(input(page)).toHaveValue('My edit');
  // The same press, made by a person, still answers the conflict.
  await page.getByRole('button', { name: 'Keep mine' }).click();
  expect(await page.evaluate(() => window.saves.at(-1))).toMatchObject({ tags: ['My edit', 'Operations'], version: 'newer' });
});
