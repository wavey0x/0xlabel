import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../extension/store.js';
import { normalizeAPI, parseConnectLink } from '../extension/shared.js';

const address = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
const server = 'http://127.0.0.1:8712';
const token = 'test-only-secret';
const record = (name, version = name, at = address, scope = 'global') => ({ address: at, scope, labels: [name], version });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });

function harness({ remote = [] } = {}) {
  const saved = {};
  const calls = [];
  let book = remote;
  let intercept;
  const storage = {
    get: async keys => {
      const all = structuredClone(saved);
      if (keys === null || keys === undefined) return all;
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter(key => key in all).map(key => [key, all[key]]));
    },
    set: async entries => Object.assign(saved, structuredClone(entries)),
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
  const store = createStore({ storage, fetch, now: () => 100 });
  return { store, saved, calls, storage, fetch,
    remote: () => book, intercept: value => { intercept = value; } };
}
const link = `${server}#key=${token}`;
const useServer = store => store.use('server', { url: server, token });

test('a book exists before anything is set up, and saving needs no connection', async () => {
  const { store, saved } = harness();
  await store.init();
  assert.equal(store.state().location, 'device');
  assert.equal(store.state().locationName, 'On this device');
  await store.save({ location: 'device', address, scope: 'global', labels: ['Treasury'], version: null });
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Treasury']);
  assert.equal(saved.book.length, 1, 'the device book is the storage, not a cache of one');
});

test('a device book survives a restart and removing every name deletes the record', async () => {
  const first = harness();
  await first.store.init();
  await first.store.save({ location: 'device', address, scope: 'global', labels: ['Treasury'], version: null });
  const version = first.store.state().records[0].version;

  const second = createStore({ storage: first.storage, fetch: first.fetch, now: () => 200 });
  await second.init();
  assert.deepEqual(second.state().records.map(entry => entry.labels[0]), ['Treasury']);
  await second.save({ location: 'device', address, scope: 'global', labels: [], version });
  assert.deepEqual(second.state().records, []);
});

test('a stale version is refused rather than quietly overwriting the newer names', async () => {
  const { store } = harness();
  await store.init();
  await store.save({ location: 'device', address, scope: 'global', labels: ['First'], version: null });
  await assert.rejects(
    store.save({ location: 'device', address, scope: 'global', labels: ['Second'], version: null }),
    error => error.status === 409 && error.current.labels[0] === 'First');
});

test('an unreadable device book is never presented, or saved over, as an empty one', async () => {
  const { store, storage } = harness();
  await storage.set({ book: [{ address, scope: 'global', labels: [] }] });
  await store.init();
  assert.equal(store.state().records.length, 0);
  assert.match(store.state().error, /record/i);
  await assert.rejects(store.save({ location: 'device', address, scope: 'global', labels: ['Treasury'], version: null }));
});

test('a connect link carries the key in the fragment, which is never sent to the server', () => {
  assert.deepEqual(parseConnectLink(link), { url: normalizeAPI(server), token });
  assert.deepEqual(parseConnectLink(`  ${server}/#key=${token}  `), { url: normalizeAPI(server), token });
  assert.throws(() => parseConnectLink(server), /access key/);
  assert.throws(() => parseConnectLink('nonsense'), /link/);
});

test('moving to an empty server copies the book there and keeps labeling it', async () => {
  const { store, remote } = harness();
  await store.init();
  await store.save({ location: 'device', address, scope: 'global', labels: ['Treasury'], version: null });
  await useServer(store);
  assert.equal(store.state().location, 'server');
  assert.deepEqual(remote().map(entry => entry.labels[0]), ['Treasury']);
  await store.save({ location: 'server', address: other, scope: 'global', labels: ['Payroll'], version: null });
  assert.deepEqual(remote().map(entry => entry.labels[0]).sort(), ['Payroll', 'Treasury']);
});

test('a server that already holds a book is joined as it is, and the device book waits unchanged', async () => {
  const { store, saved } = harness({ remote: [record('Shared', 'one')] });
  await store.init();
  await store.save({ location: 'device', address: other, scope: 'global', labels: ['Mine'], version: null });
  await useServer(store);
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Shared']);
  assert.deepEqual(saved.book.map(entry => entry.labels[0]), ['Mine'], 'the device book is left where it was');
  await store.use('device');
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Mine']);
});

test('an unreachable server costs freshness, not the book', async () => {
  const { store, intercept } = harness({ remote: [record('Shared', 'one')] });
  await store.init();
  await useServer(store);
  intercept(() => { throw new Error('offline'); });
  await store.refresh();
  assert.deepEqual(store.state().records.map(entry => entry.labels[0]), ['Shared']);
  assert.match(store.state().error, /could not be reached/);
});

test('a draft written for one place is never saved into another', async () => {
  const { store } = harness();
  await store.init();
  await assert.rejects(
    store.save({ location: 'server', address, scope: 'global', labels: ['Treasury'], version: null }),
    /moved/);
});

test('an interrupted write is checked before it is retried', async () => {
  const { store, storage, fetch, remote } = harness();
  await store.init();
  await useServer(store);
  // The worker stops after the write leaves, so the book never hears the answer.
  await storage.set({ needsRefresh: true });
  const resumed = createStore({ storage, fetch, now: () => 300 });
  await resumed.init();
  await resumed.save({ location: 'server', address, scope: 'global', labels: ['Treasury'], version: null });
  assert.deepEqual(remote().map(entry => entry.labels[0]), ['Treasury']);
  assert.equal(remote().length, 1, 'the write is not repeated');
});
