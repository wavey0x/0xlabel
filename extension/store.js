import { findRecord, normalizeLabels, normalizeScope, parseAddress, recordKey, sameLabels, sameRecords, validateSnapshot } from './shared.js';
import { createDeviceBook, deviceKeys } from './stores/device.js';
import { createServerBook } from './stores/server.js';

const MAX_NAME = 40;
const cacheKey = id => `cache:${id}`;
// How recently a book kept elsewhere has to have been asked about before asking
// again is worth the round trip. Opening five tabs is not five syncs.
const PULL_FLOOR = 60000;

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
  // A book whose pages could not be read is never saved over: the save would
  // write over names this worker never managed to see.
  let unreadable = false;
  // What the server last said this book was, and when we last asked.
  let mark = null;
  let pulledAt = 0;
  let queue = Promise.resolve();
  let pull = null;

  const entry = id => books.find(item => item.id === id);
  const taken = (name, exceptId) => books.some(item =>
    item.id !== exceptId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  // A name people chose is never altered behind their back; one we chose for
  // them is, because being stopped over a name you never typed is senseless.
  function freeName(candidates) {
    for (const candidate of candidates) if (candidate && !taken(candidate)) return candidate;
    const base = candidates[candidates.length - 1] || 'Address book';
    for (let suffix = 2; ; suffix += 1) if (!taken(`${base} ${suffix}`)) return `${base} ${suffix}`;
  }
  const transport = item => item.storage.kind === 'server'
    ? createServerBook({ url: item.storage.url, token: item.storage.token, fetch: fetcher })
    : createDeviceBook({ storage, book: item.id, now });

  function cleanName(value, fallback) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    return name || fallback;
  }
  // Tokens stay in this worker. Nothing here ever reaches a content script.
  function state() {
    const current = entry(active);
    return {
      books: books.map(item => ({ id: item.id, name: item.name, kind: item.storage.kind,
        where: item.storage.kind === 'server' ? new URL(item.storage.url).hostname : 'On this device' })),
      activeBook: active, bookName: current?.name || '', bookKind: current?.storage.kind || 'device',
      records, stateRevision: revision, syncedAt, error,
    };
  }
  // The revision orders snapshots for every view that holds one. A service
  // worker is torn down whenever it goes idle, so the count belongs to the
  // books in storage: restarting it must not hand out numbers a page has
  // already seen and would therefore discard.
  // A change to one record is announced as that record. Everything else — a
  // book switched, a file carried in, a sync that brought news — is the whole
  // book, because that is genuinely what changed.
  function changed(change = null) {
    revision++;
    storage.set({ stateRevision: revision }).catch(() => {});
    notify(state(), change);
  }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function saveBooks() { await storage.set({ books, activeBook: active }); }
  async function cache() {
    if (entry(active)?.storage.kind === 'server') await storage.set({ [cacheKey(active)]: { records, syncedAt, mark } });
  }

  async function open(id) {
    const item = entry(id);
    active = id;
    book = transport(item);
    error = null;
    needsRefresh = false;
    unreadable = false;
    mark = null;
    pulledAt = 0;
    if (item.storage.kind === 'server') {
      const saved = (await storage.get(cacheKey(id)))[cacheKey(id)];
      try {
        records = validateSnapshot({ records: saved?.records || [] });
        syncedAt = saved?.syncedAt || null;
        mark = typeof saved?.mark === 'string' ? saved.mark : null;
      } catch { records = []; syncedAt = null; }
    } else {
      syncedAt = null;
      try { records = (await book.load()).records; }
      catch (failure) { records = []; error = failure.message; unreadable = true; }
    }
  }

  async function init() {
    const saved = await storage.get(['books', 'activeBook', 'stateRevision']);
    revision = Number.isSafeInteger(saved.stateRevision) ? saved.stateRevision : 0;
    books = Array.isArray(saved.books) ? saved.books.filter(item => item?.id && item?.name && item?.storage?.kind) : [];
    if (!books.length) {
      // Everyone starts with a book, so labeling works before anything is set up.
      books = [{ id: uuid(), name: 'default', storage: { kind: 'device' } }];
      active = books[0].id;
      await saveBooks();
    }
    await open(entry(saved.activeBook) ? saved.activeBook : books[0].id);
  }

  function refresh() {
    const started = active;
    if (pull && pull.book === started) return pull.promise;
    const promise = serial(async () => {
      if (active !== started) return state();
      try {
        const answer = await book.load(mark);
        if (active !== started) return state();
        pulledAt = now();
        mark = answer.mark ?? mark;
        // A book that came back saying the same thing as the copy we hold is
        // not news: no revision, no broadcast, no page repainted for nothing.
        const news = Boolean(answer.records) && !sameRecords(records, answer.records);
        const healed = error !== null || unreadable;
        if (news) records = answer.records;
        if (entry(active).storage.kind === 'server') syncedAt = now();
        error = null;
        needsRefresh = false;
        unreadable = false;
        await cache();
        if (!news && !healed) return state();
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

  // The pull nobody asked for. A book kept here has nobody else to hear from,
  // so there is nothing to ask; a book we failed to read is always worth
  // another try. Its own alarm paces it.
  function heartbeat() {
    if (unreadable || entry(active)?.storage.kind === 'server') return refresh();
    return Promise.resolve(state());
  }

  // Asked for wherever someone is about to look at a book: a popup opening, a
  // page coming back to the front, an editor opening. Five tabs waking at once
  // is one pull, not five.
  function sync() {
    if (pulledAt && now() - pulledAt < PULL_FLOOR && !unreadable) return Promise.resolve(state());
    return heartbeat();
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
      if (where.kind === 'server' && books.some(other => other.storage.url === where.url)) {
        throw new Error('That server is already one of your address books.');
      }
      const chosen = cleanName(name, '');
      if (chosen && taken(chosen)) throw new Error(`You already have an address book called ${chosen}.`);
      const host = where.kind === 'server' ? new URL(where.url) : null;
      const item = { id: uuid(), name: chosen || freeName(host ? [host.hostname, host.host] : ['Address book']), storage: where };
      const candidate = transport(item);
      const { records: found, mark: found_mark } = await candidate.load();
      if (copyFrom && found.length) throw new Error('That server already holds a book, so nothing was copied into it.');
      if (copyFrom) {
        const source = entry(copyFrom);
        if (!source) throw new Error('There is nothing to copy.');
        const taken = source.id === active ? records : (await transport(source).load()).records;
        await candidate.putMany(taken.map(({ address, scope, labels }) => ({ address, scope, labels, version: null })));
      }
      books = [...books, item];
      active = item.id;
      book = candidate;
      error = null;
      needsRefresh = false;
      // The new book was just read to make it; reading it again proves nothing.
      records = copyFrom ? (await candidate.load()).records : found;
      mark = copyFrom ? null : found_mark;
      pulledAt = now();
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
      const chosen = cleanName(name, item.name);
      if (taken(chosen, id)) throw new Error(`You already have an address book called ${chosen}.`);
      item.name = chosen;
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
      await storage.remove([...deviceKeys(id), cacheKey(id)]);
      await saveBooks();
      if (active === id) await open(books[0].id);
      changed();
      return state();
    });
  }

  // Addresses carried in from a file land in the book that is open, replacing
  // any names already held for the same address on the same network.
  async function merge(incoming) {
    const wanted = validateSnapshot({ records: incoming });
    return serial(async () => {
      if (unreadable) throw new Error('This address book could not be read, so nothing was added to it.');
      const index = new Map(records.map(item => [recordKey(item.address, item.scope), item]));
      const drafts = wanted.map(want => ({ address: want.address, scope: want.scope, labels: want.labels,
        version: index.get(recordKey(want.address, want.scope))?.version ?? null }));
      const saved = await book.putMany(drafts);
      saved.forEach((record, at) => {
        const key = recordKey(drafts[at].address, drafts[at].scope);
        if (record) index.set(key, record); else index.delete(key);
      });
      records = [...index.values()];
      await cache();
      changed();
      return { state: state(), added: wanted.length };
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
      if (unreadable) throw new Error('This address book could not be read, so nothing was saved over it.');
      // A write that may already have landed is checked, never simply repeated.
      if (book.uncertainWrites && needsRefresh) {
        const answer = await book.load();
        records = answer.records ?? records;
        mark = answer.mark ?? mark;
        syncedAt = now();
        pulledAt = now();
        needsRefresh = false;
        await cache();
        const latest = findRecord(records, address, scope);
        if ((latest?.version || null) !== version) {
          // The book already holds what this draft asks for, so the interrupted
          // write landed. Nothing is in dispute; say so instead of asking.
          if (sameLabels(latest?.labels || [], labels)) { changed(); return { state: state() }; }
          const conflict = new Error('Saved elsewhere while you were editing.');
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
          changed({ address, scope, record: failure.current || null });
          // Whoever got there first wrote the very names this draft carries, so
          // the book says what it was asked to say. A refused write that leaves
          // nothing to decide is a save, not a conflict.
          if (sameLabels(failure.current?.labels || [], labels)) return { state: state() };
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
      changed({ address, scope, record: saved });
      // The answer is that it is saved. What was saved reaches this view the
      // same way it reaches every other one, so the book travels once.
      return {};
    });
  }

  return { init, state, use, add, rename, remove, refresh, sync, heartbeat, merge, save };
}
