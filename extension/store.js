import { findRecord, normalizeLabels, normalizeScope, parseAddress, validateSnapshot } from './shared.js';
import { createDeviceBook } from './stores/device.js';
import { createServerBook } from './stores/server.js';

// One book, kept wherever the person chose to keep it. The books themselves are
// transports; everything below owns the copy we hand to the rest of the
// extension, so losing a server costs freshness rather than the book.
export function createStore({ storage, fetch: fetcher, notify = () => {}, now = Date.now }) {
  let location = 'device';
  let server = null;
  let book = null;
  let records = [];
  let syncedAt = null;
  let error = null;
  let revision = 0;
  let needsRefresh = false;
  let queue = Promise.resolve();
  let pull = null;

  function build() {
    book = location === 'server' && server
      ? createServerBook({ url: server.url, token: server.token, fetch: fetcher })
      : createDeviceBook({ storage, now });
  }
  function state() {
    return {
      location, locationName: book.name, server: server?.url || null,
      records, stateRevision: revision, syncedAt, error,
    };
  }
  function changed() { revision++; notify(state()); }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  // Only a server book keeps a copy; the device book is the storage itself.
  async function cache() {
    if (location === 'server') await storage.set({ cache: { records, syncedAt } });
  }

  async function init() {
    const saved = await storage.get(['location', 'server', 'cache']);
    server = saved.server?.url && saved.server?.token ? saved.server : null;
    location = saved.location === 'server' && server ? 'server' : 'device';
    build();
    if (location === 'server') {
      try {
        records = validateSnapshot({ records: saved.cache?.records || [] });
        syncedAt = saved.cache?.syncedAt || null;
      } catch { records = []; }
    } else {
      try { records = await book.load(); } catch (failure) { error = failure.message; }
    }
    revision++;
  }

  function refresh() {
    const started = { location, url: server?.url };
    if (pull && pull.location === started.location && pull.url === started.url) return pull.promise;
    const promise = serial(async () => {
      if (location !== started.location || server?.url !== started.url) return state();
      try {
        const next = await book.load();
        if (location !== started.location || server?.url !== started.url) return state();
        records = next;
        if (location === 'server') syncedAt = now();
        error = null;
        needsRefresh = false;
        await cache();
      } catch (failure) {
        error = failure.message;
      }
      changed();
      return state();
    });
    pull = { ...started, promise };
    promise.finally(() => { if (pull?.promise === promise) pull = null; }).catch(() => {});
    return promise;
  }

  // Move the book to another place to live. An empty destination takes a copy of
  // what you already had; one that already holds records is joined as it is, and
  // the book you were using stays where it was in case you come back.
  async function use(next, options = {}) {
    if (next !== 'device' && next !== 'server') throw new Error('Choose a place to keep your book.');
    return serial(async () => {
      const previous = records;
      if (next === 'server') {
        const chosen = options.url ? { url: options.url, token: options.token } : server;
        if (!chosen?.url || !chosen?.token) throw new Error('Paste the link your server printed.');
        const candidate = createServerBook({ ...chosen, fetch: fetcher });
        const found = await candidate.load();
        server = chosen;
        location = 'server';
        book = candidate;
        records = found;
        if (!found.length && previous.length) {
          for (const entry of previous) {
            records = [...records.filter(item => item.address !== entry.address || item.scope !== entry.scope),
              await candidate.put({ ...entry, version: null })].filter(Boolean);
          }
        }
        syncedAt = now();
        await storage.set({ server: chosen });
      } else {
        location = 'device';
        build();
        records = await book.load();
        if (!records.length && previous.length) {
          await book.replace(previous);
          records = previous;
        }
        syncedAt = null;
      }
      error = null;
      needsRefresh = false;
      await storage.set({ location });
      await cache();
      changed();
      return state();
    });
  }

  async function save(draft) {
    if (draft.location !== location) throw new Error('Your book moved while this was open. Close this editor and try again.');
    const address = parseAddress(draft.address);
    if (!address) throw new Error('Use a full Ethereum address.');
    const scope = normalizeScope(draft.scope);
    const labels = normalizeLabels(draft.labels);
    const version = draft.version;
    if (!(version === null || typeof version === 'string')) throw new Error('Refresh this record before saving.');
    const started = { location, url: server?.url };
    return serial(async () => {
      if (location !== started.location || server?.url !== started.url) {
        throw new Error('Your book moved before this was saved. Try again.');
      }
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
          records = records.filter(entry => entry.address !== address || entry.scope !== scope);
          if (failure.current) records.push(failure.current);
          needsRefresh = false;
          await cache();
          changed();
        } else if (failure.status && failure.status < 500) {
          needsRefresh = false;
        }
        throw failure;
      }
      records = records.filter(entry => entry.address !== address || entry.scope !== scope);
      if (saved) records.push(saved);
      error = null;
      needsRefresh = false;
      await cache();
      changed();
      return { state: state() };
    });
  }

  return { init, state, use, refresh, save };
}
