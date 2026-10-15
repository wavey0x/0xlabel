// Harness shared by the controller and adapter suites. Uses the shipped
// controller/editor; only the API boundary is replaced here. extension.spec.js
// covers the real worker, storage, messages and HTTP(S) APIs.
export const address = '0x' + 'ab'.repeat(20);
export const other = '0x' + 'cd'.repeat(20);
export const record = { address, scope: 'global', tags: ['Treasury', 'Operations'], version: 'one' };
export const wallets = `<header>Explorer <input id="native-input"></header><main>
  <p><a id="first" href="/address/${address}">${address}</a><button id="native-copy">Copy address</button></p>
  <p><a id="second" href="/address/${other}">${other}</a></p></main>
  <script>document.querySelector('#native-copy').onclick=()=>{window.nativeCopied='${address}';};</script>`;

export async function start(page, { html = wallets, site = 'https://etherscan.io/accounts', records = [record], framed = false } = {}) {
  await page.goto('/tests/fixtures/page.html');
  await page.setContent(html);
  await page.addStyleTag({ url: '/extension/colors.css' });
  await page.addStyleTag({ url: '/extension/page.css' });
  await page.evaluate(async ({ site, records, framed }) => {
    const { createPageController } = await import('/extension/page.js');
    window.site = new URL(site);
    window.state = { books: [{ id: 'book-1', name: 'default', where: 'On this device' }],
      activeBook: 'book-1', bookName: 'default', bookKind: 'device', stateRevision: 1, records };
    window.saves = [];
    window.reports = [];
    window.controller = await createPageController({ state: window.state, url: () => window.site, framed,
      report: value => window.reports.push(value),
      save: async draft => {
        window.saves.push(draft);
        if (window.saveGate) await window.saveGate;
        if (window.saveError) {
          const error = new Error(window.saveError);
          if (window.conflict) { error.status = 409; error.current = window.conflict; }
          throw error;
        }
        const entry = draft.tags.length ? { ...draft, version: 'saved' } : null;
        window.state.records = [...window.state.records.filter(item => item.address !== draft.address || item.scope !== draft.scope), ...(entry ? [entry] : [])];
        window.state.stateRevision += 1;
        window.saveCompleted = true;
        // The worker answers the save, then tells every page what changed —
        // including this one, which is how its own tags come to be repainted.
        const announced = { type: 'Updated', activeBook: window.state.activeBook,
          stateRevision: window.state.stateRevision, syncedAt: null,
          change: { address: draft.address, scope: draft.scope, record: entry } };
        // A page that cannot place the record asks for the book, as it does
        // against the real worker.
        if (!window.controller.patch(announced)) window.controller.updateState(structuredClone(window.state));
        return {};
      },
    });
  }, { site, records, framed });
}

export const edit = (page, index = 0) => page.getByRole('button', { name: 'Edit wallet tags', exact: true }).nth(index);
// The glyph belonging to one address display, wherever it had to be put: beside
// an inline display, inside one that would otherwise push it onto its own line.
export const tagFor = (page, id) => page.locator(`#${id} + [data-0xtagger-edit], #${id} [data-0xtagger-edit]`).getByRole('button');
export const input = page => page.getByRole('textbox', { name: 'Tag 1', exact: true });
export const save = page => page.getByRole('button', { name: 'Save', exact: true });
export const shownAddress = page => page.getByRole('dialog').locator('code');
export const health = page => page.evaluate(() => window.controller.health);
// What the toolbar is told: the controller's own health plus the adapter reading the page.
export const reported = page => page.evaluate(() => window.reports.at(-1));

// WCAG contrast between two resolved CSS colours, for asserting that a tag
// stays legible against the website it is painted on.
export function contrast(a, b) {
  const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = value => {
    const [r, g, b] = channels(value).map(part => {
      const unit = part / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
