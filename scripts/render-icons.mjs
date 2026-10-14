import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

// Chrome's unpacked toolbar icons require PNG. Keep SVG as the editable source.
const source = await readFile(new URL('../extension/icons/book.svg', import.meta.url), 'utf8');
const active = source.replace('id="book"', 'id="book" filter="url(#glow)"').replace('#7e8794', '#249463');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [name, svg, sizes] of [['book', source, [16, 24, 32, 48, 128]], ['book-active', active, [16, 24, 32, 48]]]) {
    for (const size of sizes) {
      const data = await page.evaluate(async ({ svg, size }) => {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { svg, size });
      await writeFile(new URL(`../extension/icons/${name}-${size}.png`, import.meta.url), Buffer.from(data, 'base64'));
    }
  }
} finally { await browser.close(); }
