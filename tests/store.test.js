import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { createStore } from '../extension/store.js';
import { applyChange, normalizeAPI, parseConnectLink, readBookFile } from '../extension/shared.js';

const address = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
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
  const apply = ({ address, scope, tags }) => {
    revision += 1;
    const next = tags.length ? { address, scope, tags, version: 'v' + revision } : null;
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
    return response({ record: apply({ address: at, scope, tags: body.tags }) }, 200, `"${revision}"`);
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
const write = (store, tags, { book = store.state().activeBook, at = address, version = null } = {}) =>
  store.save({ book, address: at, scope: 'global', tags, version });

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

test('a server book is named after its host unless it is given a name', async () => {
  const { store } = harness();
  await store.init();
  await store.add({ storage: onServer });
  assert.equal(store.state().bookName, '127.0.0.1');
});

test('a new book can start as a copy, and will not be poured into one already in use', async () => {
  const copied = harness({ remote: [] });
  await copied.store.init();
  const device = copied.store.state().activeBook;
  await write(copied.store, ['Treasury']);
  await copied.store.add({ name: 'Team', storage: onServer, copyFrom: device });
  assert.deepEqual(copied.remote().map(entry => entry.tags[0]), ['Treasury']);

  const occupied = harness({ remote: [{ address: other, scope: 'global', tags: ['Theirs'], version: 'one' }] });
  await occupied.store.init();
  await write(occupied.store, ['Mine']);
  await assert.rejects(
    occupied.store.add({ name: 'Team', storage: onServer, copyFrom: occupied.store.state().activeBook }),
    /already holds a book/);
  assert.equal(occupied.store.state().books.length, 1, 'a refused book is not half made');
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

test('a book carried in from a file joins the one that is open, replacing matching names', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  const { added } = await store.merge([
    { address, scope: 'global', tags: ['Renamed'], version: 'from-file' },
    { address: other, scope: 'eip155:8453', tags: ['Payroll'], version: 'from-file' },
  ]);
  assert.equal(added, 2);
  const names = Object.fromEntries(store.state().records.map(entry => [entry.address, entry.tags[0]]));
  assert.deepEqual(names, { [address]: 'Renamed', [other]: 'Payroll' });
  assert.ok(store.state().records.every(entry => entry.version !== 'from-file'),
    'the receiving book issues its own versions');
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

test('the same server is never two address books', async () => {
  const { store } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  await assert.rejects(store.add({ name: 'Team again', storage: onServer }), /already one of your address books/);
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
  const result = await store.merge(readBookFile(csv));
  assert.equal(result.added, 3);
  assert.deepEqual(store.state().records.map(item => [item.address, item.scope, item.tags[0]]).sort(),
    [[address, 'eip155:1', 'Treasury'], [address, 'eip155:137', 'Treasury'],
     [other, 'eip155:8453', 'Operations, EU']].sort());
});

// A chain nobody here has heard of is still a network the record belongs to.
test('a Safe row keeps a chain this build does not know, and an empty chain is every network', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(['address,name,chainId', `${address},Treasury,43114`, `${other},Everywhere,`].join('\n')));
  assert.deepEqual(store.state().records.map(item => item.scope).sort(), ['eip155:43114', 'global']);
});

// A spreadsheet leaves a byte-order mark behind; it is not content.
test('a Safe export saved by a spreadsheet still reads', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(`\uFEFFaddress,name,chainId\n${address},Treasury,1\n`));
  assert.equal(store.state().records[0].tags[0], 'Treasury');
});

// Versions are issued by the book that receives a record, so a file that has
// never been in a book has none to give.
test('a file imports without carrying a version, and the book issues one', async () => {
  const { store } = harness();
  await store.init();
  await store.merge(readBookFile(JSON.stringify({ records: [{ address, tags: ['Treasury'] }] })));
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
  await second.store.merge(readBookFile(exported));
  assert.deepEqual(second.store.state().records.map(item => item.tags), [['Treasury', 'Operations']]);
});

test('a file that is neither is refused, and a bad row says which row', async () => {
  assert.throws(() => readBookFile('name,address\nTreasury,0x1'), /not a 0xtagger export or a Safe address book/);
  const { store } = harness();
  await store.init();
  await assert.rejects(store.merge(readBookFile(['address,name,chainId', `${address},Treasury,1`, 'not-an-address,Oops,1'].join('\n'))),
    /Row 2: that is not a full Ethereum address/);
  assert.equal(store.state().records.length, 0, 'one file is one decision');
});
