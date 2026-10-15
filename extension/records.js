import { validateRecord, validateSnapshot } from './shared.js';

// Where books are kept. Every record of every book lives in one store, keyed by
// the book it belongs to, so a book is a range: it loads, copies and deletes as
// one, while a save touches one row.
//
// Only the worker opens this. Views ask the worker for what they need, which is
// what keeps a single copy authoritative — and means no other context can be
// holding the database open when its shape changes.
//
// Every write carries the book's revision with it, in the same transaction, so
// the count that orders snapshots cannot disagree with the records it counts.
const NAME = '0xtagger';
const RECORDS = 'records';
const META = 'meta';
const REVISION = 'revision';

const wrap = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const settled = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('That write did not finish.'));
});

export function createRecords({ indexedDB: factory = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange, now = Date.now } = {}) {
  // A version only has to differ from the one before it. Counting forward from
  // the clock keeps two saves within the same millisecond apart.
  let last = 0;
  const stamp = () => { last = Math.max(now(), last + 1); return last.toString(36); };
  const book = id => keyRange.bound([id], [id, []]);

  // One connection, kept for as long as this worker lives. A failed open is
  // not remembered, so a later attempt is a fresh one rather than the same
  // refusal handed back forever.
  let opening = null;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = factory.open(NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(RECORDS, { keyPath: ['book', 'scope', 'address'] });
          request.result.createObjectStore(META, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }

  async function begin(mode = 'readwrite') {
    const database = await open();
    const transaction = database.transaction([RECORDS, META], mode);
    return [transaction.objectStore(RECORDS), transaction.objectStore(META), transaction];
  }
  async function bumped(meta) {
    const held = await wrap(meta.get(REVISION));
    const revision = (Number.isSafeInteger(held?.value) ? held.value : 0) + 1;
    meta.put({ key: REVISION, value: revision });
    return revision;
  }
  // A record with no names is a record removed, the same as everywhere else.
  function store(records, id, { address, scope, tags, version }) {
    if (!tags.length) { records.delete([id, scope, address]); return null; }
    const saved = { address, scope, tags, version: version || stamp() };
    records.put({ book: id, ...saved });
    return saved;
  }

  return {
    async load(id) {
      const [records, meta] = await begin('readonly');
      const [held, revision] = await Promise.all([wrap(records.getAll(book(id))), wrap(meta.get(REVISION))]);
      return {
        records: validateSnapshot({ records: held }),
        revision: Number.isSafeInteger(revision?.value) ? revision.value : 0,
      };
    },
    // One name, against the version it was read at. The check and the write are
    // the same transaction, so nothing can land between them.
    async save(id, { address, scope, tags, version }) {
      const [records, meta, transaction] = await begin();
      const held = await wrap(records.get([id, scope, address]));
      const existing = held ? validateRecord(held) : null;
      if ((existing?.version ?? null) !== version) {
        transaction.abort();
        const conflict = new Error('Saved elsewhere while you were editing.');
        conflict.status = 409;
        conflict.current = existing;
        throw conflict;
      }
      const saved = store(records, id, { address, scope, tags, version: stamp() });
      const revision = await bumped(meta);
      await settled(transaction);
      return { record: saved, revision };
    },
    // Many at once: a file carried in, a book copied, or the handful of records
    // a sync found changed. One transaction, so a book is never half written.
    // A record that arrives with a version keeps it — that is a server's answer
    // being mirrored; one without gets ours.
    async write(id, wanted) {
      const [records, meta, transaction] = await begin();
      const saved = wanted.map(record => store(records, id, record));
      const revision = await bumped(meta);
      await settled(transaction);
      return { records: saved, revision };
    },
    async drop(id) {
      const [records, meta, transaction] = await begin();
      records.delete(book(id));
      const revision = await bumped(meta);
      await settled(transaction);
      return { revision };
    },
    // For the changes that are about books rather than about what is in them.
    async bump() {
      const [, meta, transaction] = await begin();
      const revision = await bumped(meta);
      await settled(transaction);
      return { revision };
    },
  };
}
