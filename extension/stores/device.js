import { findRecord, recordKey, validateSnapshot } from '../shared.js';

// The simplest book there is. It lives in this browser profile, nothing else
// writes to it, and a save is one atomic write. No server, no account, no setup.
//
// A book is kept in pages, one per leading byte of the address, so saving a
// name rewrites one page rather than the whole book. The address names its own
// page: there is no index to keep and nothing to rebalance, and anyone reading
// the stored data can tell where a record lives by looking at it. Addresses are
// hashes, so the pages fill evenly on their own.
const PAGES = 256;
export const deviceKeys = book =>
  Array.from({ length: PAGES }, (_, index) => `book:${book}/${index.toString(16).padStart(2, '0')}`);

export function createDeviceBook({ storage, book, now = Date.now }) {
  const pageName = address => `book:${book}/${address.slice(2, 4)}`;
  // A version only has to differ from the one before it. Counting forward from
  // the clock keeps two saves within the same millisecond apart.
  let last = 0;
  const stamp = () => { last = Math.max(now(), last + 1); return last.toString(36); };

  // A page that cannot be read is never treated as an empty page, because the
  // next save would write that emptiness over whatever is really there.
  async function readPage(name) {
    const held = (await storage.get(name))[name];
    return held === undefined ? [] : validateSnapshot({ records: held });
  }
  async function writePage(name, records) {
    if (records.length) await storage.set({ [name]: records });
    else await storage.remove(name);
  }
  function replace(page, { address, scope, labels }) {
    const rest = page.filter(entry => entry.address !== address || entry.scope !== scope);
    const saved = labels.length ? { address, scope, labels, version: stamp() } : null;
    return [saved ? [...rest, saved] : rest, saved];
  }

  return {
    // Nothing else writes this book, so there is never a cheaper answer than
    // reading it: it has no mark to compare against.
    async load() {
      const held = await storage.get(deviceKeys(book));
      const records = [];
      for (const page of Object.values(held)) {
        if (!Array.isArray(page)) throw new Error('This address book could not be read.');
        for (const record of page) records.push(record);
      }
      // Validated whole: one address held twice, in two pages, is caught here.
      return { records: validateSnapshot({ records }), mark: null };
    },
    async put({ address, scope, labels, version }) {
      const name = pageName(address);
      const page = await readPage(name);
      const existing = findRecord(page, address, scope);
      if ((existing?.version ?? null) !== version) {
        const conflict = new Error('Saved elsewhere while you were editing.');
        conflict.status = 409;
        conflict.current = existing;
        throw conflict;
      }
      const [next, saved] = replace(page, { address, scope, labels });
      await writePage(name, next);
      return saved;
    },
    // Many records at once, grouped so that a page is read and written once
    // however many of them land in it. Their versions were settled by the
    // caller: this is the path a file takes, not the one an editor takes.
    async putMany(wanted) {
      const byPage = new Map();
      for (const record of wanted) {
        const name = pageName(record.address);
        if (!byPage.has(name)) byPage.set(name, []);
        byPage.get(name).push(record);
      }
      const saved = new Map();
      for (const [name, records] of byPage) {
        let page = await readPage(name);
        for (const record of records) {
          const [next, result] = replace(page, record);
          page = next;
          saved.set(recordKey(record.address, record.scope), result);
        }
        await writePage(name, page);
      }
      return wanted.map(record => saved.get(recordKey(record.address, record.scope)));
    },
  };
}
