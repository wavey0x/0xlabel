import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../extension/client.js';
import { normalizeAPI, validateSnapshot } from '../extension/shared.js';

const address = '0x' + 'ab'.repeat(20);
const local = 'http://127.0.0.1:8712';
const remote = 'https://remote.example/book';
const record = (name, version = name, scope = 'global') => ({ address, scope, labels: [name], version });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });

function harness() {
  const saved = {};
  const calls = [];
  const books = new Map([[local, [record('Local')]], [remote, []]]);
  let intercept;
  const storage = { get: async () => structuredClone(saved), set: async entries => Object.assign(saved, structuredClone(entries)) };
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (intercept) { const result = await intercept(url, options); if (result) return result; }
    const base = url.replace(/\/labels(?:\/.*)?$/, '');
    if (!options.method) return response({ records: books.get(base) });
    const scope = decodeURIComponent(url.split('/labels/')[1].split('/')[0]);
    const body = JSON.parse(options.body);
    const current = books.get(base).find(item => item.address === address && item.scope === scope) || null;
    if (body.version !== (current?.version || null)) return response({ current }, 409);
    const savedRecord = body.labels.length ? { address, scope, labels: body.labels, version: String(calls.length) } : null;
    books.set(base, [...books.get(base).filter(item => item.scope !== scope), ...(savedRecord ? [savedRecord] : [])]);
    return response({ record: savedRecord });
  };
  const client = createClient({ storage, fetch, now: () => 100 });
  return { client, calls, books, saved, storage, fetch, intercept: value => { intercept = value; } };
}
const connect = (client, url) => client.connect({ url, token: 'test-only-secret', name: url === local ? 'Local' : 'Remote' });

test('URL namespaces preserve ports and paths; remote HTTP and ambiguous bases are rejected', () => {
  assert.equal(normalizeAPI('https://EXAMPLE.com:443/book///'), 'https://example.com/book');
  assert.notEqual(normalizeAPI(local), normalizeAPI('http://127.0.0.1:8713'));
  assert.notEqual(normalizeAPI(remote), normalizeAPI('https://remote.example/other'));
  for (const value of ['http://remote.example', 'https://user:password@example.com', 'https://example.com?book=x', 'https://example.com#x']) assert.throws(() => normalizeAPI(value));
});

test('Local → empty Remote → Local preserves both caches and sends only GET', async () => {
  const h = harness(); await h.client.init();
  await connect(h.client, local); const retained = structuredClone(h.saved[`connection:${local}`]);
  await connect(h.client, remote); await h.client.refresh();
  assert.deepEqual(h.client.state().records, []);
  assert.deepEqual(h.saved[`connection:${local}`], retained);
  await h.client.select(local); assert.deepEqual(h.client.state().records, retained.records);
  await h.client.refresh(); assert.equal(h.calls.filter(call => call.method).length, 0);
  const publicText = JSON.stringify(h.client.state());
  assert.ok(!publicText.includes('secret') && !publicText.includes('token'));
  const restarted = createClient({ storage: h.storage, fetch: h.fetch });
  await restarted.init(); assert.equal(restarted.state().records[0].labels[0], 'Local');
  assert.ok(restarted.state().selectionGeneration > h.client.state().selectionGeneration);
});

test('full snapshots reflect deletions; failed and malformed pulls retain the last good book/time', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local);
  const before = structuredClone(h.client.state());
  h.intercept(() => { throw new Error('offline'); }); await h.client.refresh();
  assert.deepEqual(h.client.state().records, before.records); assert.equal(h.client.state().syncedAt, before.syncedAt);
  h.intercept(() => response({ records: [{ address: '0x123', labels: [] }] })); await h.client.refresh();
  assert.deepEqual(h.client.state().records, before.records);
  h.intercept(null); h.books.set(local, []); await h.client.refresh();
  assert.deepEqual(h.client.state().records, []);
});

test('incomplete saved books are rejected rather than decoded as empty books', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local);
  const retained = structuredClone(h.saved[`connection:${local}`]);
  h.saved[`connection:${remote}`] = { url: remote, token: 'fixture', name: 'Remote' };
  h.saved.activeConnection = remote;
  const restarted = createClient({ storage: h.storage, fetch: h.fetch });
  await restarted.init();
  assert.equal(restarted.state().connectionKey, null);
  assert.deepEqual(restarted.state().connections.map(entry => entry.url), [local]);
  assert.deepEqual(h.saved[`connection:${local}`], retained);
  assert.equal(h.calls.filter(call => call.method).length, 0);
});

test('coalesced pulls and A → B → A discard a late snapshot', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local); await connect(h.client, remote); await h.client.select(local);
  const gate = deferred(); const began = deferred();
  h.intercept((url, options) => { if (!options.method) { began.resolve(); return gate.promise; } });
  const one = h.client.refresh(); const two = h.client.refresh(); assert.equal(one, two);
  await began.promise;
  await h.client.select(remote); await h.client.select(local);
  gate.resolve(response({ records: [record('Must be ignored')] })); await one;
  assert.equal(h.client.state().records[0].labels[0], 'Local');
});

test('stale drafts are rejected; already started writes retain their original destination', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local); await connect(h.client, remote); await h.client.select(local);
  const draft = { connectionKey: local, address, scope: 'global', labels: ['Edited Local'], version: 'Local' };
  await h.client.select(remote); await assert.rejects(h.client.save(draft), /another connection/);
  await h.client.select(local);
  const gate = deferred(), began = deferred();
  h.intercept((url, options) => { if (options.method) { began.resolve(); return gate.promise; } });
  const write = h.client.save(draft); await began.promise; await h.client.select(remote);
  gate.resolve(response({ record: record('Edited Local', 'new') })); await write;
  assert.equal(h.client.state().connectionKey, remote); assert.deepEqual(h.client.state().records, []);
  assert.equal(h.saved[`connection:${local}`].records[0].labels[0], 'Edited Local');
  assert.equal(h.calls.at(-1).url, local + '/labels/global/' + address);
});

test('uncertain writes survive worker restart and refresh before a retry; conflicts preserve server state', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local);
  const draft = { connectionKey: local, address, scope: 'global', labels: ['My draft'], version: 'Local' };
  h.intercept((url, options) => {
    if (options.method) { h.books.set(local, [record('My draft', 'committed')]); throw new Error('reply lost'); }
  });
  await assert.rejects(h.client.save(draft));
  assert.equal(h.saved[`connection:${local}`].needsRefresh, true);
  h.intercept(null);
  const restarted = createClient({ storage: h.storage, fetch: h.fetch }); await restarted.init();
  const writes = h.calls.filter(call => call.method).length;
  await assert.rejects(restarted.save(draft), error => error.status === 409 && error.current.version === 'committed');
  assert.equal(h.calls.filter(call => call.method).length, writes);
  assert.equal(restarted.state().records[0].version, 'committed');
  assert.equal(h.saved[`connection:${local}`].needsRefresh, false);
});

test('malformed write confirmation is not treated as a successful save', async () => {
  const h = harness(); await h.client.init(); await connect(h.client, local);
  h.intercept((url, options) => options.method && response({ record: null }));
  await assert.rejects(h.client.save({ connectionKey: local, address, scope: 'global', labels: ['New'], version: 'Local' }), /different record/);
  assert.equal(h.saved[`connection:${local}`].records[0].labels[0], 'Local');
  assert.equal(h.saved[`connection:${local}`].needsRefresh, true);
});

test('snapshots preserve independent ordered network lists and reject duplicate records', () => {
  const records = [record('Global'), { ...record('Base', '2', 'eip155:8453'), labels: ['Base', 'Second'] }];
  assert.deepEqual(validateSnapshot({ records }), records);
  assert.throws(() => validateSnapshot({ records: [records[0], records[0]] }));
});
