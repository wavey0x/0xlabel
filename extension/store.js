import { alreadyNamed, difference, findRecord, isLoopback, normalizeTags, normalizeScope, normalizeSource, parseAddress, recordKey, sameTags, validateImport } from './shared.js';
import { createRecords } from './records.js';
import { createServerBook } from './stores/server.js';

const MAX_NAME = 40;
const syncKey = id => `sync:${id}`;
// How recently a book kept elsewhere has to have been asked about before asking
// again is worth the round trip. Opening five tabs is not five syncs.
const PULL_FLOOR = 60000;
const erase = (address, scope) => ({ address, scope, tags: [] });

// Books are named things people switch between. Where a book is kept is a
// property of that book, chosen once when it is made, so nothing below ever
// moves a book: switching is only ever switching.
//
// Every book's records are held here, in one place: for a book kept on this
// device that is the book, and for one kept on a server it is the copy that
// keeps tagging working when the server cannot be reached. A write goes to the
// server first, if there is one, and then to the copy, which stores exactly
// what the server confirmed.
export function createStore({ storage, fetch: fetcher, notify = () => {}, now = Date.now,
  uuid = () => crypto.randomUUID(), indexedDB, keyRange }) {
  const local = createRecords({ indexedDB, keyRange, now });
  let books = [];
  let active = null;
  let remote = null;
  let records = [];
  let syncedAt = null;
  let error = null;
  let revision = 0;
  let needsRefresh = false;
  let came = null;
  // A book that could not be read is never saved over: the save would write
  // over tags this worker never managed to see.
  let unreadable = false;
  // A write left for a server, whose answer this worker may never have heard.
  // It belongs to the book it was for, and outlives the worker that sent it.
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
  const server = item => item.storage.kind === 'server'
    ? createServerBook({ url: item.storage.url, token: item.storage.token, fetch: fetcher })
    : null;

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
      // Only while it is still a book, and never the one being looked at.
      cameFrom: came && came.id !== active && entry(came.id)
        ? { id: came.id, name: entry(came.id).name, count: came.count } : null,
      records, stateRevision: revision, syncedAt, error,
    };
  }
  // The revision orders snapshots for every view that holds one, and it comes
  // from the write that produced it: a view is never told about a change the
  // records do not already have. A change to one record is announced as that
  // record; everything else is the whole book, because that is what changed.
  function changed(change = null) { notify(state(), change); }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  const replace = (held, address, scope, record) =>
    [...held.filter(item => item.address !== address || item.scope !== scope), ...(record ? [record] : [])];
  async function saveBooks() { await storage.set({ books, activeBook: active }); }
  async function saveSync() {
    if (remote) await storage.set({ [syncKey(active)]: { mark, syncedAt, pending: needsRefresh } });
  }

  // The book being left, counted while its records are still in hand. A view
  // offers to carry these into a book that opens with nothing in it, and reads
  // them again at the moment it does — a count is enough to decide by, and a
  // held copy would be a copy of how things were.
  const leaving = () => (entry(active) ? { id: active, count: records.length } : null);

  async function open(id) {
    const item = entry(id);
    if (id !== active) came = leaving();
    active = id;
    remote = server(item);
    error = null;
    needsRefresh = false;
    unreadable = false;
    mark = null;
    pulledAt = 0;
    syncedAt = null;
    if (remote) {
      const saved = (await storage.get(syncKey(id)))[syncKey(id)];
      mark = typeof saved?.mark === 'string' ? saved.mark : null;
      syncedAt = saved?.syncedAt || null;
      needsRefresh = Boolean(saved?.pending);
    }
    try {
      const held = await local.load(id);
      records = held.records;
      revision = held.revision;
    } catch (failure) { records = []; error = failure.message; unreadable = true; }
  }

  async function init() {
    const saved = await storage.get(['books', 'activeBook']);
    books = Array.isArray(saved.books) ? saved.books.filter(item => item?.id && item?.name && item?.storage?.kind) : [];
    if (!books.length) {
      // Everyone starts with a book, so tagging works before anything is set up.
      books = [{ id: uuid(), name: 'default', storage: { kind: 'device' } }];
      active = books[0].id;
      await saveBooks();
    }
    await open(entry(saved.activeBook) ? saved.activeBook : books[0].id);
  }

  // A pull answers with the time it got, which is the one thing a view that
  // asked for it cannot learn from an announcement that never comes.
  function refresh() {
    const started = active;
    if (pull && pull.book === started) return pull.promise;
    const promise = serial(async () => {
      if (active !== started) return { syncedAt };
      const held = records;
      try {
        const answer = remote ? await remote.load(mark) : await local.load(started);
        if (active !== started) return { syncedAt };
        pulledAt = now();
        if (remote) mark = answer.mark ?? mark;
        // Only what differs is written, and a book that came back saying what
        // the copy already says is not news: no revision, no broadcast, no page
        // repainted for nothing.
        const changes = answer.records ? difference(records, answer.records) : [];
        if (changes.length) {
          if (remote) ({ revision } = await local.write(started, changes));
          else revision = answer.revision;
          records = answer.records;
        }
        const healed = error !== null || unreadable;
        if (remote) { syncedAt = now(); await saveSync(); }
        error = null;
        needsRefresh = false;
        unreadable = false;
        if (!changes.length && !healed) return { syncedAt };
      } catch (failure) {
        // A repeated failure is quiet unless records changed before a later
        // step failed, such as recording the sync metadata.
        if (error === failure.message && records === held) return { syncedAt };
        error = failure.message;
      }
      changed();
      return { syncedAt };
    });
    pull = { book: started, promise };
    promise.finally(() => { if (pull?.promise === promise) pull = null; }).catch(() => {});
    return promise;
  }

  // The pull nobody asked for. A book kept here has nobody else to hear from,
  // so there is nothing to ask; a book we failed to read is always worth
  // another try. Its own alarm paces it.
  function heartbeat() {
    if (unreadable || remote) return refresh();
    return Promise.resolve({ syncedAt });
  }

  // Asked for wherever someone is about to look at a book: a popup opening, a
  // page coming back to the front, an editor opening. Five tabs waking at once
  // is one pull, not five.
  function sync() {
    if (pulledAt && now() - pulledAt < PULL_FLOOR && !unreadable) return Promise.resolve({ syncedAt });
    return heartbeat();
  }

  function use(id) {
    return serial(async () => {
      if (!entry(id)) throw new Error('That address book is gone.');
      await open(id);
      await saveBooks();
      changed();
      return {};
    });
  }

  // Making a book is the only moment its storage is chosen.
  async function add({ name, storage: where }) {
    if (!where || (where.kind !== 'device' && where.kind !== 'server')) throw new Error('Choose where to keep this book.');
    if (where.kind === 'server' && (!where.url || !where.token)) throw new Error('Paste the link your server printed.');
    const outcome = await serial(async () => {
      // A server already in the books is one to open, not one to add again —
      // asked here, inside the queue, because two views asking at once would
      // otherwise both find nothing and both make a book for the same server.
      if (where.kind === 'server') {
        const already = books.find(other => other.storage.url === where.url);
        if (already) {
          // A link pasted for a server already here is its key being replaced,
          // which is the only reason to paste one twice. Reopening the old key
          // would walk straight back into the refusal that prompted it.
          if (already.storage.token !== where.token) {
            // A replacement key replaces nothing until it opens the book.
            // Writing one down first would break a connection that worked.
            await server({ storage: where }).load();
            books = books.map(item => (item.id === already.id ? { ...item, storage: where } : item));
            await saveBooks();
          }
          return { book: already.id, opened: true };
        }
      }
      if (books.length >= 20) throw new Error('That is as many address books as 0xtagger keeps.');
      const chosen = cleanName(name, '');
      if (chosen && taken(chosen)) throw new Error(`You already have an address book called ${chosen}.`);
      const host = where.kind === 'server' ? new URL(where.url) : null;
      const names = !host ? ['Address book']
        : isLoopback(host.hostname) ? ['Local server', host.host] : [host.hostname, host.host];
      const item = { id: uuid(), name: chosen || freeName(names), storage: where };
      const candidate = server(item);
      const answer = candidate ? await candidate.load() : { records: [], mark: null };
      let held = answer.records;
      if (held.length || !candidate) ({ records: held, revision } = await local.write(item.id, held));
      books = [...books, item];
      came = leaving();
      active = item.id;
      remote = candidate;
      error = null;
      needsRefresh = false;
      // The new book was just read to make it; reading it again proves nothing.
      records = held.filter(Boolean);
      mark = answer.mark;
      pulledAt = now();
      syncedAt = candidate ? now() : null;
      await saveBooks();
      await saveSync();
      changed();
      return { book: item.id };
    });
    // Opening is its own queued step: it cannot run inside the one above
    // without waiting on a queue it is already holding.
    if (outcome.opened) await use(outcome.book);
    return outcome;
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
      return {};
    });
  }

  // Forgetting a server book leaves the server holding it. Removing a book kept
  // on this device is the only way addresses are deleted here, so callers say so.
  function remove(id) {
    return serial(async () => {
      const item = entry(id);
      if (!item) throw new Error('That address book is gone.');
      if (books.length === 1) throw new Error('0xtagger keeps at least one address book.');
      books = books.filter(other => other.id !== id);
      ({ revision } = await local.drop(id));
      await storage.remove([syncKey(id)]);
      if (active === id) await open(books[0].id);
      await saveBooks();
      changed();
      return {};
    });
  }

  // Addresses carried in from a file land in the book that is open, replacing
  // any tags already held for the same address on the same network. One file
  // is one decision, so it is one write: all of it lands or none of it does.
  // `book` is the one the names were reviewed against. A review is a decision
  // about a particular book, so it is checked again here: switching books
  // between reading the screen and confirming it must not quietly redirect the
  // write, the same way an open editor refuses to save into a book it was not
  // opened on.
  async function merge(incoming, book = active) {
    const wanted = validateImport(incoming);
    // Nothing to add is not a write. It costs no request, no transaction and
    // no revision, and the view says so rather than claiming an import.
    if (!wanted.length) return { added: 0 };
    return serial(async () => {
      if (book !== active) throw new Error('You switched address books. Review these names again.');
      if (unreadable) throw new Error('This address book could not be read, so nothing was added to it.');
      // An import that may already have landed is checked, never repeated: the
      // same reasoning as a single save, and the same machinery.
      if (remote && needsRefresh) {
        const answer = await remote.load();
        const changes = answer.records ? difference(records, answer.records) : [];
        if (changes.length) {
          ({ revision } = await local.write(active, changes));
          records = answer.records;
        }
        mark = answer.mark ?? mark;
        syncedAt = now();
        pulledAt = now();
        needsRefresh = false;
        await saveSync();
        changed();
      }
      const index = new Map(records.map(item => [recordKey(item.address, item.scope), item]));
      // What was reviewed was an absence: every one of these was a name the
      // book did not have. A save landing in between makes that review stale,
      // so it is read again rather than written over.
      const taken = wanted.filter(draft => alreadyNamed(index, draft));
      if (taken.length) {
        const stale = new Error('Some names changed. Review and import again.');
        stale.status = 409;
        throw stale;
      }
      // Versions belong to the receiving book, and a file never carries one.
      const drafts = wanted;
      let saved;
      if (remote) {
        needsRefresh = true;
        await saveSync();
        // Named as the new records they were reviewed as being, and checked
        // against a name standing on every network as well — the copy held
        // here can be out of date, and only the server can answer both at the
        // same instant. A server already given one of them refuses the batch.
        saved = await remote.putMany(drafts.map(draft =>
          ({ ...draft, version: null, only_if_unnamed: true })));
        ({ revision } = await local.write(active, saved));
        needsRefresh = false;
        await saveSync();
      } else {
        ({ records: saved, revision } = await local.write(active, drafts));
      }
      saved.forEach((record, at) => {
        const key = recordKey(drafts[at].address, drafts[at].scope);
        if (record) index.set(key, record); else index.delete(key);
      });
      records = [...index.values()];
      changed();
      return { added: wanted.length };
    });
  }

  async function save(draft) {
    if (draft.book !== active) throw new Error('You switched address books. Close this editor and try again.');
    const address = parseAddress(draft.address);
    if (!address) throw new Error('Use a full Ethereum address.');
    const scope = normalizeScope(draft.scope);
    const tags = normalizeTags(draft.tags);
    const version = draft.version;
    if (!(version === null || typeof version === 'string')) throw new Error('Refresh this record before saving.');
    // Only ever an origin for a record being created; the book keeps the one a
    // record already has, so an editor cannot rewrite where something came from.
    const source = normalizeSource(draft.source);
    const started = active;
    return serial(async () => {
      if (active !== started) throw new Error('You switched address books before this was saved. Try again.');
      if (unreadable) throw new Error('This address book could not be read, so nothing was saved over it.');
      // A write that may already have landed is checked, never simply repeated.
      if (remote && needsRefresh) {
        const answer = await remote.load();
        const changes = answer.records ? difference(records, answer.records) : [];
        if (changes.length) {
          ({ revision } = await local.write(started, changes));
          records = answer.records;
        }
        mark = answer.mark ?? mark;
        syncedAt = now();
        pulledAt = now();
        needsRefresh = false;
        await saveSync();
        const latest = findRecord(records, address, scope);
        if ((latest?.version || null) !== version) {
          // The book already holds what this draft asks for, so the interrupted
          // write landed. Nothing is in dispute; say so instead of asking.
          if (sameTags(latest?.tags || [], tags)) { changed(); return {}; }
          const conflict = new Error('Saved elsewhere while you were editing.');
          conflict.current = latest;
          conflict.status = 409;
          changed();
          throw conflict;
        }
      }
      if (remote) { needsRefresh = true; await saveSync(); }
      let saved;
      try {
        if (remote) {
          saved = await remote.put({ address, scope, tags, version, source });
          ({ revision } = await local.write(started, [saved || erase(address, scope)]));
        } else {
          ({ record: saved, revision } = await local.save(started, { address, scope, tags, version, source }));
        }
      } catch (failure) {
        if (failure.status === 409) {
          if (failure.current && (failure.current.address !== address || failure.current.scope !== scope)) {
            throw new Error('A conflict came back for a different record. Refresh before trying again.');
          }
          // A refusal that names no record at all says only that this draft is
          // out of date. It is not a report that the book is empty, so there is
          // nothing to copy over the saved one and nothing to settle below.
          const told = failure.current !== undefined;
          const current = failure.current ?? null;
          // A book kept here refused because the draft was old, not because the
          // copy is: only a server can have been written behind our back.
          const stale = told && (findRecord(records, address, scope)?.version ?? null) !== (current?.version ?? null);
          needsRefresh = false;
          if (stale) {
            records = replace(records, address, scope, current);
            if (remote) ({ revision } = await local.write(started, [current || erase(address, scope)]));
            changed({ address, scope, record: current });
          }
          if (remote) await saveSync();
          // Whoever got there first wrote the very tags this draft carries, so
          // the book says what it was asked to say. A refused write that leaves
          // nothing to decide is a save, not a conflict.
          if (told && sameTags(current?.tags || [], tags)) return {};
        } else if (failure.status && failure.status < 500) {
          needsRefresh = false;
          if (remote) await saveSync();
        }
        throw failure;
      }
      records = replace(records, address, scope, saved);
      error = null;
      needsRefresh = false;
      await saveSync();
      changed({ address, scope, record: saved });
      // The answer is that it is saved. What was saved reaches this view the
      // same way it reaches every other one, so the book travels once.
      return {};
    });
  }

  // One book's names into another's: read now rather than from whatever a view
  // was holding, so nothing deleted in between comes back with them.
  async function copyBook(from, into) {
    if (into !== active) throw new Error('You switched address books. Open that one again to copy into it.');
    if (from === into || !entry(from)) throw new Error('There is nothing to copy.');
    const held = (await local.load(from)).records;
    return merge(held.map(({ address, scope, tags, source }) =>
      ({ address, scope, tags, ...(source ? { source } : {}) })), into);
  }

  return { init, state, use, add, rename, remove, refresh, sync, heartbeat, merge, copyBook, save };
}
