import { test, expect } from '@playwright/test';
import { address, other, start, health, reported } from './controller.js';

// Every registered adapter owes the same guarantees, whatever site it reads.
// Adding a website means adding an entry here beside its entry in adapters.js:
// if a site cannot satisfy these, its adapter is not safe to ship.
//
//   canonical  a display whose identity is beyond doubt
//   fragment   an abbreviated display with no canonical source behind it
//   conflict   a display whose sources name two different wallets
const sites = [
  {
    id: 'Etherscan', url: 'https://etherscan.io/accounts', network: 'eip155:1',
    frame: body => `<header>Explorer</header><main>${body}</main>`,
    canonical: id => `<a id="${id}" href="/address/${address}">${address}</a>`,
    fragment: id => `<a id="${id}" href="/address/">0xabab…abab</a>`,
    conflict: id => `<a id="${id}" href="/address/${other}" data-full-address="${address}">${address}</a>`,
  },
  {
    id: 'Safe', url: `https://app.safe.global/home?safe=eth:${address}`, network: 'eip155:1',
    frame: body => `<header>Safe</header><main>${body}</main>`,
    canonical: id => `<a id="${id}" href="/address/${address}">${address}</a>`,
    fragment: id => `<a id="${id}" href="/address/">0xabab…abab</a>`,
    conflict: id => `<a id="${id}" href="/address/${other}" data-address="${address}">${address}</a>`,
  },
  {
    id: 'This site', url: 'https://plain.example/wallets', network: undefined,
    frame: body => `<main>${body}</main>`,
    canonical: id => `<p id="${id}">${address}</p>`,
    fragment: id => `<p id="${id}">0xabab…abab</p>`,
    conflict: id => `<a id="${id}" href="/address/${other}">${address}</a>`,
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
