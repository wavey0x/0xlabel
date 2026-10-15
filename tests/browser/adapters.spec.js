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

    test('tags a canonical display with the address it actually names', async ({ page }) => {
      await open(page, site.canonical('subject'));
      await expect(page.locator('#subject')).toHaveAttribute('data-0xtagger-address', address);
      await expect(page.locator('#subject')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    });

    test('never establishes identity from an abbreviation alone', async ({ page }) => {
      await open(page, site.fragment('subject'));
      await expect(page.locator('#subject')).not.toHaveAttribute('data-0xtagger-address');
    });

    test('disqualifies contradictory evidence without costing the page its tags', async ({ page }) => {
      await open(page, site.conflict('subject') + site.canonical('sound'));
      expect(await health(page)).toMatchObject({ status: 'ready' });
      await expect(page.locator('#subject')).not.toHaveAttribute('data-0xtagger-address');
      await expect(page.locator('#sound')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    });

    test('invalid links do not disable sound address annotations', async ({ page }) => {
      const href = `http://[/address/${address}`;
      await open(page, `<a id="invalid" href="${href}">${address}</a>` + site.canonical('sound'));
      expect(await health(page)).toMatchObject({ status: 'ready' });
      for (const id of ['invalid', 'sound']) {
        await expect(page.locator('#' + id)).toHaveAttribute('data-0xtagger-address', address);
        await expect(page.locator('#' + id)).toHaveAttribute('data-0xtagger-tag', 'Treasury');
      }
      await expect(page.locator('#invalid')).toHaveAttribute('href', href);
      await expect(page.locator('#invalid')).toHaveText(address);
    });

    // The controller's invalidation depends on this: it finds an affected
    // ancestor with a single closest(), so a nested pair would strand a tag.
    test('never annotates one element inside another, through re-rendering', async ({ page }) => {
      await open(page, site.nested('subject'));
      const survey = () => page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-0xtagger-address]')];
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
      await expect(page.locator('[data-0xtagger-address],[data-0xtagger-tag]')).toHaveCount(0);
    });

    test('removes every trace of itself when stopped', async ({ page }) => {
      await open(page, site.canonical('subject'));
      await expect(page.locator('#subject')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
      await page.evaluate(() => window.controller.stop());
      await expect(page.locator('[data-0xtagger-address],[data-0xtagger-tag],[data-0xtagger-ui]')).toHaveCount(0);
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

  test('tags the headerless transfer table from canonical row identities and the explorer chain', async ({ page }) => {
    await start(page, { site, html: table, framed: true, records: [record,
      { ...record, scope: 'eip155:1', tags: ['Ethereum treasury'] },
      { ...record, address: other, tags: ['Sender'] },
    ] });
    expect(await reported(page)).toMatchObject({ adapter: 'Etherscan', status: 'ready', network: 'eip155:1' });
    await expect(page.locator('#from')).toHaveAttribute('data-0xtagger-tag', 'Sender');
    await expect(page.locator('#from')).toHaveAttribute('href', `/address/${other}#tokentxns`);
    await expect(page.locator('#from')).toHaveAttribute('target', '_parent');
    await expect(page.locator('#from')).toHaveText('0xcdcd…cdcd');
    await expect(page.locator('#to')).toHaveAttribute('data-0xtagger-address', address);
    await expect(page.locator('#to')).toHaveAttribute('data-0xtagger-tag', 'Ethereum treasury');
    await expect(page.locator('#to')).toHaveText('BuilderNet');
  });

  test('an embedded view still requires a table, and a page of its own still requires landmarks', async ({ page }) => {
    await start(page, { site, html: '<p>Unavailable</p>', framed: true });
    await expect.poll(() => health(page)).toMatchObject({ status: 'stale' });
    await expect(page.locator('[data-0xtagger-address]')).toHaveCount(0);
    // The same table, in a document nothing embedded: an explorer page that has
    // lost its landmarks is an explorer we no longer read, not a frame.
    await start(page, { site: 'https://etherscan.io/accounts', html: table });
    await expect.poll(() => health(page)).toMatchObject({ status: 'stale' });
    await expect(page.locator('[data-0xtagger-address]')).toHaveCount(0);
  });

  test('a token page tags the table it embeds, whatever that frame is called', async ({ page }) => {
    for (const frame of ['/token/generic-tokentxns2?a=' + address, '/address-tokenpage?a=' + address, '/whatever-they-rename-it-to']) {
      await start(page, { site: `https://etherscan.io${frame}`, html: table, framed: true,
        records: [{ ...record, address: other, tags: ['Sender'] }] });
      expect(await reported(page), frame).toMatchObject({ status: 'ready' });
      await expect(page.locator('#from')).toHaveAttribute('data-0xtagger-tag', 'Sender');
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
      await expect(page.locator('#' + id)).toHaveAttribute('data-0xtagger-address', address);
      await expect(page.locator('#' + id)).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    }
    for (const id of ['fragment', 'prose', 'long']) {
      await expect(page.locator('#' + id)).not.toHaveAttribute('data-0xtagger-address');
    }
    await expect(page.locator('#uppercase')).toHaveText(address.toUpperCase());
    await expect(page.locator('#prefix')).toHaveText(address.toUpperCase());
    await expect(page.locator('#split')).toHaveText(address);
  });

  test('updates split address identity when the website replaces its text', async ({ page }) => {
    await start(page, { site: 'https://plain.example/wallets',
      records: [record, { ...record, address: other, tags: ['Other wallet'] }],
      html: `<main><span id="subject"></span></main><script>
      document.querySelector('#subject').append(document.createTextNode('0x'), document.createTextNode('${address.slice(2)}'));
      </script>`,
    });
    const subject = page.locator('#subject');
    await expect(subject).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    await subject.evaluate((element, other) => { element.lastChild.data = other.slice(2); }, other);
    await expect(subject).toHaveAttribute('data-0xtagger-address', other);
    await expect(subject).toHaveAttribute('data-0xtagger-tag', 'Other wallet');
    await expect(subject).toHaveText(other);
    expect(await health(page)).toMatchObject({ status: 'ready' });
  });
});

// Safe sets the name in a box of its own above the address, and sometimes puts
// a badge beside it saying which of its books the name came from. Replacing the
// name rather than the address is what keeps one name to a widget; leaving the
// badge there would have the page vouching for our wording.
test.describe('Safe address widget', () => {
  const site = `https://app.safe.global/settings/setup?safe=eth:${other}`;
  const widget = ({ name = 'dudesahn', link = true, shown = `0xabab…abab`, href = '/home?safe=eth:' + other } = {}) =>
    `<div class="SrcEthHashInfo_container__h">
      <div class="SrcEthHashInfo_avatarContainer__h"></div>
      <div>
        ${name ? `<div title="${name}" class="ethHashInfo-name flex items-center">
          ${href ? `<a id="name" href="${href}">${name}</a>` : `<div id="name">${name}</div>`}
          <span id="badge"><svg aria-hidden="true" width="20" height="20"></svg></span>
        </div>` : ''}
        <div class="SrcEthHashInfo_addressContainer__h">
          <b>eth:</b><span id="addr">${shown}</span>
          ${link ? `<a id="explorer" href="https://etherscan.io/address/${address}">open</a>` : ''}
        </div>
      </div>
    </div>`;
  const open = (page, html) => start(page, { site, html: `<header>Safe</header><main>${html}</main>` });

  // The name is wrapped in a link, and a display holding a link is disqualified:
  // matching the name's own box rather than the box Safe groups it in is the
  // whole difference between this working and silently doing nothing.
  test('tags the name beside the address, through the link Safe wraps it in', async ({ page }) => {
    await open(page, widget());
    await expect(page.locator('#name')).toHaveAttribute('data-0xtagger-address', address);
    await expect(page.locator('#name')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    await expect(page.locator('#name')).toHaveText('dudesahn');
    await expect(page.locator('#name')).toHaveAttribute('href', `/home?safe=eth:${other}`);
  });

  test('tags a plain name box the same way', async ({ page }) => {
    await open(page, widget({ href: '' }));
    await expect(page.locator('#name')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  });

  // One name to a widget: the address below the replaced name stays an address.
  test('leaves the address alone where the name carries the tag', async ({ page }) => {
    await open(page, widget());
    await expect(page.locator('#addr')).not.toHaveAttribute('data-0xtagger-tag', /./);
    await expect(page.locator('#addr')).toHaveText('0xabab…abab');
    await expect(page.locator('[data-0xtagger-tag]')).toHaveCount(1);
  });

  // The badge claims the name came from one of Safe's own books. While a tag
  // stands in its place that claim is false, so it goes — and comes back.
  test('hides Safe\'s name-origin badge only while a tag stands in for the name', async ({ page }) => {
    await open(page, widget());
    await expect(page.locator('#badge')).toBeHidden();
    await page.evaluate(() => window.controller.stop());
    await expect(page.locator('#badge')).toBeVisible();
    await expect(page.locator('#name')).toHaveText('dudesahn');
  });

  // Nothing proves which wallet an abbreviation belongs to, so a widget with no
  // explorer link names nobody — and must not take the address down with it.
  test('an unprovable widget tags nothing, and a full address still tags', async ({ page }) => {
    await open(page, widget({ link: false }));
    await expect(page.locator('[data-0xtagger-address]')).toHaveCount(0);
    await open(page, widget({ link: false, shown: address }));
    await expect(page.locator('#addr')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  });

  // A widget Safe renders without a name is still an address to tag.
  test('a widget with no name tags its address', async ({ page }) => {
    await open(page, widget({ name: '' }));
    await expect(page.locator('#addr')).toHaveAttribute('data-0xtagger-address', address);
    await expect(page.locator('#addr')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
  });
});

// Safe keeps its own address book in site storage. It is read when someone
// asks to import it and at no other time — never while reading the page, and
// never on a website whose adapter keeps nothing.
test.describe('importing the names a website keeps', () => {
  const book = { 1: { [address]: 'Treasury', [other]: 'dudesahn' },
    8453: { [address]: 'Base treasury' }, nonsense: { [address]: 'Ignored' } };
  const watched = `<script>
    window.storageReads = 0;
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) { window.storageReads += 1; return read.call(this, key); };
    localStorage.setItem('SAFE_v2__addressBook', ${JSON.stringify(JSON.stringify(book))});
  </script><header>Safe</header><main><a id="row" href="/address/${address}">${address}</a></main>`;

  test('reads Safe\'s book only when asked, and only what is a name for a wallet', async ({ page }) => {
    await start(page, { site: `https://app.safe.global/home?safe=eth:${other}`, html: watched });
    await expect(page.locator('#row')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    // Reading the page never touches the website's own storage.
    expect(await page.evaluate(() => window.storageReads)).toBe(0);

    const found = await page.evaluate(() => window.controller.harvest());
    expect(await page.evaluate(() => window.storageReads)).toBeGreaterThan(0);
    expect(found).toEqual([
      { address, scope: 'eip155:1', tags: ['Treasury'], source: 'safe:address-book' },
      { address: other, scope: 'eip155:1', tags: ['dudesahn'], source: 'safe:address-book' },
      { address, scope: 'eip155:8453', tags: ['Base treasury'], source: 'safe:address-book' },
    ]);
  });

  test('a website that keeps no book of its own offers nothing', async ({ page }) => {
    await start(page, { site: 'https://etherscan.io/accounts', html: watched });
    expect(await page.evaluate(() => window.controller.harvest())).toEqual([]);
    expect(await page.evaluate(() => window.storageReads)).toBe(0);
  });

  test('a book that is not a book at all reads as nothing', async ({ page }) => {
    const broken = `<script>localStorage.setItem('SAFE_v2__addressBook', 'not json');</script>
      <header>Safe</header><main><a id="row" href="/address/${address}">${address}</a></main>`;
    await start(page, { site: `https://app.safe.global/home?safe=eth:${other}`, html: broken });
    await expect(page.locator('#row')).toHaveAttribute('data-0xtagger-tag', 'Treasury');
    expect(await page.evaluate(() => window.controller.harvest())).toEqual([]);
  });
});
