import { test, expect } from '@playwright/test';
import { address, other, record, start, health, reported } from './controller.js';

// Every registered adapter owes the same guarantees, whatever site it reads.
// Adding a website means adding an entry here beside its entry in adapters.js:
// if a site cannot satisfy these, its adapter is not safe to ship.
//
//   canonical  a display whose identity is beyond doubt
//   fragment   an abbreviated display with no canonical source behind it
//   conflict   a display whose sources name two different wallets
//   nested     a display wrapped in another candidate, where one must win
const sites = [
  {
    id: 'Etherscan', url: 'https://etherscan.io/accounts', network: 'eip155:1',
    frame: body => `<header>Explorer</header><main>${body}</main>`,
    canonical: id => `<a id="${id}" href="/address/${address}">${address}</a>`,
    fragment: id => `<a id="${id}" href="/address/">0xabab…abab</a>`,
    conflict: id => `<a id="${id}" href="/address/${other}" data-full-address="${address}">${address}</a>`,
    nested: id => `<a id="${id}" href="/address/${address}"><span class="hash-tag">Treasury wallet</span></a>`,
  },
  {
    id: 'Safe', url: `https://app.safe.global/home?safe=eth:${address}`, network: 'eip155:1',
    frame: body => `<header>Safe</header><main>${body}</main>`,
    canonical: id => `<a id="${id}" href="/address/${address}">${address}</a>`,
    fragment: id => `<a id="${id}" href="/address/">0xabab…abab</a>`,
    conflict: id => `<a id="${id}" href="/address/${other}" data-address="${address}">${address}</a>`,
    nested: id => `<a id="${id}" href="/address/${address}"><span>${address}</span></a>`,
  },
  {
    id: 'This site', url: 'https://plain.example/wallets', network: undefined,
    frame: body => `<main>${body}</main>`,
    canonical: id => `<p id="${id}">${address}</p>`,
    fragment: id => `<p id="${id}">0xabab…abab</p>`,
    conflict: id => `<a id="${id}" href="/address/${other}">${address}</a>`,
    nested: id => `<div id="${id}"><p>${address}</p></div>`,
  },
];

for (const site of sites) {
  const open = (page, body) => start(page, { site: site.url, html: site.frame(body) });

  test.describe(site.id, () => {
    test('claims its pages and names only a chain the URL establishes', async ({ page }) => {
      await open(page, site.canonical('subject'));
      expect(await reported(page)).toMatchObject({ adapter: site.id, status: 'ready' });
      expect((await health(page)).network).toBe(site.network);
    });

    test('labels a canonical display with the address it actually names', async ({ page }) => {
      await open(page, site.canonical('subject'));
      await expect(page.locator('#subject')).toHaveAttribute('data-0xlabel-address', address);
      await expect(page.locator('#subject')).toHaveAttribute('data-0xlabel-label', 'Treasury');
    });

    test('never establishes identity from an abbreviation alone', async ({ page }) => {
      await open(page, site.fragment('subject'));
      await expect(page.locator('#subject')).not.toHaveAttribute('data-0xlabel-address');
    });

    test('disqualifies contradictory evidence without costing the page its tags', async ({ page }) => {
      await open(page, site.conflict('subject') + site.canonical('sound'));
      expect(await health(page)).toMatchObject({ status: 'ready' });
      await expect(page.locator('#subject')).not.toHaveAttribute('data-0xlabel-address');
      await expect(page.locator('#sound')).toHaveAttribute('data-0xlabel-label', 'Treasury');
    });

    test('invalid links do not disable sound address annotations', async ({ page }) => {
      const href = `http://[/address/${address}`;
      await open(page, `<a id="invalid" href="${href}">${address}</a>` + site.canonical('sound'));
      expect(await health(page)).toMatchObject({ status: 'ready' });
      for (const id of ['invalid', 'sound']) {
        await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-address', address);
        await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-label', 'Treasury');
      }
      await expect(page.locator('#invalid')).toHaveAttribute('href', href);
      await expect(page.locator('#invalid')).toHaveText(address);
    });

    // The controller's invalidation depends on this: it finds an affected
    // ancestor with a single closest(), so a nested pair would strand a label.
    test('never annotates one element inside another, through re-rendering', async ({ page }) => {
      await open(page, site.nested('subject'));
      const survey = () => page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-0xlabel-address]')];
        return { total: all.length, nested: all.filter(a => all.some(b => b !== a && b.contains(a))).length };
      });
      expect(await survey()).toEqual({ total: 1, nested: 0 });
      // Re-render the row the way a live table does.
      await page.locator('#subject').evaluate(element => element.append(document.createElement('i')));
      await expect.poll(survey).toEqual({ total: 1, nested: 0 });
    });

    test('leaves editable and interactive content alone', async ({ page }) => {
      await open(page, `<input value="${address}"><button id="pressable">${address}</button>
        <div contenteditable="true">${address}</div><span aria-hidden="true">${address}</span>`);
      await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label]')).toHaveCount(0);
    });

    test('removes every trace of itself when stopped', async ({ page }) => {
      await open(page, site.canonical('subject'));
      await expect(page.locator('#subject')).toHaveAttribute('data-0xlabel-label', 'Treasury');
      await page.evaluate(() => window.controller.stop());
      await expect(page.locator('[data-0xlabel-address],[data-0xlabel-label],[data-0xlabel-ui]')).toHaveCount(0);
      await expect(page.locator('#subject')).toHaveText(address);
    });
  });
}

// A table an explorer embeds is a frame of its own: rows, and none of the
// landmarks the page around it has. The frame's URL is the explorer's business.
test.describe('Etherscan embedded transfers', () => {
  const site = `https://etherscan.io/token/generic-tokentxns2?contractAddress=${other}&a=${address}`;
  const table = `<div class="table-responsive"><table><tbody><tr>
    <td><a id="from" class="hash-tag" href="/address/${other}#tokentxns" target="_parent"
      data-highlight-target="${other}" data-full-address="${other}">0xcdcd…cdcd</a></td>
    <td><span id="to" class="hash-tag" data-highlight-target="${address}">BuilderNet</span></td>
  </tr></tbody></table></div>`;

  test('labels the headerless transfer table from canonical row identities and the explorer chain', async ({ page }) => {
    await start(page, { site, html: table, framed: true, records: [record,
      { ...record, scope: 'eip155:1', labels: ['Ethereum treasury'] },
      { ...record, address: other, labels: ['Sender'] },
    ] });
    expect(await reported(page)).toMatchObject({ adapter: 'Etherscan', status: 'ready', network: 'eip155:1' });
    await expect(page.locator('#from')).toHaveAttribute('data-0xlabel-label', 'Sender');
    await expect(page.locator('#from')).toHaveAttribute('href', `/address/${other}#tokentxns`);
    await expect(page.locator('#from')).toHaveAttribute('target', '_parent');
    await expect(page.locator('#from')).toHaveText('0xcdcd…cdcd');
    await expect(page.locator('#to')).toHaveAttribute('data-0xlabel-address', address);
    await expect(page.locator('#to')).toHaveAttribute('data-0xlabel-label', 'Ethereum treasury');
    await expect(page.locator('#to')).toHaveText('BuilderNet');
  });

  test('an embedded view still requires a table, and a page of its own still requires landmarks', async ({ page }) => {
    await start(page, { site, html: '<p>Unavailable</p>', framed: true });
    await expect.poll(() => health(page)).toMatchObject({ status: 'stale' });
    await expect(page.locator('[data-0xlabel-address]')).toHaveCount(0);
    // The same table, in a document nothing embedded: an explorer page that has
    // lost its landmarks is an explorer we no longer read, not a frame.
    await start(page, { site: 'https://etherscan.io/accounts', html: table });
    await expect.poll(() => health(page)).toMatchObject({ status: 'stale' });
    await expect(page.locator('[data-0xlabel-address]')).toHaveCount(0);
  });

  test('a token page labels the table it embeds, whatever that frame is called', async ({ page }) => {
    for (const frame of ['/token/generic-tokentxns2?a=' + address, '/address-tokenpage?a=' + address, '/whatever-they-rename-it-to']) {
      await start(page, { site: `https://etherscan.io${frame}`, html: table, framed: true,
        records: [{ ...record, address: other, labels: ['Sender'] }] });
      expect(await reported(page), frame).toMatchObject({ status: 'ready' });
      await expect(page.locator('#from')).toHaveAttribute('data-0xlabel-label', 'Sender');
    }
  });
});

test.describe('Generic address text', () => {
  test('recognizes whole addresses regardless of casing or adjacent text boundaries', async ({ page }) => {
    await start(page, { site: 'https://plain.example/wallets', html: `<main>
      <span id="uppercase">${address.toUpperCase()}</span><span id="prefix"></span><span id="split"></span>
      <span id="fragment">0xabab…abab</span><span id="prose">Wallet: ${address}</span><span id="long">${address}ab</span>
      </main><script>
      document.querySelector('#prefix').append(document.createTextNode('0'), document.createComment('framework boundary'), document.createTextNode('${address.slice(1).toUpperCase()}'));
      document.querySelector('#split').append(document.createTextNode('${address.slice(0, 21)}'), document.createTextNode('${address.slice(21)}'));
      </script>` });
    for (const id of ['uppercase', 'prefix', 'split']) {
      await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-address', address);
      await expect(page.locator('#' + id)).toHaveAttribute('data-0xlabel-label', 'Treasury');
    }
    for (const id of ['fragment', 'prose', 'long']) {
      await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xlabel-address');
    }
    await expect(page.locator('#uppercase')).toHaveText(address.toUpperCase());
    await expect(page.locator('#prefix')).toHaveText(address.toUpperCase());
    await expect(page.locator('#split')).toHaveText(address);
  });

  test('updates split address identity when the website replaces its text', async ({ page }) => {
    await start(page, { site: 'https://plain.example/wallets',
      records: [record, { ...record, address: other, labels: ['Other wallet'] }],
      html: `<main><span id="subject"></span></main><script>
      document.querySelector('#subject').append(document.createTextNode('0x'), document.createTextNode('${address.slice(2)}'));
      </script>`,
    });
    const subject = page.locator('#subject');
    await expect(subject).toHaveAttribute('data-0xlabel-label', 'Treasury');
    await subject.evaluate((element, other) => { element.lastChild.data = other.slice(2); }, other);
    await expect(subject).toHaveAttribute('data-0xlabel-address', other);
    await expect(subject).toHaveAttribute('data-0xlabel-label', 'Other wallet');
    await expect(subject).toHaveText(other);
    expect(await health(page)).toMatchObject({ status: 'ready' });
  });
});
