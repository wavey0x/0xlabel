import { test, expect } from '@playwright/test';
import { address, record, start } from './controller.js';

test.use({ deviceScaleFactor: 2 });

const icon = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill="#087ac8" d="M7 0 14 7 7 14 0 7Z"/></svg>');

// Read only ink inside a fixed page-coordinate clip. The blue-only mode finds
// the site's icon even when the annotation changes the text around it.
async function ink(page, clip, blueOnly = false) {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async ({ png, clip, blueOnly }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let left = image.width, right = -1, bottom = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const at = 4 * (y * image.width + x);
      const r = data[at], g = data[at + 1], b = data[at + 2];
      if (blueOnly ? g > r + 30 && b > g + 20 : r < 245 || g < 245 || b < 245) {
        left = Math.min(left, x); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    const scale = image.width / clip.width;
    return { width: right < 0 ? 0 : (right - left + 1) / scale,
      bottom: bottom < 0 ? null : clip.y + (bottom + 1) / scale };
  }, { png, clip, blueOnly });
}

async function tag(page, name) {
  await page.evaluate(({ record, name }) => window.controller.updateState({ ...window.state,
    stateRevision: window.state.stateRevision + 1, records: [{ ...record, tags: [name] }] }),
  { record, name });
}

// Modelled on etherscan.io/address/0xa3C5A1e09150B75ff251c1a7815A07182c3de2FB,
// contract creator row with an ENS icon inside its address link (2026-10-16).
test('tagging a creator leaves the site icon on its row', async ({ page }) => {
  await start(page, { records: [], html: `<style>body{background:#fff;font:14px/1.5 system-ui,sans-serif}main{margin:80px}main a{color:#111}</style>
    <header>Explorer</header><main><div id="row" style="display:flex;align-items:center;gap:4px">
      <a id="creator" class="hash-tag" href="/address/${address}"><img id="ens" src="${icon}"
        width="14" height="14" style="margin-right:4px">c2tp.eth</a>
      <span>|</span><a href="#">5 hrs 173 min</a></div></main>` });
  const row = await page.locator('#row').boundingBox();
  const clip = { x: row.x - 2, y: row.y - 20, width: row.width + 4, height: row.height + 40 };
  const original = await ink(page, clip, true);
  expect(original.width).toBeGreaterThan(0);
  await tag(page, 'C2tP');
  await expect(page.locator('#creator')).toHaveAttribute('data-0xtagger-tag', 'C2tP');
  expect((await ink(page, clip, true)).bottom).toBe(original.bottom);
});

