import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../extension/store.js';
import { normalizeAPI, parseConnectLink } from '../extension/shared.js';

const address = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
const host = 'http://127.0.0.1:8712';
const token = 'test-only-secret';
const onServer = { kind: 'server', url: host, token };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });

function harness({ remote = [] } = {}) {
  const saved = {};
  const calls = [];
  let book = remote;
  let intercept;
  let counter = 0;
  const storage = {
    get: async keys => {
      const all = structuredClone(saved);
      if (keys === null || keys === undefined) return all;
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter(key => key in all).map(key => [key, all[key]]));
    },
    set: async entries => Object.assign(saved, structuredClone(entries)),
    remove: async keys => { for (const key of [].concat(keys)) delete saved[key]; },
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (intercept) { const result = await intercept(url, options); if (result) return result; }
    if (!options.method) return response({ records: book });
    const [, tail] = url.split('/labels/');
    const scope = decodeURIComponent(tail.split('/')[0]);
    const at = tail.split('/')[1];
    const body = JSON.parse(options.body);
    const current = book.find(item => item.address === at && item.scope === scope) || null;
    if (body.version !== (current?.version || null)) return response({ current }, 409);
    const next = body.labels.length ? { address: at, scope, labels: body.labels, version: 'v' + calls.length } : null;
    book = [...book.filter(item => item.address !== at || item.scope !== scope), ...(next ? [next] : [])];
    return response({ record: next });
  };
  const make = () => createStore({ storage, fetch, now: () => 100, uuid: () => `id-${++counter}` });
  return { store: make(), make, saved, calls, storage, fetch,
    remote: () => book, intercept: value => { intercept = value; } };
}
const write = (store, labels, { book = store.state().activeBook, at = address, version = null } = {}) =>
  store.save({ book, address: at, scope: 'global', labels, version });

test('a book exists before anything is set up, and labeling needs no connection', async () => {
  const { store, saved } = harness();
  await store.init();
  assert.equal(store.state().books.length, 1);
  assert.equal(store.state().books[0].where, 'On this device');
  await write(store, ['Treasury']);
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Treasury']);
  assert.ok(saved[`book:${store.state().activeBook}`], 'the device book is the storage, not a cache of one');
});

test('a device book survives a restart and removing every name deletes the record', async () => {
  const first = harness();
  await first.store.init();
  await write(first.store, ['Treasury']);
  const version = first.store.state().records[0].version;

  const resumed = first.make();
  await resumed.init();
  assert.deepEqual(resumed.state().records.map(entry => entry.labels[0]), ['Treasury']);
  await write(resumed, [], { version });
  assert.deepEqual(resumed.state().records, []);
});

test('a stale version is refused rather than quietly overwriting the newer names', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['First']);
  await assert.rejects(write(store, ['Second']),
    error => error.status === 409 && error.current.labels[0] === 'First');
});

test('an unreadable device book is never presented, or saved over, as an empty one', async () => {
  const { store, storage, make } = harness();
  await store.init();
  await storage.set({ [`book:${store.state().activeBook}`]: [{ address, scope: 'global', labels: [] }] });
  const resumed = make();
  await resumed.init();
  assert.equal(resumed.state().records.length, 0);
  assert.match(resumed.state().error, /record/i);
  await assert.rejects(write(resumed, ['Treasury']));
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
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Mine']);
  await store.use(store.state().books.find(item => item.name === 'Team').id);
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Shared']);
  assert.deepEqual(remote().map(entry => entry.labels[0]), ['Shared'], 'the server holds only its own book');
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
  assert.deepEqual(copied.remote().map(entry => entry.labels[0]), ['Treasury']);

  const occupied = harness({ remote: [{ address: other, scope: 'global', labels: ['Theirs'], version: 'one' }] });
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
  const { store, intercept } = harness({ remote: [{ address, scope: 'global', labels: ['Shared'], version: 'one' }] });
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  intercept(() => { throw new Error('offline'); });
  await store.refresh();
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Shared']);
  assert.match(store.state().error, /could not be reached/);
});

test('removing a device book takes its addresses; removing a server book only forgets it', async () => {
  const { store, saved, remote } = harness({ remote: [] });
  await store.init();
  const device = store.state().activeBook;
  await write(store, ['Mine']);
  await store.add({ name: 'Team', storage: onServer });
  await write(store, ['Shared']);
  const team = store.state().activeBook;

  await store.remove(team);
  assert.deepEqual(remote().map(entry => entry.labels[0]), ['Shared'], 'the server still holds it');
  assert.equal(store.state().activeBook, device);

  await store.add({ name: 'Second', storage: { kind: 'device' } });
  const second = store.state().activeBook;
  await write(store, ['Scratch']);
  await store.remove(second);
  assert.equal(saved[`book:${second}`], undefined, 'its addresses go with it');
});

test('there is always an address book to label into', async () => {
  const { store } = harness();
  await store.init();
  await assert.rejects(store.remove(store.state().activeBook), /at least one/);
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
  const { store, storage, make, remote } = harness();
  await store.init();
  await store.add({ name: 'Team', storage: onServer });
  // The worker stops after the write leaves, so the book never hears the answer.
  await storage.set({ needsRefresh: true });
  const resumed = make();
  await resumed.init();
  await write(resumed, ['Treasury']);
  assert.deepEqual(remote().map(entry => entry.labels[0]), ['Treasury']);
  assert.equal(remote().length, 1, 'the write is not repeated');
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
  assert.deepEqual(store.state().records.map(entry => entry.labels), [['Treasury']]);
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
  assert.deepEqual(remote().map(entry => entry.labels), [['Treasury']], 'the write is neither repeated nor disputed');
});

test('a book carried in from a file joins the one that is open, replacing matching names', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  const { added } = await store.merge([
    { address, scope: 'global', labels: ['Renamed'], version: 'from-file' },
    { address: other, scope: 'eip155:8453', labels: ['Payroll'], version: 'from-file' },
  ]);
  assert.equal(added, 2);
  const names = Object.fromEntries(store.state().records.map(entry => [entry.address, entry.labels[0]]));
  assert.deepEqual(names, { [address]: 'Renamed', [other]: 'Payroll' });
  assert.ok(store.state().records.every(entry => entry.version !== 'from-file'),
    'the receiving book issues its own versions');
});

test('a file that is not a book is refused before anything is written', async () => {
  const { store } = harness();
  await store.init();
  await write(store, ['Treasury']);
  await assert.rejects(store.merge([{ address, scope: 'global', labels: [] }]));
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Treasury']);
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
