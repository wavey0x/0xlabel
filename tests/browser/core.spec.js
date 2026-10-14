import { test, expect } from '@playwright/test';
import { checksumAddress } from '../../extension/checksum.js';

const address = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
const record = { address, scope: 'global', labels: ['Treasury', 'Operations'], version: 'one' };

async function start(page, { html, site = 'https://etherscan.io/accounts', records = [record] } = {}) {
  await page.goto('/tests/fixtures/page.html');
  if (html) await page.setContent(html);
  await page.addStyleTag({url:'/extension/page.css'});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async ({ site, records }) => {
    const { createPageController } = await import('/extension/page.js');
    window.fixtureURL = new URL(site);
    window.state = { connectionKey: 'http://127.0.0.1:8712', connectionName: 'Local', selectionGeneration: 1, stateRevision: 1, records };
    window.saves = [];
    window.reports = [];
    window.controller = await createPageController({ state: window.state, url: () => window.fixtureURL,
      report: value => window.reports.push(value),
      save: async draft => {
        window.saves.push(draft);
        if (window.saveGate) await window.saveGate;
        if (window.saveError) { const error = new Error(window.saveError); if (window.conflict) { error.status=409; error.current=window.conflict; } throw error; }
        const entry = draft.labels.length ? { ...draft, version: 'saved-' + window.saves.length } : null;
        window.state.records = [...window.state.records.filter(item => item.address !== draft.address || item.scope !== draft.scope), ...(entry ? [entry] : [])];
        return { state: structuredClone(window.state) };
      },
    });
  }, { site, records });
  return errors;
}
const prefix = page => page.locator('[data-0xlabel-label]').first();
const editButton = (page, index = 0) => page.getByRole('button', { name: 'Edit wallet labels', exact: true }).nth(index);
const twoWallets = `<header>Explorer</header><main><p><a id="first" href="/address/${address}">${address}</a></p>
  <p style="margin-top:600px"><a id="second" href="/address/${other}">${other}</a></p></main>`;

async function pauseSaveAnimation(page) {
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches('.save')) { animation.pause(); window.saveAnimation = animation; }
      return animation;
    };
  });
}

test('another tag replaces an untouched editor; clicking its own tag refocuses the draft', async ({ page }) => {
  await start(page, { html: twoWallets });
  await editButton(page).click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Treasury');
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  await page.getByRole('button', { name: 'Add label', exact: false }).click();
  await page.getByRole('button', { name: 'Add label', exact: false }).click();
  await editButton(page).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
  await editButton(page, 1).click();
  const input = page.getByRole('textbox', { name: 'Label 1' });
  await input.fill('Draft for the second wallet');
  await editButton(page, 1).click();
  await expect(input).toHaveValue('Draft for the second wallet');
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
});

test('another tag preserves changed names and deletions, explains the block, and refocuses the draft', async ({ page }) => {
  await start(page, { html: twoWallets });
  await editButton(page).click();
  const input = page.getByRole('textbox', { name: 'Label 1' });
  await input.fill('Keep this draft');
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
  await expect(input).toHaveValue('Keep this draft');
  await expect(input).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Save or close this draft');
  await input.fill('Treasury');
  await page.getByRole('button', { name: 'Remove name 2' }).click();
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
  await expect(page.getByRole('textbox', { name: 'Label 2' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add label', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label 2' }).fill('Operations');
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
});

test('another tag cannot replace an editor during a pending save', async ({ page }) => {
  await start(page, { html: twoWallets });
  await editButton(page).click();
  await page.evaluate(() => { window.saveGate = new Promise(resolve => { window.releaseSave = resolve; }); });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Save or close this draft');
  await page.evaluate(() => window.releaseSave());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0].address)).toBe(address);
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
});

for (const reduced of [false, true]) {
  test(`confirmed Save shows a locked checkmark before closing${reduced ? ' without motion' : ' with a brief pulse'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await start(page, { html: `<style>body{font:14px system-ui;margin:30px;background:${reduced ? '#fff' : '#111'};color:${reduced ? '#111' : '#fafafa'};color-scheme:${reduced ? 'light' : 'dark'}}</style>` + twoWallets, records: [] });
    await editButton(page).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add label', exact: true })).toHaveText('+');
    await page.getByRole('textbox', { name: 'Label 1' }).fill('Treasury');
    await pauseSaveAnimation(page);
    await page.evaluate(() => { window.saveGate = new Promise(resolve => { window.releaseSave = resolve; }); });
    const width = await page.getByRole('button', { name: 'Save', exact: true }).evaluate(button => button.offsetWidth);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.saveAnimation)).toBeUndefined();
    await page.evaluate(() => window.releaseSave());
    const saved = page.getByRole('button', { name: 'Saved', exact: true });
    await expect(saved).toBeDisabled();
    await expect(saved.locator('svg')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await saved.evaluate(button => button.offsetWidth)).toBe(width);
    const frames = await page.evaluate(() => window.saveAnimation.effect.getKeyframes());
    expect(frames.some(frame => frame.transform === 'scale(1.06)')).toBe(!reduced);
    expect(await page.evaluate(() => window.saveAnimation.effect.getTiming().duration)).toBe(300);
    // A late book update must not replace the confirmed checkmark with Saving….
    await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 2 }));
    await expect(saved).toBeVisible();
    await saved.evaluate(button => button.onclick());
    expect(await page.evaluate(() => window.saves.length)).toBe(1);
    await page.evaluate(() => { window.saveAnimation.currentTime = 105; });
    await page.getByRole('dialog').screenshot({ path: `test-results/save-confirmation-${reduced ? 'light' : 'dark'}.png` });
    await page.evaluate(() => window.saveAnimation.finish());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'global', labels: ['Treasury'] });
  });
}

test('outside dismissal during a save confirmation cannot later close a newly opened draft', async ({ page }) => {
  await start(page, { html: twoWallets });
  await editButton(page).click();
  await pauseSaveAnimation(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.locator('body > header').click();
  await editButton(page, 1).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Next draft');
  await page.evaluate(async () => { window.saveAnimation.finish(); await window.saveAnimation.finished; });
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Next draft');
  expect(await page.evaluate(() => window.saves.length)).toBe(1);
});

test('outside clicks dismiss drafts while panel clicks, native focus and copy controls retain their behavior', async ({ page }) => {
  const errors = await start(page);
  await editButton(page).click();
  const dialog = page.getByRole('dialog');
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Unsaved draft');
  await dialog.locator('code').click();
  await dialog.getByRole('button', { name: 'Add label', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Label 3' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Unsaved draft');
  await page.locator('#native-input').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#native-input')).toBeFocused();
  await page.locator('#native-input').fill('Native typing still works');
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  await editButton(page).click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Treasury');
  await page.locator('main button').first().click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('500 addresses use local labels, preserve text/links/copy/modifier clicks and clean up fully', async ({ page }) => {
  const errors = await start(page);
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(500);
  const link = prefix(page);
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(link).toHaveText('0xabababab…abababab');
  await expect(link).toHaveAttribute('href', '/address/' + address);
  await expect(link).toHaveAttribute('aria-description', '0xlabel: Treasury');
  expect(await link.evaluate(element=>getComputedStyle(element,'::before').content)).toContain('Treasury');
  expect(await link.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe('dashed');
  await page.locator('main button').first().click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  await link.dispatchEvent('click', { ctrlKey: true });
  expect(await page.evaluate(() => window.nativeClicked)).toEqual({ text: '0xabababab…abababab', address: '/address/' + address, ctrl: true });
  await expect(page.locator('#native-input')).toHaveValue(address);
  await page.evaluate(() => { const selection=window.getSelection(); const range=document.createRange(); range.selectNodeContents(document.querySelector('[data-0xlabel-label]')); selection.removeAllRanges(); selection.addRange(range); });
  expect(await page.evaluate(() => getSelection().toString())).toBe('0xabababab…abababab');
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
  expect(await page.locator('main a').first().getAttribute('aria-description')).toBeNull();
  await page.locator('main button').first().click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  expect(errors).toEqual([]);
});

test('our label replaces the visible site name, preserving native nodes, links, copy sources and restoration', async ({ page }) => {
  const nativeName = 'Binance: a long explorer-provided wallet name';
  await start(page, { records: [{ ...record, labels: ['Treasury'] }], html: `<header>Explorer</header><main>
    <a id="named" class="hash-tag" style="font-size:17px" href="/address/${address}"><span style="font-size:22px">${nativeName}</span></a>
    <button id="copy" data-clipboard-text="${address}">Copy address</button>
    <p><a id="unsafe" class="hash-tag" href="/address/${address}">Native controls<button>Copy</button></a></p>
    </main><script>
      const named = document.querySelector('#named');
      window.nativeNode = named.firstChild;
      window.nativeWidth = named.getBoundingClientRect().width;
      named.onclick = event => { event.preventDefault(); window.nativeClick = { text:named.textContent, href:named.getAttribute('href'), ctrl:event.ctrlKey }; };
      document.querySelector('#copy').onclick = event => { window.nativeCopied = event.target.dataset.clipboardText; };
    </script>` });
  const link = page.locator('#named');
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(page.locator('#unsafe')).not.toHaveAttribute('data-0xlabel-address');
  const shown = await link.evaluate(element => ({
    content: getComputedStyle(element, '::before').content,
    font: getComputedStyle(element, '::before').fontSize,
    nativeFont: getComputedStyle(element.firstChild).fontSize,
    sameNode: element.firstChild === window.nativeNode,
    text: element.textContent, innerText: element.innerText,
    width: element.getBoundingClientRect().width, nativeWidth: window.nativeWidth,
  }));
  expect(shown).toMatchObject({ content: '"Treasury"', font: '17px', nativeFont: '0px', sameNode: true, text: nativeName, innerText: nativeName });
  expect(shown.width).toBeLessThan(shown.nativeWidth / 2);
  await link.click();
  expect(await page.evaluate(() => window.nativeClick)).toEqual({ text: nativeName, href: '/address/' + address, ctrl: false });
  await link.dispatchEvent('click', { ctrlKey: true });
  expect(await page.evaluate(() => window.nativeClick.ctrl)).toBe(true);
  await page.locator('#copy').click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  await page.evaluate(() => window.controller.updateState({ ...window.state, stateRevision: 2, records: [] }));
  await expect(link).not.toHaveAttribute('data-0xlabel-label');
  expect(await link.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(shown.nativeWidth, 3);
  expect(await link.evaluate(element => getComputedStyle(element.firstChild).fontSize)).toBe('22px');
  await page.evaluate(() => window.controller.stop());
  expect(await link.evaluate(element => element.style.getPropertyValue('--0xlabel-font-size'))).toBe('');
  await expect(link).toHaveText(nativeName);
});

test('eye reveals every matching address without losing the draft, and retains the comparison through updates and saves', async ({ page }) => {
  const errors = await start(page, { records: [{ ...record, labels: ['Treasury'] }, { ...record, address: other, labels: ['Other wallet'] }], html: `
    <style>body{font:14px system-ui;margin:30px;background:#fff;color:#111}main{min-height:1200px}.wallet{margin:12px 0}</style>
    <header>Explorer</header><main>
      <p class="wallet"><a id="first" class="hash-tag" style="font-size:17px" href="/address/${address}"><span style="font-size:22px">Website name</span></a><button id="native-copy">Copy address</button></p>
      <p class="wallet"><a id="second" class="hash-tag" href="/address/${address}">Website name</a></p>
      <p class="wallet"><a id="other" href="/address/${other}">${other}</a></p>
    </main><script>
      window.nativeNode = document.querySelector('#first').firstChild;
      document.querySelector('#native-copy').onclick = () => { window.nativeCopied = '${address}'; };
      document.querySelector('#first').onclick = event => { event.preventDefault(); window.nativeClicked = event.currentTarget.getAttribute('href'); };
    </script>` });
  const first = page.locator('#first'), second = page.locator('#second');
  const button = first.locator('+ [data-0xlabel-edit]').getByRole('button');
  await button.click();
  await expect(page.getByRole('button', { name: 'Close editor' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Edited treasury');
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Edited treasury');
  for (const link of [first, second]) {
    await expect(link).not.toHaveAttribute('data-0xlabel-label');
    await expect(link).not.toHaveAttribute('aria-description');
    expect(await link.evaluate(element => element.style.getPropertyValue('--0xlabel-font-size'))).toBe('');
  }
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(3);
  await expect(page.locator('#other')).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  expect(await first.evaluate(element => ({ sameNode: element.firstChild === window.nativeNode, font: getComputedStyle(element.firstChild).fontSize }))).toEqual({ sameNode: true, font: '22px' });
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  await page.getByRole('dialog').screenshot({ path: 'test-results/eye-original-light.png' });
  await first.locator('span').evaluate(element => { element.textContent = 'Updated website name'; });
  await page.evaluate(({ address }) => {
    const row = document.createElement('p'); row.className = 'wallet';
    row.innerHTML = '<a id="added" class="hash-tag" href="/address/' + address + '">New website row</a>';
    document.querySelector('main').append(row);
    window.state = { ...window.state, stateRevision: 2, records: window.state.records.map(record => ({ ...record, labels: ['Synced name'] })) };
    window.controller.updateState(window.state);
  }, { address });
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(4);
  for (const id of ['first', 'second', 'added']) await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-label');
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Edited treasury');
  await page.evaluate(() => window.scrollTo(0, 180));
  await page.getByRole('button', { name: 'Show my label', exact: true }).press('Enter');
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Synced name');
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const id of ['first', 'second', 'added']) await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-label');
  expect(await page.evaluate(() => window.saves[0].labels)).toEqual(['Edited treasury']);
  await page.locator('#native-copy').click();
  expect(await page.evaluate(() => window.nativeCopied)).toBe(address);
  await first.click();
  expect(await page.evaluate(() => window.nativeClicked)).toBe('/address/' + address);
  await page.evaluate(() => { document.body.style.background = '#111'; document.body.style.color = '#fafafa'; document.body.style.colorScheme = 'dark'; });
  await button.click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Edited treasury');
  await expect(page.getByRole('button', { name: 'Show my label', exact: true })).toBeEnabled();
  await page.getByRole('dialog').screenshot({ path: 'test-results/eye-original-dark.png' });
  await page.getByRole('button', { name: 'Show my label', exact: true }).click();
  for (const id of ['first', 'second', 'added']) await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-label', 'Edited treasury');
  await expect(first).toHaveText('Updated website name');
  await expect(page.locator('#added')).toHaveText('New website row');
  expect(errors).toEqual([]);
});

test('eye comparison stays within its chain, suppresses global fallback and disappears without a saved label', async ({ page }) => {
  const records = [{ ...record, labels: ['Global name'] }, { ...record, scope: 'eip155:1', labels: ['Ethereum name'], version: 'network' }];
  await start(page, { site: 'https://app.safe.global/home?safe=eth:' + address, records, html: `<header>Safe</header><main>
    <p><a id="eth" href="https://etherscan.io/address/${address}">${address}</a></p>
    <p><a id="base" href="https://basescan.org/address/${address}">${address}</a></p></main>` });
  const eth = page.locator('#eth'), base = page.locator('#base');
  await expect(eth).toHaveAttribute('data-0xlabel-label', 'Ethereum name');
  await expect(base).toHaveAttribute('data-0xlabel-label', 'Global name');
  const button = eth.locator('+ [data-0xlabel-edit]').getByRole('button');
  await button.click();
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  await expect(eth).not.toHaveAttribute('data-0xlabel-label');
  await expect(base).toHaveAttribute('data-0xlabel-label', 'Global name');
  await page.getByRole('button', { name: 'Remove name 1', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope: 'eip155:1', labels: [], version: 'network' });
  await expect(eth).not.toHaveAttribute('data-0xlabel-label');
  await expect(base).toHaveAttribute('data-0xlabel-label', 'Global name');
  await button.click();
  await expect(page.getByRole('button', { name: 'Show my label', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.state = { ...window.state, stateRevision: 2, records: [] };
    window.controller.updateState(window.state);
  });
  await expect(page.getByRole('button', { name: /^Show (my label|website original)$/ })).toHaveCount(0);
  await page.evaluate(records => {
    window.state = { ...window.state, stateRevision: 3, records };
    window.controller.updateState(window.state);
  }, [records[0]]);
  await expect(page.getByRole('button', { name: 'Show my label', exact: true })).toBeEnabled();
  await expect(eth).not.toHaveAttribute('data-0xlabel-label');
  await expect(base).toHaveAttribute('data-0xlabel-label', 'Global name');
  await page.getByRole('button', { name: 'Show my label', exact: true }).click();
  await expect(eth).toHaveAttribute('data-0xlabel-label', 'Global name');
});

test('temporary eye comparisons reset on book switches and page navigation; late packets cannot restore them', async ({ page }) => {
  await start(page, { html: twoWallets });
  const first = page.locator('#first');
  const button = first.locator('+ [data-0xlabel-edit]').getByRole('button');
  await button.click();
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await page.evaluate(() => window.controller.updateState({ ...window.state, connectionKey: 'https://remote.example', connectionName: 'Remote', selectionGeneration: 2, records: [{ ...window.state.records[0], labels: ['Remote name'] }] }));
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Remote name');
  await page.evaluate(() => {
    window.state = { ...window.state, selectionGeneration: 3 };
    window.controller.updateState(window.state);
  });
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await button.click();
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await page.evaluate(() => window.controller.updateState({ ...window.state, connectionKey: 'https://remote.example', selectionGeneration: 2 }));
  await expect(first).not.toHaveAttribute('data-0xlabel-label');
  await page.evaluate(() => { window.fixtureURL = new URL('https://etherscan.io/accounts?p=2'); window.controller.retry(); });
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await button.click();
  await expect(page.getByRole('button', { name: 'Show website original', exact: true })).toBeEnabled();
});

test('a detached, paused or source-switched editor cannot toggle another row or book', async ({ page }) => {
  await start(page, { html: twoWallets, records: [record, { ...record, address: other, labels: ['Other wallet'] }] });
  const first = page.locator('#first');
  await editButton(page).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Captured draft');
  await page.getByRole('button', { name: 'Show website original', exact: true }).click();
  const eye = page.locator('.visibility');
  await first.evaluate((element, other) => { element.href = '/address/' + other; element.textContent = other; }, other);
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  await expect(eye).toBeDisabled();
  await eye.dispatchEvent('click');
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Captured draft');
  await page.evaluate(() => window.controller.updateState({ ...window.state, connectionKey: 'https://remote.example', connectionName: 'Remote', selectionGeneration: 2, records: window.state.records.map(record => ({ ...record, labels: ['Remote name'] })) }));
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Remote name');
  await expect(eye).toBeDisabled();
  await eye.dispatchEvent('click');
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Remote name');
  await page.evaluate(() => window.controller.updateState({ ...window.state, selectionGeneration: 3 }));
  await expect(first).toHaveAttribute('data-0xlabel-label', 'Other wallet');
  await expect(eye).toBeDisabled();
  await page.locator('body > header').evaluate(element => element.remove());
  await expect.poll(() => page.evaluate(() => window.controller.health.status)).toBe('stale');
  await expect(eye).toBeDisabled();
  await eye.dispatchEvent('click');
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
});

test('label control is reachable, ranked editing saves with Enter and preserves the native address', async ({ page }) => {
  const errors = await start(page);
  const link = prefix(page);
  await link.hover();
  await expect(editButton(page)).toBeVisible();
  const before = await link.boundingBox(), glyph = await editButton(page).boundingBox();
  expect(glyph.x).toBeGreaterThanOrEqual(before.x + before.width);
  await page.locator('.widget').first().evaluate(element => { element.onclick = () => { window.delegatedClicks = (window.delegatedClicks || 0) + 1; }; });
  await editButton(page).click();
  expect(await page.evaluate(() => window.delegatedClicks || 0)).toBe(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toBeFocused();
  await page.getByRole('button', { name: 'Move up 2' }).click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Operations');
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Operations desk');
  await page.getByRole('textbox', { name: 'Label 1' }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Operations desk');
  expect(await page.evaluate(() => window.saves[0].labels)).toEqual(['Operations desk', 'Treasury']);
  await link.focus();
  await link.press('Tab');
  await expect(editButton(page)).toBeFocused();
  await editButton(page).press('Enter');
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Discard me');
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Operations desk');
  expect(errors).toEqual([]);
});

test('hover effects keep the label control ready without rescanning 500 addresses', async ({ page }) => {
  await start(page);
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(500);
  const link = page.locator('main a').first();
  await link.hover();
  await expect(editButton(page)).toBeVisible();
  await page.evaluate(() => {
    window.hoverWork = { hitTests: 0, addressReads: 0, removedMarkers: 0 };
    const hitTest = document.elementsFromPoint.bind(document);
    document.elementsFromPoint = (...args) => { window.hoverWork.hitTests++; return hitTest(...args); };
    const style = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element, ...args) => {
      if (element.matches('main a')) window.hoverWork.addressReads++;
      return style(element, ...args);
    };
    new MutationObserver(changes => {
      window.hoverWork.removedMarkers += changes.filter(change => change.oldValue && !change.target.hasAttribute('data-0xlabel-address')).length;
    }).observe(document.querySelector('main'), { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-0xlabel-address'] });
  });
  await editButton(page).hover();
  expect(await page.evaluate(() => window.hoverWork.hitTests)).toBe(0);
  await page.evaluate(() => {
    const link = document.querySelector('main a');
    link.classList.add('native-hover');
    link.setAttribute('title', 'Wallet tooltip');
    const tooltip = document.createElement('div');
    tooltip.id = 'native-tooltip'; tooltip.textContent = 'A website tooltip';
    document.body.append(tooltip);
  });
  await expect(editButton(page)).toBeVisible();
  await page.waitForTimeout(120); // Allow the observer's batch to finish.
  await page.locator('#native-tooltip').evaluate(element => element.remove());
  await page.waitForTimeout(120);
  const work = await page.evaluate(() => window.hoverWork);
  expect(work.removedMarkers).toBe(0);
  expect(work.addressReads).toBeLessThan(10);
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Treasury');
  // A genuine identity change still invalidates immediately, before the batch.
  expect(await link.evaluate((element, other) => new Promise(resolve => {
    element.href = '/address/' + other;
    queueMicrotask(() => resolve(element.hasAttribute('data-0xlabel-address')));
  }), other)).toBe(false);
});

for (const caption of ['', 'Nearby website text']) {
  test(`label control avoids the Contract heading, copy controls and ${caption ? 'nearby text' : 'QR control'}`, async ({ page }) => {
    await start(page, { records: [], html: `<style>
      body { font: 18px system-ui; margin: 24px; }
      main { margin-top: 100px; }
      .contract-row { display: flex; align-items: center; gap: 8px; }
      h1 { margin: 0; font-size: 24px; }
      #mainaddress { font: 18px monospace; }
      button { width: 28px; height: 28px; padding: 0; }
    </style><header>Explorer</header><main><div class="contract-row">
      <h1>Contract</h1><span id="mainaddress">${address}</span>
      <button id="copy">Copy</button><button id="qr">QR</button>
      <span id="caption">${caption}</span>
    </div></main>` });
    await page.locator('#mainaddress').hover();
    await expect(editButton(page)).toBeVisible();
    const glyph = await editButton(page).boundingBox();
    const addressBox = await page.locator('#mainaddress').boundingBox();
    expect(glyph.x).toBeGreaterThanOrEqual(addressBox.x + addressBox.width);
    expect(glyph.x - addressBox.x - addressBox.width).toBeLessThan(16);
    expect(Math.abs(glyph.y + glyph.height / 2 - addressBox.y - addressBox.height / 2)).toBeLessThan(3);
    for (const selector of ['h1', '#mainaddress', '#copy', '#qr', ...(caption ? ['#caption'] : [])]) {
      const native = await page.locator(selector).boundingBox();
      expect(glyph.x + glyph.width <= native.x || glyph.x >= native.x + native.width ||
        glyph.y + glyph.height <= native.y || glyph.y >= native.y + native.height).toBe(true);
    }
    await editButton(page).hover();
    expect(await editButton(page).boundingBox()).toEqual(glyph);
    await page.locator('#mainaddress').evaluate(element => { element.title = 'Later website tooltip'; element.classList.add('hovered'); });
    await page.waitForTimeout(120);
    expect(await editButton(page).boundingBox()).toEqual(glyph);
    await editButton(page).click();
    await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
    await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
    await expect(editButton(page)).toBeVisible();
  });
}

test('inline label control stays beside its address through hover and updates, without positioning reads', async ({ page }) => {
  await start(page);
  const link = page.locator('main a').first();
  await expect(editButton(page)).toBeVisible();
  const before = await editButton(page).boundingBox();
  await page.evaluate(() => {
    window.hoverReads = 0;
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { window.hoverReads++; return rect.call(this); };
    const hit = document.elementsFromPoint.bind(document);
    document.elementsFromPoint = (...args) => { window.hoverReads++; return hit(...args); };
  });
  await link.hover(); await editButton(page).hover(); await page.mouse.move(5, 5);
  expect(await page.evaluate(() => window.hoverReads)).toBe(0);
  await page.evaluate(() => {
    document.querySelector('main a').classList.add('later-website-update');
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.hoverReads)).toBe(0);
  expect(await editButton(page).boundingBox()).toEqual(before);
  await link.focus(); await link.press('Tab');
  await expect(editButton(page)).toBeFocused();
  await editButton(page).press('Shift+Tab'); await expect(link).toBeFocused();
  await link.press('Tab'); await editButton(page).press('Tab');
  await expect(page.locator('main button').first()).toBeFocused();
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(0);
});

test('Etherscan resolves ENS, preset names and fragments from canonical links only', async ({ page }) => {
  await start(page, { html: `<header></header><main>
    <a href="/address/${address}" class="d-inline-flex"><span id="ens" class="hash-tag text-truncate" data-bs-toggle="tooltip">bettor.eth</span></a>
    <a id="preset" href="/address/${address}" class="hash-tag text-truncate" data-bs-toggle="tooltip">Curve: Deployer 1</a>
    <a id="fragment" href="/address/${address}"><span>0xabab</span><span>…</span><span>abab</span></a>
    <a id="unresolved" href="/address/bettor.eth" class="hash-tag">bettor.eth</a>
    <a id="navigation" class="dropdown-item" href="/address/${address}"><span class="hash-tag">View on another explorer</span></a>
  </main>` });
  for (const id of ['ens', 'preset', 'fragment']) await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-label', 'Treasury');
  for (const id of ['unresolved', 'navigation']) await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-address');
  await expect(page.locator('#ens')).toHaveText('bettor.eth');
  await expect(page.locator('#preset')).toHaveText('Curve: Deployer 1');
  await page.locator('#ens').evaluate(element => { element.classList.add('native-hover'); element.title = 'A website tooltip'; });
  await page.waitForTimeout(120);
  await expect(page.locator('#ens')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await page.locator('#ens').hover(); await editButton(page).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
});

test('Etherscan homepage named fee recipients retain nearby controls through tooltip and row updates', async ({ page }) => {
  const titan = '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97';
  // Latest Blocks uses plain tooltip spans rather than transaction-table hash tags.
  const feeRow = (id, wallet, name) => `<div class="recipient">Fee Recipient <a id="${id}" data-highlight-value class="text-truncate d-block" style="max-width:8rem" href="/address/${wallet}"><span data-bs-toggle="tooltip" title="${wallet}">${name}</span></a></div>`;
  const errors = await start(page, { site: 'https://etherscan.io/',
    records: [{ address: titan, scope: 'global', labels: ['My builder'], version: 'one' }],
    html: `<style>.recipient{display:flex;align-items:center;gap:4px;margin:12px}.text-truncate{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.d-block{display:block}</style>
    <header>Explorer</header><main><h2>Latest Blocks</h2>
      ${feeRow('unknown', other, 'Fee Recipient: 0xcdcd…cdcd')}
      ${Array.from({ length: 5 }, (_, i) => feeRow('titan-' + i, titan, 'Titan Builder')).join('')}
      <a id="card" href="/address/${titan}">View address</a>
      <a id="unresolved" data-highlight-value href="/address/titan.eth">Titan Builder</a>
      <nav><a id="navigation" data-highlight-value href="/address/${titan}">View address</a></nav>
    </main>` });
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(6);
  for (let i = 0; i < 5; i++) {
    const link = page.locator('#titan-' + i);
    await expect(link).toHaveAttribute('data-0xlabel-address', titan);
    await expect(link).toHaveAttribute('data-0xlabel-label', 'My builder');
    await expect(link).toHaveText('Titan Builder');
    const glyph = link.locator('+ [data-0xlabel-edit]');
    const textBox = await link.boundingBox(), control = await glyph.boundingBox();
    expect(control.x - textBox.x - textBox.width).toBeLessThan(10);
    expect(control.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
  }
  for (const id of ['card', 'unresolved', 'navigation']) await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-address');
  const first = page.locator('#titan-0');
  const button = first.locator('+ [data-0xlabel-edit]').getByRole('button');
  await first.locator('span').evaluate(element => {
    element.dataset.bsOriginalTitle = element.title;
    element.removeAttribute('title');
  });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(titan));
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await first.evaluate((element, wallet) => {
    element.setAttribute('href', '/address/' + wallet);
    element.firstElementChild.textContent = 'Another builder';
    element.firstElementChild.dataset.bsOriginalTitle = wallet;
  }, other);
  await expect(first).toHaveAttribute('data-0xlabel-address', other);
  await expect(first).not.toHaveAttribute('data-0xlabel-label');
  await button.click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await first.evaluate(element => element.removeAttribute('data-highlight-value'));
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(5);
  await first.evaluate(element => element.setAttribute('data-highlight-value', ''));
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(6);
  await expect(first).toHaveAttribute('data-0xlabel-address', other);
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-edit],[data-0xlabel-address],[data-0xlabel-label]')).toHaveCount(0);
  await expect(first).toHaveAttribute('href', '/address/' + other);
  await expect(first).toHaveText('Another builder');
  expect(await page.evaluate(() => window.saves.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('Etherscan transaction tables include named and current-address spans with explicit full sources', async ({ page }) => {
  const errors = await start(page, { site: 'https://etherscan.io/txs?a=' + address, html: `<header></header><main>
    <style>.wallet { display:flex; align-items:center; gap:4px; } .hash-tag { max-width:190px; overflow:hidden; white-space:nowrap; }</style>
    <table><tbody><tr><td><div class="wallet">
      <a href="/address/${address}" data-full-address="${address}"><span id="linked" data-highlight-target="${address}">0xabab…abab</span></a><button id="linked-copy">Copy</button>
    </div></td><td><div class="wallet">
      <span id="named" class="hash-tag text-truncate" data-truncate="address" data-full-address="${address}" data-bs-toggle="tooltip">Curve: CRV Token</span><button id="named-copy">Copy</button>
    </div></td></tr><tr><td><div class="wallet">
      <span id="current" class="hash-tag text-truncate" data-full-address="${address}">0xabab…abab</span><button>Copy</button>
    </div></td><td><span id="unknown" class="hash-tag">0xabab…abab</span></td></tr></tbody></table>
    <nav><span id="navigation" class="hash-tag" data-full-address="${address}">Navigation card</span></nav>
  </main>` });
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(3);
  for (const id of ['linked', 'named', 'current']) await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-label', 'Treasury');
  for (const id of ['unknown', 'navigation']) await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-address');
  const button = page.locator('#named + [data-0xlabel-edit]').getByRole('button', { name: 'Edit wallet labels' });
  const textBox = await page.locator('#named').boundingBox(), glyph = await button.boundingBox(), copy = await page.locator('#named-copy').boundingBox();
  expect(glyph.x - textBox.x - textBox.width).toBeGreaterThanOrEqual(0);
  expect(glyph.x - textBox.x - textBox.width).toBeLessThan(10);
  expect(glyph.x + glyph.width).toBeLessThanOrEqual(copy.x);
  await page.locator('#named-copy').evaluate(element => { element.onclick = () => { window.nativeCopySource = document.querySelector('#named').textContent; }; });
  await page.locator('#named-copy').click();
  expect(await page.evaluate(() => window.nativeCopySource)).toBe('Curve: CRV Token');
  await button.click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(address));
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await page.locator('#named').evaluate((element, value) => { element.dataset.fullAddress = value; }, other);
  await expect(page.locator('#named')).toHaveAttribute('data-0xlabel-address', other);
  await expect(page.locator('#named')).not.toHaveAttribute('data-0xlabel-label');
  await button.click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(0);
  await expect(page.locator('#named')).toHaveText('Curve: CRV Token');
  expect(errors).toEqual([]);
});

test('editor displays and copies EIP-55, keeps lowercase keys, and excludes label autofill', async ({ page }) => {
  const checksum = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
  const canonical = checksum.toLowerCase();
  await start(page, { html: `<p id="wallet">${canonical}</p>`, site: 'https://plain.example',
    records: [{ address: canonical, scope: 'global', labels: ['Treasury'], version: 'one' }] });
  await page.evaluate(() => { navigator.clipboard.writeText = async value => { window.extensionCopied = value; }; });
  await page.locator('#wallet').hover(); await editButton(page).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksum);
  const input = page.getByRole('textbox', { name: 'Label 1' });
  await expect(input).toHaveAttribute('type', 'search');
  await expect(input).toHaveAttribute('data-bwignore', 'true');
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await page.getByRole('dialog').getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => window.extensionCopied)).toBe(checksum);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Copied', exact: true }).locator('svg')).toHaveCount(1);
  await input.fill('Renamed treasury'); await input.press('Enter');
  expect(await page.evaluate(() => window.saves[0].address)).toBe(canonical);
  await expect(page.locator('#wallet')).toHaveText(canonical); // Native site content remains intact.
});

test('typing a label performs no positioning reads; adding a row still relays out the editor', async ({ page }) => {
  await start(page);
  await prefix(page).hover(); await editButton(page).click();
  await page.evaluate(() => {
    window.positionReads = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { window.positionReads++; return original.call(this); };
  });
  await page.getByRole('textbox', { name: 'Label 1' }).pressSequentially(' rapid typing', { delay: 1 });
  expect(await page.evaluate(() => window.positionReads)).toBe(0);
  await page.getByRole('button', { name: 'Add label', exact: false }).click();
  expect(await page.evaluate(() => window.positionReads)).toBeGreaterThan(0);
  await expect(page.getByRole('textbox', { name: 'Label 3' })).toBeFocused();
});

test('the editor scrolls with the document without positioning work or flipping sides; reopening does not jump the page', async ({ page }) => {
  await start(page, { html: `<header>Explorer</header><main style="height:3000px;width:1800px;padding-top:640px">
    <a id="wallet" href="/address/${address}">${address}</a>
    <p style="margin-top:1000px"><a href="/address/${other}">${other}</a></p></main>` });
  await editButton(page).click();
  await page.waitForTimeout(80); // Settle the initial address observer batch before measuring scroll work.
  const result = await page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    const measure = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function () { reads++; return measure.call(this); };
    const root = document.querySelector('div[data-0xlabel-ui]').shadowRoot;
    const panel = root.querySelector('[role="dialog"]');
    let writes = 0;
    const observer = new MutationObserver(changes => { writes += changes.length; });
    observer.observe(panel.parentElement, { attributes: true, attributeFilter: ['style'] });
    const points = [];
    for (const [left, top] of [[0, 0], [120, 240], [220, 640], [40, 120], [0, 0]]) {
      window.scrollTo(left, top);
      await frame();
      const box = measure.call(panel), wallet = measure.call(document.querySelector('#wallet'));
      points.push({ left: box.left + scrollX, top: box.top + scrollY, gap: box.top - wallet.bottom });
    }
    observer.disconnect();
    Element.prototype.getBoundingClientRect = measure;
    return { points, reads, writes };
  });
  expect(result.reads).toBe(0);
  expect(result.writes).toBe(0);
  expect(result.points[0].gap).toBeLessThan(0); // Initially above the low address.
  for (const point of result.points) {
    expect(point.left).toBeCloseTo(result.points[0].left, 3);
    expect(point.top).toBeCloseTo(result.points[0].top, 3);
    expect(point.gap).toBeCloseTo(result.points[0].gap, 3);
  }
  await page.getByRole('textbox', { name: 'Label 1' }).press('Escape');
  await page.evaluate(() => window.scrollTo(0, 1450));
  const scroll = await page.evaluate(() => scrollY);
  await editButton(page, 1).click();
  await expect(page.getByRole('dialog').locator('code')).toHaveText(checksumAddress(other));
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
});

test('inner scrolling and layout shifts retain the editor gap; a removed row leaves a visible, source-bound draft', async ({ page }) => {
  await start(page, { html: `<style>body{min-height:2200px}</style><header>Explorer</header>
    <main style="height:380px;overflow:auto;margin-top:100px"><div style="height:1800px;padding-top:160px">
    <p><a id="wallet" href="/address/${address}">${address}</a></p></div></main>` });
  await editButton(page).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Keep this draft');
  const gap = () => page.evaluate(() => {
    const panel = document.querySelector('div[data-0xlabel-ui]').shadowRoot.querySelector('[role="dialog"]');
    return panel.getBoundingClientRect().top - document.querySelector('#wallet').getBoundingClientRect().bottom;
  });
  const before = await gap();
  await page.locator('main').evaluate(element => { element.scrollTop = 120; });
  await expect.poll(gap).toBeCloseTo(before, 3);
  await page.locator('#wallet').evaluate(element => { element.parentElement.style.marginTop = '46px'; });
  await expect.poll(gap).toBeCloseTo(before, 3);
  await page.locator('#wallet').evaluate(element => element.remove());
  await expect(page.getByRole('status')).toContainText('This row changed');
  const beforeScroll = await page.getByRole('dialog').boundingBox();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(async () => (await page.getByRole('dialog').boundingBox()).y).toBeCloseTo(beforeScroll.y, 3);
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, connectionKey: 'http://127.0.0.1:8712', labels: ['Keep this draft', 'Operations'] });
});

test('recycled rows clear old names, and an open draft stays bound to its captured address', async ({ page }) => {
  await start(page);
  const link = page.locator('main a').first();
  await link.hover(); await editButton(page).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Captured original');
  await link.evaluate((element, other) => { element.href='/address/'+other; element.dataset.highlightTarget=other; element.dataset.fullAddress=other; element.textContent=other; }, other);
  await expect(link).not.toHaveAttribute('data-0xlabel-label');
  await expect(link).toHaveAttribute('data-0xlabel-address', other);
  await expect(page.getByRole('status')).toContainText('This row changed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.saves[0].address)).toBe(address);
  await expect(link).not.toHaveAttribute('data-0xlabel-label');
});

test('stale adapter clears annotations, preserves a draft, and fresh Retry resumes only when valid', async ({ page }) => {
  const errors = await start(page);
  await prefix(page).hover(); await editButton(page).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Still safe');
  await page.locator('body > header').evaluate(element => element.remove());
  await expect.poll(() => page.evaluate(() => window.controller.health.status)).toBe('stale');
  await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Still safe');
  await expect(page.getByRole('status')).toContainText('draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.saves[0].labels[0])).toBe('Still safe');
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await page.evaluate(() => window.controller.retry());
  expect(await page.evaluate(() => window.controller.health.status)).toBe('stale');
  await page.evaluate(() => { document.body.prepend(document.createElement('header')); window.controller.retry(); });
  await expect(prefix(page)).toHaveAttribute('data-0xlabel-label', 'Still safe');
  expect(errors).toEqual([]);
});

test('source switch removes Local names, keeps the draft, rejects its Save, and ignores an older state', async ({ page }) => {
  await start(page);
  await prefix(page).hover(); await editButton(page).click();
  await page.getByRole('textbox', { name: 'Label 1' }).fill('Local draft');
  await page.evaluate(() => window.controller.updateState({ ...window.state, connectionKey:'https://remote.example', connectionName:'Remote', selectionGeneration:2, records:[] }));
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Local draft');
  await editButton(page).click();
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Local draft');
  await expect(page.locator('.source')).toHaveText('Local');
  await expect(page.getByRole('status')).toContainText('belongs to Local');
  await page.evaluate(() => window.controller.updateState(window.state));
  await expect(page.locator('[data-0xlabel-label]')).toHaveCount(0);
  await page.evaluate(() => window.controller.updateState({ ...window.state, selectionGeneration:3 }));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('Safe: full and shortened identities, scoped lists, removal fallback, and unresolved fragments', async ({ page }) => {
  const html = `<header></header><div data-testid="sidebar-container"></div><main><div class="SrcEthHashInfo_addressContainer__x"><span id="safe-address">0xabab…abab</span><a href="https://etherscan.io/address/${address}">Explorer</a><button id="copy" data-address="${address}">Copy</button></div><span id="unknown">0x1234…5678</span><input value="${address}"><p id="summary">${address}</p></main>`;
  const records = [record, { address, scope:'eip155:1', labels:['Network name','Second'], version:'network' }];
  const errors = await start(page, { html, site:`https://app.safe.global/home?safe=eth:${address}`, records });
  const link = page.locator('#safe-address');
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Network name');
  await expect(page.locator('#unknown')).not.toHaveAttribute('data-0xlabel-address');
  await expect(page.locator('#copy')).not.toHaveAttribute('data-0xlabel-address');
  await link.hover(); await editButton(page).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Label 1' })).toHaveValue('Network name');
  await page.getByRole('button', { name:'Remove name 2' }).click();
  await page.getByRole('button', { name:'Remove name 1' }).click();
  await expect(page.locator('.preview')).toContainText('Treasury');
  await page.getByRole('button', { name:'Save', exact:true }).click();
  await expect(link).toHaveAttribute('data-0xlabel-label', 'Treasury');
  expect(await page.evaluate(() => window.saves[0])).toMatchObject({ address, scope:'eip155:1', labels:[], version:'network' });
  expect(errors).toEqual([]);
});

test('failed/conflicting saves retain text; replacing the current list is explicit', async ({ page }) => {
  await start(page);
  await prefix(page).hover(); await editButton(page).click();
  await page.getByRole('textbox', { name:'Label 1' }).fill('My edit');
  await page.evaluate(() => {
    window.saveGate = new Promise(resolve => { window.releaseSave = resolve; });
    window.saveError='This list changed.';
    window.conflict={address:window.fullAddress, scope:'global',labels:['Newer name'],version:'two'};
  });
  await page.getByRole('button', { name:'Save', exact:true }).click();
  await expect(page.getByRole('textbox', { name:'Label 1' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Move down 1' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Remove name 1' })).toBeDisabled();
  await page.evaluate(() => window.releaseSave());
  await expect(page.locator('.conflict')).toContainText('Newer name');
  await expect(page.getByRole('textbox', { name:'Label 1' })).toHaveValue('My edit');
  await expect(page.getByRole('textbox', { name:'Label 1' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name:'Move up 1' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Move down 1' })).toBeEnabled();
  await expect(page.getByRole('button', { name:'Move up 2' })).toBeEnabled();
  await expect(page.getByRole('button', { name:'Move down 2' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Remove name 1' })).toBeEnabled();
  await page.getByRole('button', { name:'Keep my labels' }).click();
  await page.evaluate(() => { window.saveError=null; });
  await page.getByRole('button', { name:'Save', exact:true }).click();
  expect(await page.evaluate(() => window.saves[1].version)).toBe('two');
});

test('empty/loading/stale/unknown network/native prefix remain conservative', async ({ page }) => {
  await start(page, { html:'<header></header><main></main>' });
  expect(await page.evaluate(() => window.controller.health.status)).toBe('ready');
  await expect(page.locator('[data-0xlabel-address]')).toHaveCount(0);
  await page.evaluate(() => { window.controller.stop(); });
  await start(page, { html:`<style>#native::before{content:"Native"}</style><p id="native">${address}</p><p id="normal">${address}</p><table><tbody><tr><td id="cell">${address}</td></tr></tbody></table><p>0xabab…abab</p>`, site:'https://other.example' });
  await expect(page.locator('#native')).not.toHaveAttribute('data-0xlabel-label');
  await expect(page.locator('#normal')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(page.locator('#normal')).toHaveAttribute('data-0xlabel-address', address);
  await page.evaluate(() => window.controller.retry());
  await expect(page.locator('#cell')).toHaveAttribute('data-0xlabel-label', 'Treasury');
  await expect(page.locator('#cell')).toHaveText(address);
  await page.evaluate(() => window.controller.stop());
  await expect(page.locator('[data-0xlabel-edit]')).toHaveCount(0);
  await expect(page.locator('#cell')).toHaveText(address);
});
