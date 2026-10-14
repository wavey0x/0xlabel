import { findRecord, normalizeLabels, normalizeScope, parseAddress, validateSnapshot } from './shared.js';
import { createDeviceBook } from './stores/device.js';
import { createServerBook } from './stores/server.js';

const MAX_NAME = 40;
const recordsKey = id => `book:${id}`;
const cacheKey = id => `cache:${id}`;

// Books are named things people switch between. Where a book is kept is a
// property of that book, chosen once when it is made, so nothing below ever
// moves a book: switching is only ever switching.
export function createStore({ storage, fetch: fetcher, notify = () => {}, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let books = [];
  let active = null;
  let book = null;
  let records = [];
  let syncedAt = null;
  let error = null;
  let revision = 0;
  let needsRefresh = false;
  let queue = Promise.resolve();
  let pull = null;

  const entry = id => books.find(item => item.id === id);
  const transport = item => item.storage.kind === 'server'
    ? createServerBook({ url: item.storage.url, token: item.storage.token, fetch: fetcher })
    : createDeviceBook({ storage, key: recordsKey(item.id), now });

  function cleanName(value, fallback) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    return name || fallback;
  }
  // Tokens stay in this worker. Nothing here ever reaches a content script.
  function state() {
    const current = entry(active);
    return {
      books: books.map(item => ({ id: item.id, name: item.name,
        where: item.storage.kind === 'server' ? new URL(item.storage.url).hostname : 'On this device' })),
      activeBook: active, bookName: current?.name || '', bookKind: current?.storage.kind || 'device',
      records, stateRevision: revision, syncedAt, error,
    };
  }
  function changed() { revision++; notify(state()); }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function saveBooks() { await storage.set({ books, activeBook: active }); }
  async function cache() {
    if (entry(active)?.storage.kind === 'server') await storage.set({ [cacheKey(active)]: { records, syncedAt } });
  }

  async function open(id) {
    const item = entry(id);
    active = id;
    book = transport(item);
    error = null;
    needsRefresh = false;
    if (item.storage.kind === 'server') {
      const saved = (await storage.get(cacheKey(id)))[cacheKey(id)];
      try {
        records = validateSnapshot({ records: saved?.records || [] });
        syncedAt = saved?.syncedAt || null;
      } catch { records = []; syncedAt = null; }
    } else {
      syncedAt = null;
      try { records = await book.load(); } catch (failure) { records = []; error = failure.message; }
    }
  }

  async function init() {
    const saved = await storage.get(['books', 'activeBook']);
    books = Array.isArray(saved.books) ? saved.books.filter(item => item?.id && item?.name && item?.storage?.kind) : [];
    if (!books.length) {
      // Everyone starts with a book, so labeling works before anything is set up.
      books = [{ id: uuid(), name: 'My addresses', storage: { kind: 'device' } }];
      active = books[0].id;
      await saveBooks();
    }
    await open(entry(saved.activeBook) ? saved.activeBook : books[0].id);
    revision++;
  }

  function refresh() {
    const started = active;
    if (pull && pull.book === started) return pull.promise;
    const promise = serial(async () => {
      if (active !== started) return state();
      try {
        const next = await book.load();
        if (active !== started) return state();
        records = next;
        if (entry(active).storage.kind === 'server') syncedAt = now();
        error = null;
        needsRefresh = false;
        await cache();
      } catch (failure) {
        error = failure.message;
      }
      changed();
      return state();
    });
    pull = { book: started, promise };
    promise.finally(() => { if (pull?.promise === promise) pull = null; }).catch(() => {});
    return promise;
  }

  function use(id) {
    return serial(async () => {
      if (!entry(id)) throw new Error('That address book is gone.');
      await open(id);
      await saveBooks();
      changed();
      return state();
    });
  }

  // Making a book is the only moment its storage is chosen, and the only moment
  // one book's addresses are ever copied into another.
  async function add({ name, storage: where, copyFrom }) {
    if (!where || (where.kind !== 'device' && where.kind !== 'server')) throw new Error('Choose where to keep this book.');
    if (where.kind === 'server' && (!where.url || !where.token)) throw new Error('Paste the link your server printed.');
    if (books.length >= 20) throw new Error('That is as many address books as 0xlabel keeps.');
    return serial(async () => {
      const item = { id: uuid(), name: '', storage: where };
      item.name = cleanName(name, where.kind === 'server' ? new URL(where.url).hostname : 'New book');
      const candidate = transport(item);
      const found = await candidate.load();
      if (copyFrom && found.length) throw new Error('That server already holds a book, so nothing was copied into it.');
      if (copyFrom) {
        const source = entry(copyFrom);
        if (!source) throw new Error('There is nothing to copy.');
        const taken = source.id === active ? records : await transport(source).load();
        for (const label of taken) await candidate.put({ ...label, version: null });
      }
      books = [...books, item];
      active = item.id;
      book = candidate;
      error = null;
      needsRefresh = false;
      // The new book was just read to make it; reading it again proves nothing.
      records = copyFrom ? await candidate.load() : found;
      syncedAt = item.storage.kind === 'server' ? now() : null;
      await saveBooks();
      await cache();
      changed();
      return state();
    });
  }

  function rename(id, name) {
    return serial(async () => {
      const item = entry(id);
      if (!item) throw new Error('That address book is gone.');
      item.name = cleanName(name, item.name);
      await saveBooks();
      changed();
      return state();
    });
  }

  // Forgetting a server book leaves the server holding it. Removing a book kept
  // on this device is the only way addresses are deleted here, so callers say so.
  function remove(id) {
    return serial(async () => {
      const item = entry(id);
      if (!item) throw new Error('That address book is gone.');
      if (books.length === 1) throw new Error('0xlabel keeps at least one address book.');
      books = books.filter(other => other.id !== id);
      await storage.remove([recordsKey(id), cacheKey(id)]);
      await saveBooks();
      if (active === id) await open(books[0].id);
      changed();
      return state();
    });
  }

  async function save(draft) {
    if (draft.book !== active) throw new Error('You switched address books. Close this editor and try again.');
    const address = parseAddress(draft.address);
    if (!address) throw new Error('Use a full Ethereum address.');
    const scope = normalizeScope(draft.scope);
    const labels = normalizeLabels(draft.labels);
    const version = draft.version;
    if (!(version === null || typeof version === 'string')) throw new Error('Refresh this record before saving.');
    const started = active;
    return serial(async () => {
      if (active !== started) throw new Error('You switched address books before this was saved. Try again.');
      // A write that may already have landed is checked, never simply repeated.
      if (book.uncertainWrites && needsRefresh) {
        records = await book.load();
        syncedAt = now();
        needsRefresh = false;
        await cache();
        const latest = findRecord(records, address, scope);
        if ((latest?.version || null) !== version) {
          const conflict = new Error('The previous save may have completed. Review the current list before saving again.');
          conflict.current = latest;
          conflict.status = 409;
          changed();
          throw conflict;
        }
      }
      if (book.uncertainWrites) { needsRefresh = true; await storage.set({ needsRefresh: true }); }
      let saved;
      try {
        saved = await book.put({ address, scope, labels, version });
      } catch (failure) {
        if (failure.status === 409) {
          if (failure.current && (failure.current.address !== address || failure.current.scope !== scope)) {
            throw new Error('A conflict came back for a different record. Refresh before trying again.');
          }
          records = records.filter(item => item.address !== address || item.scope !== scope);
          if (failure.current) records.push(failure.current);
          needsRefresh = false;
          await cache();
          changed();
        } else if (failure.status && failure.status < 500) {
          needsRefresh = false;
        }
        throw failure;
      }
      records = records.filter(item => item.address !== address || item.scope !== scope);
      if (saved) records.push(saved);
      error = null;
      needsRefresh = false;
      await cache();
      changed();
      return { state: state() };
    });
  }

  return { init, state, use, add, rename, remove, refresh, save };
}
