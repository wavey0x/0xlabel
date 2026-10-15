import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { createStore } from '../extension/store.js';
import { applyChange, normalizeAPI, parseConnectLink, readBookFile, reviewImport } from '../extension/shared.js';

const address = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
const third = '0x' + 'ef'.repeat(20);
const host = 'http://127.0.0.1:8712';
const token = 'test-only-secret';
const onServer = { kind: 'server', url: host, token };
const response = (value, status = 200, mark = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => (name.toLowerCase() === 'etag' ? mark : null) },
  json: async () => structuredClone(value),
});

function harness({ remote = [] } = {}) {
  const saved = {};
  const calls = [];
  let book = remote;
  let intercept;
  let counter = 0;
  let clock = 100;
  const writes = [];
  const storage = {
    get: async keys => {
      const all = structuredClone(saved);
      if (keys === null || keys === undefined) return all;
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter(key => key in all).map(key => [key, all[key]]));
    },
    set: async entries => { writes.push(...Object.keys(entries)); Object.assign(saved, structuredClone(entries)); },
    remove: async keys => { for (const key of [].concat(keys)) delete saved[key]; },
  };
  // A stand-in for server.py: a revision that changes with the book, a
  // conditional read, one record at a time and many in one go.
  let revision = 0;
  const held = (address, scope) => book.find(item => item.address === address && item.scope === scope) || null;
  const apply = ({ address, scope, tags, source }) => {
    revision += 1;
    // As server.py does: an origin is settled when the record is created.
    const origin = held(address, scope)?.source || source || null;
    const next = tags.length ? { address, scope, tags, version: 'v' + revision, ...(origin ? { source: origin } : {}) } : null;
    book = [...book.filter(item => item.address !== address || item.scope !== scope), ...(next ? [next] : [])];
    return next;
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (intercept) { const result = await intercept(url, options); if (result) return result; }
    const mark = `"${revision}"`;
    const path = url.slice(url.indexOf('/tags'));
    if (!options.method) {
      if (options.headers?.['If-None-Match'] === mark) return response(null, 304, mark);
      return response({ records: book }, 200, mark);
    }
    const body = JSON.parse(options.body);
    if (path === '/tags') {
      const conflicts = body.changes.filter(change => change.version !== (held(change.address, change.scope)?.version || null));
      if (conflicts.length) return response({ detail: 'Saved elsewhere while this file was being added.', conflicts }, 409, mark);
      return response({ records: body.changes.map(apply) }, 200, `"${revision}"`);
    }
    const [, scope, at] = path.split('/').map(decodeURIComponent).filter((_, index) => index !== 0);
    const current = held(at, scope);
    if (body.version !== (current?.version || null)) return response({ current }, 409, mark);
    return response({ record: apply({ address: at, scope, tags: body.tags, source: body.source }) }, 200, `"${revision}"`);
  };
  // One database per harness, so a restart reopens the same books and a
  // different test never sees them.
  const indexedDB = new IDBFactory();
  const make = () => createStore({ storage, fetch, indexedDB, keyRange: FakeKeyRange,
    now: () => ++clock, uuid: () => `id-${++counter}` });
  const corrupt = async (id, row) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('0xtagger', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('records', 'readwrite');
      transaction.objectStore('records').put({ book: id, ...row });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  };
  return { store: make(), make, saved, calls, storage, fetch, writes, corrupt,
    remote: () => book, intercept: value => { intercept = value; } };
}
const write = (store, tags, { book = store.state().activeBook, at = address, version = null, source } = {}) =>
  store.save({ book, address: at, scope: 'global', tags, version, source });

test('a book exists before anything is set up, and tagging needs no connection', async () => {
  const { store, saved } = harness();
  await store.init();
  assert.equal(store.state().books.length, 1);
  assert.equal(store.state().books[0].where, 'On this device');
  await write(store, ['Treasury']);
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Treasury']);
  // Settings and credentials live in extension storage; books do not.
  assert.deepEqual(Object.keys(saved).sort(), ['activeBook', 'books']);
});

test('a device book survives a restart and removing every name deletes the record', async () => {
  const first = harness();
  await first.store.init();
  await write(first.store, ['Treasury']);
  const version = first.store.state().records[0].version;

  const resumed = first.make();
  await resumed.init();
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]), ['Treasury']);
  await write(resumed, [], { version });
  assert.deepEqual(resumed.state().records, []);
});

test('a stale version is refused rather than quietly overwriting the newer names', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['First']);
  await assert.rejects(write(store, ['Second']),
    error => error.status === 409 && error.current.tags[0] === 'First');
});

test('an unreadable device book is never presented, or saved over, as an empty one', async () => {
  const { store, make, corrupt } = harness();
  await store.init();
  await write(store, ['Treasury']);
  await corrupt(store.state().activeBook, { address: other, scope: 'global', tags: [] });
  const resumed = make();
  await resumed.init();
  assert.equal(resumed.state().records.length, 0);
  assert.match(resumed.state().error, /record/i);
  await assert.rejects(write(resumed, ['Anything']), /could not be read/);
});

test('a connect link carries the key in the fragment, which is never sent to the server', () => {
  assert.deepEqual(parseConnectLink(`${host}#key=${token}`), { url: normalizeAPI(host), token });
  assert.deepEqual(parseConnectLink(`  ${host}/#key=${token}  `), { url: normalizeAPI(host), token });
  assert.throws(() => parseConnectLink(host), /access key/);
  assert.throws(() => parseConnectLink('nonsense'), /link/);
});

test('books are separate, and switching between them changes neither', async () => {
  const { store, remote } = harness({ remote: [] });
  await store.init();
  const device = store.state().activeBook;
  await write(store, ['Mine']);

  await store.add({ name: 'Team', storage: onServer });
  assert.equal(store.state().bookName, 'Team');
  assert.deepEqual(store.state().records, [], 'a new book starts with what its storage holds');
  await write(store, ['Shared']);

  await store.use(device);
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Mine']);
  await store.use(store.state().books.find(item => item.name === 'Team').id);
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Shared']);
  assert.deepEqual(remote().map(entry => entry.tags[0]), ['Shared'], 'the server holds only its own book');
});

// Nobody calls their own computer 127.0.0.1, so a book kept on it is named
// for what it is. A book somewhere else is named for where that is.
test('a server book is named for its host, and one kept here for being here', async () => {
  const near = harness();
  await near.store.init();
  await near.store.add({ storage: onServer });
  assert.equal(near.store.state().bookName, 'Local server');

  const far = harness();
  await far.store.init();
  await far.store.add({ storage: { kind: 'server', url: 'https://book.example', token } });
  assert.equal(far.store.state().bookName, 'book.example');
});

// Two servers on this machine are two books, and the second is not refused
// for wanting the same obvious name — it is told apart by the port, which is
// the only thing that tells them apart anyway.
test('a second local server gets a name of its own', async () => {
  const { store } = harness();
  await store.init();
  await store.add({ storage: onServer });
  await store.add({ storage: { kind: 'server', url: 'http://127.0.0.1:8713', token } });
  assert.deepEqual(store.state().books.map(item => item.name),
    ['default', 'Local server', '127.0.0.1:8713']);
});

// Connecting and copying are two things. A book is opened as it is, and what
// was in the last one is carried over afterwards, by the same write a file
// gets: into the book it was offered for, refusing anything already named.
test('what was in the last book is carried into an empty one it connects to', async () => {
  const { store, remote } = harness({ remote: [] });
  await store.init();
  await write(store, ['Treasury'], { source: 'safe:address-book' });
  const came = store.state().records;
  await store.add({ storage: onServer });
  assert.equal(store.state().records.length, 0, 'the book opens as it is');

  await store.merge(came, store.state().activeBook);
  assert.deepEqual(remote().map(entry => entry.tags[0]), ['Treasury']);
  assert.equal(store.state().records[0].source, 'safe:address-book', 'origins travel with the names');
});

test('carrying a book over never writes across a name the far side already has', async () => {
  const { store } = harness({ remote: [{ address, scope: 'global', tags: ['Theirs'], version: 'one' }] });
  await store.init();
  await write(store, ['Mine']);
  const came = store.state().records;
  await store.add({ storage: onServer });
  assert.deepEqual(store.state().records.map(item => item.tags[0]), ['Theirs']);
  await assert.rejects(store.merge(came, store.state().activeBook), /Some names changed/);
  assert.deepEqual(store.state().records.map(item => item.tags[0]), ['Theirs']);
});

test('a draft written for one book is never saved into another', async () => {
  const { store } = harness();
  await store.init();
  const device = store.state().activeBook;
  await store.add({ name: 'Team', storage: onServer });
  await assert.rejects(write(store, ['Treasury'], { book: device }), /switched/);
});

test('an unreachable server costs freshness, not the book', async () => {
  const { store, intercept } = harness({ remote: [{ address, scope: 'global', tags: ['Shared'], version: 'one' }] });
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  intercept(() => { throw new Error('offline'); });
  await store.refresh();
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Shared']);
  assert.match(store.state().error, /could not be reached/);
});

test('removing a device book takes its addresses; removing a server book only forgets it', async () => {
  const { store, make, remote } = harness({ remote: [] });
  await store.init();
  const device = store.state().activeBook;
  await write(store, ['Mine']);
  await store.add({ name: 'Team', storage: onServer });
  await write(store, ['Shared']);
  const team = store.state().activeBook;

  await store.remove(team);
  assert.deepEqual(remote().map(entry => entry.tags[0]), ['Shared'], 'the server still holds it');
  assert.equal(store.state().activeBook, device);

  await store.add({ name: 'Second', storage: { kind: 'device' } });
  const second = store.state().activeBook;
  await write(store, ['Scratch']);
  await store.remove(second);
  const resumed = make();
  await resumed.init();
  await assert.rejects(resumed.use(second), /gone/);
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]), ['Mine'], 'its addresses went with it');
});

test('there is always an address book to tag into', async () => {
  const { store } = harness();
  await store.init();
  await assert.rejects(store.remove(store.state().activeBook), /at least one/);
});

test('the last place for a book is settled in the queue, not before it', async () => {
  const { store } = harness();
  await store.init();
  while (store.state().books.length < 19) await store.add({ storage: { kind: 'device' } });
  // Two views asking at once both read nineteen books before either writes.
  const answers = await Promise.allSettled([
    store.add({ name: 'Nineteen', storage: { kind: 'device' } }),
    store.add({ name: 'Twenty', storage: { kind: 'device' } }),
  ]);
  assert.deepEqual(answers.map(answer => answer.status), ['fulfilled', 'rejected']);
  assert.match(answers[1].reason.message, /as many address books/);
  assert.equal(store.state().books.length, 20);
});

test('removing the open book leaves the one that replaced it as the open book', async () => {
  const { store, make, saved } = harness();
  await store.init();
  const first = store.state().activeBook;
  await store.add({ name: 'Second', storage: { kind: 'device' } });
  const second = store.state().activeBook;
  await store.remove(second);
  assert.equal(store.state().activeBook, first);
  assert.equal(saved.activeBook, first, 'and storage says so, rather than naming a book that is gone');

  const resumed = make();
  await resumed.init();
  assert.equal(resumed.state().activeBook, first);
});

test('a book can be renamed, and an empty name leaves the old one standing', async () => {
  const { store } = harness();
  await store.init();
  await store.rename(store.state().activeBook, '  Work   wallets  ');
  assert.equal(store.state().bookName, 'Work wallets');
  await store.rename(store.state().activeBook, '   ');
  assert.equal(store.state().bookName, 'Work wallets');
});

test('an interrupted write is checked before it is retried', async () => {
  const { store, make, remote, calls, storage, saved } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  // The write reaches the server, and the worker stops before it hears the
  // answer: nothing locally knows that it landed.
  await write(store, ['Treasury']);
  const landed = remote()[0];
  const book = store.state().activeBook;
  // What the worker would have left behind: a write sent, its answer unheard.
  await storage.set({ [`sync:${book}`]: { ...saved[`sync:${book}`], pending: true } });
  const resumed = make();
  await resumed.init();
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]), ['Treasury']);

  // A retry of the same draft, carrying the version it was written against.
  calls.length = 0;
  await write(resumed, ['Treasury']);
  assert.deepEqual(remote().map(entry => entry.tags[0]), ['Treasury']);
  assert.equal(remote().length, 1, 'the write is not repeated');
  assert.equal(remote()[0].version, landed.version, 'and nothing was written over it');
  assert.deepEqual(calls.filter(call => call.method).map(call => call.method), [],
    'it looked before it wrote, and then had nothing to write');
});

test('a view open before the worker restarted is not left behind by the book', async () => {
  const { store, make } = harness();
  await store.init();
  await write(store, ['Treasury']);
  // The service worker is torn down whenever it goes idle. A page still holding
  // the last snapshot ignores anything numbered below it, so the count has to
  // belong to the books rather than to this run of the worker.
  const seen = store.state().stateRevision;
  const resumed = make();
  await resumed.init();
  await write(resumed, ['Renamed'], { version: resumed.state().records[0].version });
  assert.ok(resumed.state().stateRevision > seen, `a restart handed out ${resumed.state().stateRevision} again`);
});

test('saving the names a book already holds is a save, not a conflict', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  // The same edit arrives twice: from a view that had not heard about the first.
  await write(store, ['Treasury']);
  assert.deepEqual(store.state().records.map(entry => entry.tags), [['Treasury']]);
  await assert.rejects(write(store, ['Something else']), error => error.status === 409);
});

test('an interrupted write that landed is answered by what the server now says', async () => {
  const { store, storage, make, remote } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  await write(store, ['Treasury']);
  await storage.set({ needsRefresh: true });
  const resumed = make();
  await resumed.init();
  await write(resumed, ['Treasury']);
  assert.deepEqual(remote().map(entry => entry.tags), [['Treasury']], 'the write is neither repeated nor disputed');
});

test('a save is one write, and a file carried in is one write however many it holds', async () => {
  const { store } = harness();
  await store.init();
  const settled = store.state().stateRevision;
  await write(store, ['Treasury']);
  assert.equal(store.state().stateRevision, settled + 1, 'one save, one write');

  const { added } = await store.merge(Array.from({ length: 500 }, (_, index) => ({
    address: '0x' + index.toString(16).padStart(40, '0'), scope: 'global',
    tags: ['Carried ' + index], version: 'from-file',
  })));
  assert.equal(added, 500);
  assert.equal(store.state().stateRevision, settled + 2, 'five hundred addresses, still one write');
  assert.equal(store.state().records.length, 501);
});

test('a refused save writes nothing at all', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['First']);
  const settled = store.state().stateRevision;
  await assert.rejects(write(store, ['Second']), error => error.status === 409);
  assert.equal(store.state().stateRevision, settled, 'the record and the count moved together, or not at all');
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['First']);
});

test('a book is read back whole, and removing another one leaves it alone', async () => {
  const { store, make } = harness();
  await store.init();
  const first = store.state().activeBook;
  await write(store, ['First'], { at: '0x' + '11'.repeat(20) });
  await write(store, ['Second'], { at: '0x' + 'ee'.repeat(20) });
  await store.add({ name: 'Other', storage: { kind: 'device' } });
  await write(store, ['Elsewhere']);

  const resumed = make();
  await resumed.init();
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]), ['Elsewhere']);
  await resumed.use(first);
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]).sort(), ['First', 'Second']);
  await resumed.remove(resumed.state().books.find(item => item.name === 'Other').id);
  assert.deepEqual(resumed.state().records.map(entry => entry.tags[0]).sort(), ['First', 'Second']);

  const again = make();
  await again.init();
  assert.deepEqual(again.state().records.map(entry => entry.tags[0]).sort(), ['First', 'Second']);
});

// What a review hands on is an absence: names the book does not have. A save
// landing between reading that screen and confirming it makes the review
// stale, so it is read again rather than written over.
test('a book carried in from a file joins the one that is open, and never writes over it', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  const { added } = await store.merge([
    { address: other, scope: 'eip155:8453', tags: ['Payroll'], version: 'from-file' },
  ]);
  assert.equal(added, 1);
  const names = Object.fromEntries(store.state().records.map(entry => [entry.address, entry.tags[0]]));
  assert.deepEqual(names, { [address]: 'Treasury', [other]: 'Payroll' });
  assert.ok(store.state().records.every(entry => entry.version !== 'from-file'),
    'the receiving book issues its own versions');

  await assert.rejects(store.merge([{ address, scope: 'global', tags: ['Renamed'] }]),
    /Some names changed/);
  assert.equal(store.state().records.find(entry => entry.address === address).tags[0], 'Treasury');
});

// The same, on a server, and for a write whose answer was lost: the book is
// reconciled first, so an import that already landed is seen rather than
// repeated into a pile of conflicts.
test('an import whose answer was lost is reconciled, not repeated', async () => {
  const { store, intercept, remote } = harness();
  await store.init();
  await store.add({ name: 'Shared', storage: onServer });
  // The server takes the batch; the answer never arrives.
  intercept(async (url, options) => {
    if (options.method !== 'PUT') return null;
    JSON.parse(options.body).changes.forEach(change => remote().push(
      { address: change.address, scope: change.scope, tags: change.tags, version: 'landed' }));
    intercept(null);
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(store.merge([{ address, scope: 'global', tags: ['Treasury'] }]),
    /did not answer. Whether this landed is checked/);
  // Asked again, the book sees what landed instead of writing over it.
  await assert.rejects(store.merge([{ address, scope: 'global', tags: ['Treasury'] }]),
    /Some names changed/);
  assert.equal(store.state().records.length, 1);
  assert.deepEqual(store.state().records[0].tags, ['Treasury']);
});

test('a file that is not a book is refused before anything is written', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  await assert.rejects(store.merge([{ address, scope: 'global', tags: [] }]));
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Treasury']);
});

test('a view applies one record, and asks for the book when it has missed one', () => {
  const held = { activeBook: 'book-1', stateRevision: 7, syncedAt: null,
    records: [{ address, scope: 'global', tags: ['Treasury'], version: 'one' }] };
  const announce = (change, revision = 8, book = 'book-1') =>
    ({ type: 'Updated', change, activeBook: book, stateRevision: revision, syncedAt: 100 });

  const renamed = { address, scope: 'global', tags: ['Renamed'], version: 'two' };
  const after = applyChange(held, announce({ address, scope: 'global', record: renamed }));
  assert.deepEqual(after.records, [renamed]);
  assert.equal(after.stateRevision, 8);
  assert.equal(after.syncedAt, 100);
  assert.deepEqual(held.records.map(entry => entry.tags[0]), ['Treasury'], 'the copy it was given is left alone');

  const added = applyChange(held, announce({ address: other, scope: 'eip155:8453',
    record: { address: other, scope: 'eip155:8453', tags: ['Payroll'], version: 'two' } }));
  assert.equal(added.records.length, 2);
  assert.deepEqual(applyChange(held, announce({ address, scope: 'global', record: null })).records, []);

  // A gap, another book, or a whole-book update: this view cannot patch it.
  assert.equal(applyChange(held, announce({ address, scope: 'global', record: renamed }, 9)), null);
  assert.equal(applyChange(held, announce({ address, scope: 'global', record: renamed }, 7)), null);
  assert.equal(applyChange(held, announce({ address, scope: 'global', record: renamed }, 8, 'book-2')), null);
  assert.equal(applyChange(held, { type: 'Updated', state: held }), null);
});

test('a sync that learns nothing costs nothing, and a book kept here is never asked', async () => {
  const { store, calls, remote } = harness({ remote: [{ address, scope: 'global', tags: ['Shared'], version: 'one' }] });
  await store.init();
  const device = store.state().activeBook;
  await store.add({ name: 'Team', storage: onServer });
  const settled = store.state().stateRevision;

  calls.length = 0;
  await store.refresh();
  assert.equal(store.state().stateRevision, settled, 'nothing changed, so no view is told anything');
  assert.deepEqual(calls.map(call => call.headers['If-None-Match']), [`"0"`], 'and it asked the cheap way');

  // A book this worker holds in storage has nobody else to hear from.
  await store.use(device);
  calls.length = 0;
  await store.sync();
  assert.deepEqual(calls, []);

  // Switching to a book kept elsewhere is a reason to ask; asking twice is not.
  await store.use(store.state().books.find(item => item.name === 'Team').id);
  calls.length = 0;
  await store.sync();
  assert.equal(calls.length, 1);
  await store.sync();
  assert.equal(calls.length, 1, 'a book asked about a moment ago is not asked again');
  assert.deepEqual(remote().map(entry => entry.tags[0]), ['Shared']);
});

test('a book that did change is sent once, and every view hears about it', async () => {
  const { store, intercept } = harness({ remote: [{ address, scope: 'global', tags: ['Shared'], version: 'one' }] });
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  const settled = store.state().stateRevision;
  intercept(() => ({ ok: true, status: 200, headers: { get: () => '"9"' },
    json: async () => ({ records: [{ address, scope: 'global', tags: ['Renamed elsewhere'], version: 'two' }] }) }));
  await store.refresh();
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Renamed elsewhere']);
  assert.ok(store.state().stateRevision > settled);
});

test('a file carried into a book on a server travels in one request', async () => {
  const { store, calls, remote } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  calls.length = 0;
  const { added } = await store.merge(Array.from({ length: 50 }, (_, index) => ({
    address: '0x' + index.toString(16).padStart(40, '0'), scope: 'global',
    tags: ['Carried ' + index], version: 'from-file',
  })));
  assert.equal(added, 50);
  const writes = calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1, 'fifty addresses, one round trip');
  assert.equal(JSON.parse(writes[0].body).changes.length, 50);
  assert.equal(remote().length, 50);
});

test('two address books cannot share a name, however they are kept', async () => {
  const { store } = harness();
  await store.init();
  await store.rename(store.state().activeBook, 'Work');
  await assert.rejects(store.add({ name: 'work', storage: { kind: 'device' } }), /already have an address book called/);
  await assert.rejects(store.add({ name: 'Work', storage: onServer }), /already have an address book called/);
  await store.add({ name: 'Team', storage: onServer });
  await assert.rejects(store.rename(store.state().activeBook, 'Work'), /already have an address book called/);
  assert.deepEqual(store.state().books.map(item => item.name), ['Work', 'Team']);
});

// A server already in the books is one to open, not one to add again: it is
// the same book either way, and refusing was a dead end.
test('connecting to a server already in the books opens it', async () => {
  const { store } = harness();
  await store.init();
  const { book } = await store.add({ name: 'Team', storage: onServer });
  await store.use(store.state().books.find(item => item.id !== book).id);

  const again = await store.add({ name: 'Team again', storage: onServer });
  assert.deepEqual(again, { book, opened: true });
  assert.equal(store.state().books.length, 2, 'and does not make a second one');
  assert.equal(store.state().activeBook, book, 'and is the book you are looking at');
  assert.equal(store.state().bookName, 'Team', 'keeping the name it already had');
});

test('a name we chose, rather than one you typed, gives way to a free one', async () => {
  const { store } = harness();
  await store.init();
  await store.add({ storage: { kind: 'device' } });
  await store.add({ storage: { kind: 'device' } });
  assert.deepEqual(store.state().books.map(item => item.name), ['default', 'Address book', 'Address book 2']);
});

test('a book says which kind of storage holds it', async () => {
  const { store } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  assert.deepEqual(store.state().books.map(item => item.kind), ['device', 'server']);
});

// A refusal reports that a draft is out of date. Only one that says what the
// book holds reports anything about the book itself.
test('a refusal that names no record leaves the saved copy alone', async () => {
  const { store, intercept } = harness({ remote: [{ address, scope: 'global', tags: ['Treasury'], version: 'v1' }] });
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Treasury']);
  // The server, or something standing between it and us, refuses without
  // saying what it holds.
  intercept((url, options) => (options.method === 'PUT' ? response({ detail: 'Saved elsewhere.' }, 409) : null));
  await assert.rejects(write(store, ['Renamed'], { version: 'v1' }), error => error.status === 409);
  assert.deepEqual(store.state().records.map(entry => entry.tags[0]), ['Treasury']);
});

// Safe exports `address,name,chainId`, one row per chain, so the same name on
// three chains is three rows. That is the same thing our own book says.
test('a Safe address book reads as tags, one record per network', async () => {
  const { store } = harness();
  await store.init();
  const csv = ['address,name,chainId', `${address},Treasury,1`, `${address},Treasury,137`,
    `${other},"Operations, EU",8453`].join('\r\n');
  const result = await store.merge(readBookFile(csv).records);
  assert.equal(result.added, 3);
  assert.deepEqual(store.state().records.map(item => [item.address, item.scope, item.tags[0]]).sort(),
    [[address, 'eip155:1', 'Treasury'], [address, 'eip155:137', 'Treasury'],
     [other, 'eip155:8453', 'Operations, EU']].sort());
});

// A chain nobody here has heard of is still a network the record belongs to.
test('a Safe row keeps a chain this build does not know, and an empty chain is every network', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(['address,name,chainId', `${address},Treasury,43114`, `${other},Everywhere,`].join('\n')).records);
  assert.deepEqual(store.state().records.map(item => item.scope).sort(), ['eip155:43114', 'global']);
});

// A spreadsheet leaves a byte-order mark behind; it is not content.
test('a Safe export saved by a spreadsheet still reads', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(`\uFEFFaddress,name,chainId\n${address},Treasury,1\n`).records);
  assert.equal(store.state().records[0].tags[0], 'Treasury');
});

// Versions are issued by the book that receives a record, so a file that has
// never been in a book has none to give.
test('a file imports without carrying a version, and the book issues one', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(JSON.stringify({ records: [{ address, tags: ['Treasury'] }] })).records);
  const [held] = store.state().records;
  assert.equal(held.scope, 'global');
  assert.equal(typeof held.version, 'string');
  assert.ok(held.version);
});

test('our own export reads back', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury', 'Operations']);
  const exported = JSON.stringify({ records: store.state().records }, null, 2);
  const second = harness();
  await second.store.init();
  await second.store.merge(readBookFile(exported).records);
  assert.deepEqual(second.store.state().records.map(item => item.tags), [['Treasury', 'Operations']]);
});

// Safe's Members page exports signers from bare arrays, so the file opens on
// data rather than on column names and says nothing about a network. A signer
// is a person, not a deployment, so an unnamed one carries nothing in.
test('a Safe signer export reads without a header, on every network', async () => {
  const { store } = harness();
  await store.init();
  const { records, unnamed } = readBookFile([`${address},dudesahn`, `${other},`, `${third},"Smith, A"`].join('\n'));
  assert.equal(unnamed, 1, 'a signer nobody named names nothing');
  await store.merge(records);
  assert.deepEqual(store.state().records.map(item => [item.address, item.scope, item.tags[0]]).sort(),
    [[address, 'global', 'dudesahn'], [third, 'global', 'Smith, A']].sort());
});

// Skipping a blank name must not make a malformed named row acceptable, and
// the row it complains about is the one a spreadsheet shows, not the one left
// after the blanks were dropped.
test('a blank name is skipped while a malformed named row still names its own line', async () => {
  const { store } = harness();
  await store.init();
  await assert.rejects(store.merge(readBookFile([
    'address,name,chainId', `${address},,1`, 'not-an-address,Oops,1'].join('\n')).records),
    /Row 3: that is not a full Ethereum address/);
  assert.equal(store.state().records.length, 0, 'one file is one decision');
});

test('a file that is neither is refused, and a bad row says which row', async () => {
  assert.throws(() => readBookFile('name,address\nTreasury,0x1'), /not a 0xtagger export or a Safe address book/);
  const { store } = harness();
  await store.init();
  await assert.rejects(store.merge(readBookFile(['address,name,chainId', `${address},Treasury,1`, 'not-an-address,Oops,1'].join('\n')).records),
    /Row 3: that is not a full Ethereum address/);
  assert.equal(store.state().records.length, 0, 'one file is one decision');
});

// Where a record came from is history, not permission. It is settled when the
// record is created, it survives every later edit, and it ranks no name above
// another: the first tag still decides what a website shows.
test('a source is set once and survives editing, on this device and on a server', async () => {
  for (const storage of [undefined, onServer]) {
    const { store } = harness();
    await store.init();
    if (storage) await store.add({ name: 'Shared', storage });
    await write(store, ['Treasury'], { source: 'safe:address-book' });
    assert.equal(store.state().records[0].source, 'safe:address-book');
    const { version } = store.state().records[0];
    await write(store, ['Our treasury', 'Treasury'], { version, source: 'etherscan:page' });
    const [held] = store.state().records;
    assert.equal(held.source, 'safe:address-book', 'a later write never rewrites the origin');
    assert.deepEqual(held.tags, ['Our treasury', 'Treasury']);
  }
});

test('a record composed by hand carries no source, and an unknown source is refused', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  assert.equal('source' in store.state().records[0], false);
  await assert.rejects(write(store, ['Treasury'], { at: other, source: 'evil.example' }),
    /not a source a record can carry/);
});

test('a source survives an export and the import that reads it back', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury'], { source: 'safe:page' });
  const exported = JSON.stringify({ records: store.state().records });
  const second = harness();
  await second.store.init();
  await second.store.merge(readBookFile(exported).records);
  assert.equal(second.store.state().records[0].source, 'safe:page');
});

// An import that adds nothing is not a change, so nothing downstream should be
// told the book moved — and on a server it should not cost a request either.
test('an import carrying nothing writes nothing, asks nothing and moves no revision', async () => {
  const { store, calls } = harness();
  await store.init();
  await store.add({ name: 'Shared', storage: onServer });
  await write(store, ['Treasury']);
  const before = store.state().stateRevision;
  const quiet = calls.length;
  assert.deepEqual(await store.merge([]), { added: 0 });
  assert.equal(store.state().stateRevision, before, 'nothing changed, so nothing moved');
  assert.equal(calls.length, quiet, 'and nothing was sent');
});

// What an import would do, worked out before anything is written. The unit is
// the address, the same as it is everywhere else: a name you already have is
// kept, and which network either side names it on does not come into it.
test('a review says what would be added, what is already yours, and what it could not read', async () => {
  const held = [{ address, scope: 'eip155:1', tags: ['Treasury'], version: 'one' }];
  const outcome = reviewImport([
    { row: 2, address, tags: ['Already named here'], scope: 'eip155:1' },
    { row: 3, address: other, tags: ['Payroll'], scope: 'eip155:8453' },
    { row: 4, address: 'not-an-address', tags: ['Oops'] },
    { row: 5, address: third, tags: [''] },
  ], held);
  assert.deepEqual(outcome.add, [{ address: other, scope: 'eip155:8453', tags: ['Payroll'], row: 3 }]);
  assert.equal(outcome.kept, 1, 'a name on the same network is left exactly as it is');
  assert.deepEqual(outcome.invalid.map(item => item.row), [4, 5]);
  assert.match(outcome.invalid[0].reason, /full Ethereum address/);
});

// A name covers an incoming one on its own network, or on every network. A
// name on some other chain covers nothing: an address named on Ethereum is
// still nameless on Base, and an import that skipped it would leave it so.
test('a name on one chain does not stand in for a name on another', async () => {
  const held = [
    { address, scope: 'eip155:1', tags: ['Ethereum treasury'], version: 'one' },
    { address: other, scope: 'global', tags: ['Everywhere'], version: 'two' },
  ];
  const outcome = reviewImport([
    { row: 2, address, tags: ['Base treasury'], scope: 'eip155:8453' },
    { row: 3, address, tags: ['On every network'], scope: 'global' },
    { row: 4, address: other, tags: ['Base payroll'], scope: 'eip155:8453' },
  ], held);
  assert.deepEqual(outcome.add.map(item => [item.scope, item.tags[0]]),
    [['eip155:8453', 'Base treasury'], ['global', 'On every network']]);
  assert.equal(outcome.kept, 1, 'a name on every network already covers that one');
});

test('a review keeps the rest when one row cannot be read, and counts a repeat once', async () => {
  const outcome = reviewImport([
    { row: 2, address, tags: ['Treasury'] },
    { row: 3, address, tags: ['Treasury again'] },
    { row: 4, address: other, tags: ['Payroll'] },
  ], []);
  assert.deepEqual(outcome.add.map(item => item.tags[0]), ['Treasury', 'Payroll']);
  assert.deepEqual(outcome.invalid.map(item => item.row), [3]);
  assert.match(outcome.invalid[0].reason, /already in the file/);
});

// Both of Safe's files are Safe's own address book, so reading one says so.
// Nothing downstream has to be told what it was reading.
test('a Safe file says where its names came from, without being told', async () => {
  for (const text of [[`${address},dudesahn`, `${other},wavey`].join('\n'),
    ['address,name,chainId', `${address},dudesahn,1`, `${other},wavey,`].join('\n')]) {
    const { records } = readBookFile(text);
    assert.deepEqual(records.map(item => item.source), ['safe:address-book', 'safe:address-book']);
    const outcome = reviewImport(records, []);
    assert.ok(outcome.add.every(item => item.source === 'safe:address-book'));
  }
  // A signer export names no network, because a signer is a person.
  const { records } = readBookFile(`${address},dudesahn`);
  assert.equal(records[0].scope, 'global');
});

test('a source read from a file survives all the way into the book', async () => {
  const { store } = harness();
  await store.init();
  const { records } = readBookFile(`${address},dudesahn`);
  await store.merge(records);
  assert.equal(store.state().records[0].source, 'safe:address-book');
});

// A review is a decision about one book. Switching books between reading the
// screen and confirming it must not quietly redirect the write.
test('an import lands in the book it was reviewed against, or it does not land', async () => {
  const { store } = harness();
  await store.init();
  const first = store.state().activeBook;
  await store.add({ name: 'Second', storage: { kind: 'device' } });
  assert.notEqual(store.state().activeBook, first);
  await assert.rejects(store.merge([{ address, tags: ['Treasury'] }], first),
    /switched address books/);
  assert.equal(store.state().records.length, 0);
  // Reviewed against the book that is actually open, it lands.
  assert.deepEqual(await store.merge([{ address, tags: ['Treasury'] }], store.state().activeBook), { added: 1 });
});

// A copy of a book is the same book somewhere else, origins included.


// A link is pasted a second time when the key behind it has changed. Reopening
// the old one walks straight back into the refusal that prompted it.
test('pasting a link again for a server already here replaces its key', async () => {
  const { store, calls } = harness();
  await store.init();
  const { book } = await store.add({ storage: onServer });
  await store.add({ storage: { kind: 'server', url: host, token: 'rotated-secret' } });
  assert.equal(store.state().books.length, 2, 'and does not make a second book for it');

  await store.refresh();
  const asked = calls.filter(call => call.headers?.Authorization).at(-1);
  assert.equal(asked.headers.Authorization, 'Bearer rotated-secret');
  assert.equal(store.state().activeBook, book);
});

// Two views asking at once both looked, both found nothing, and both made a
// book for the same server. The looking belongs in the queue with the making.
test('two connections to one server at the same moment make one book', async () => {
  const { store } = harness();
  await store.init();
  const [first, second] = await Promise.all([
    store.add({ storage: onServer }),
    store.add({ storage: onServer }),
  ]);
  assert.equal(store.state().books.length, 2, 'the one it started with, and one more');
  assert.equal(first.book, second.book);
  assert.ok(first.opened || second.opened, 'one of them opened what the other made');
});

// A replacement key replaces nothing until it opens the book: writing one down
// first would break a connection that was working.
test('a replacement key that does not open the book is refused, and the old one stands', async () => {
  const { store, intercept, calls } = harness();
  await store.init();
  await store.add({ storage: onServer });
  intercept(async () => response({ detail: 'rejected' }, 401));
  await assert.rejects(store.add({ storage: { kind: 'server', url: host, token: 'typo' } }), /rejected|refused|Access/i);
  intercept(null);
  await store.refresh();
  assert.equal(calls.filter(call => call.headers?.Authorization).at(-1).headers.Authorization, `Bearer ${token}`);
});

// The book left behind, so that a book opening empty can offer to carry its
// names over. Read at the moment of copying rather than from whatever a view
// was holding, so nothing deleted in between comes back with them.
test('a book opening empty is told which book it came from, and copies it as it is now', async () => {
  const { store } = harness();
  await store.init();
  const first = store.state().activeBook;
  await write(store, ['Treasury']);
  await write(store, ['Payroll'], { at: other });
  assert.equal(store.state().cameFrom, null, 'nothing was left behind yet');

  await store.add({ storage: { kind: 'device' } });
  const empty = store.state().activeBook;
  assert.deepEqual(store.state().cameFrom, { id: first, name: 'default', count: 2 });

  // One of them goes while the offer is on screen. What arrives is what the
  // book holds now, not what it held when the offer was made.
  await store.use(first);
  const held = store.state().records.find(item => item.address === other);
  await write(store, [], { at: other, version: held.version });
  await store.use(empty);
  await store.copyBook(first, empty);
  assert.deepEqual(store.state().records.map(item => item.tags[0]), ['Treasury']);
});

test('a book never offers to copy from itself, nor from one that is gone', async () => {
  const { store } = harness();
  await store.init();
  const first = store.state().activeBook;
  await write(store, ['Treasury']);
  await store.add({ storage: { kind: 'device' } });
  const second = store.state().activeBook;
  await store.use(first);
  assert.equal(store.state().cameFrom?.id, second, 'the one just left, not this one');
  assert.notEqual(store.state().cameFrom?.id, first);

  await store.use(second);
  await store.remove(first);
  assert.equal(store.state().cameFrom, null, 'a book that is gone is not a source');
  await assert.rejects(store.copyBook(first, store.state().activeBook), /nothing to copy/);
});
