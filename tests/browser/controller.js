// Harness shared by the controller and adapter suites. Uses the shipped
// controller/editor; only the API boundary is replaced here. extension.spec.js
// covers the real worker, storage, messages and HTTP(S) APIs.
export const address = '0x' + 'ab'.repeat(20);
export const other = '0x' + 'cd'.repeat(20);
export const record = { address, scope: 'global', labels: ['Treasury', 'Operations'], version: 'one' };
export const wallets = `<header>Explorer <input id="native-input"></header><main>
  <p><a id="first" href="/address/${address}">${address}</a><button id="native-copy">Copy address</button></p>
  <p><a id="second" href="/address/${other}">${other}</a></p></main>
  <script>document.querySelector('#native-copy').onclick=()=>{window.nativeCopied='${address}';};</script>`;

export async function start(page, { html = wallets, site = 'https://etherscan.io/accounts', records = [record] } = {}) {
  await page.goto('/tests/fixtures/page.html');
  await page.setContent(html);
  await page.addStyleTag({ url: '/extension/colors.css' });
  await page.addStyleTag({ url: '/extension/page.css' });
  await page.evaluate(async ({ site, records }) => {
    const { createPageController } = await import('/extension/page.js');
    window.site = new URL(site);
    window.state = { connectionKey: 'http://127.0.0.1:8712', connectionName: 'Local', selectionGeneration: 1, stateRevision: 1, records };
    window.saves = [];
    window.reports = [];
    window.controller = await createPageController({ state: window.state, url: () => window.site,
      report: value => window.reports.push(value),
      save: async draft => {
        window.saves.push(draft);
        if (window.saveGate) await window.saveGate;
        if (window.saveError) {
          const error = new Error(window.saveError);
          if (window.conflict) { error.status = 409; error.current = window.conflict; }
          throw error;
        }
        const entry = draft.labels.length ? { ...draft, version: 'saved' } : null;
        window.state.records = [...window.state.records.filter(item => item.address !== draft.address || item.scope !== draft.scope), ...(entry ? [entry] : [])];
        window.saveCompleted = true;
        return { state: structuredClone(window.state) };
      },
    });
  }, { site, records });
}

export const edit = (page, index = 0) => page.getByRole('button', { name: 'Edit wallet labels', exact: true }).nth(index);
export const input = page => page.getByRole('textbox', { name: 'Label 1', exact: true });
export const save = page => page.getByRole('button', { name: 'Save', exact: true });
export const shownAddress = page => page.getByRole('dialog').locator('code');
export const health = page => page.evaluate(() => window.controller.health);
// What the toolbar is told: the controller's own health plus the adapter reading the page.
export const reported = page => page.evaluate(() => window.reports.at(-1));
