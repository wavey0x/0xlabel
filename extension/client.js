import { findRecord, normalizeAPI, normalizeLabels, normalizeScope, parseAddress, validateRecord, validateSnapshot } from './shared.js';

const storageKey = url => `connection:${url}`;

// Only this worker-owned object sees credentials. Storage has one entry per URL.
export function createClient({ storage, fetch: fetcher = globalThis.fetch, notify = () => {}, now = Date.now }) {
  let active = null;
  let generation = 0;
  let revision = 0;
  const connections = new Map();
  let queue = Promise.resolve();
  let pull = null;
  let selections = Promise.resolve();

  async function init() {
    const saved = await storage.get(null);
    generation = (saved.selectionGeneration ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Invalid saved selection state.');
    for (const [key, value] of Object.entries(saved)) {
      if (key.startsWith('connection:') && value?.url && value?.token) {
        try {
          const url = normalizeAPI(value.url);
          if (key !== storageKey(url)) continue;
          const records = validateSnapshot(value);
          connections.set(url, { ...value, url, records });
        } catch { /* A malformed saved entry is never used as another book. */ }
      }
    }
    if (connections.has(saved.activeConnection)) active = saved.activeConnection;
    await storage.set({ selectionGeneration: generation });
  }

  function state() {
    const connection = connections.get(active);
    return {
      connectionKey: active, selectionGeneration: generation, stateRevision: revision,
      connectionName: connection?.name || '', records: connection?.records || [],
      syncedAt: connection?.syncedAt || null, error: connection?.error || null,
      connections: [...connections.values()].map(({ url, name }) => ({ url, name })),
    };
  }

  function changed() { revision++; notify(state()); }
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function capture(url = active) {
    const connection = connections.get(url);
    if (!connection) throw new Error('Connect to an API first.');
    return { url, token: connection.token, generation };
  }
  function current(request) {
    return active === request.url && generation === request.generation && connections.get(request.url)?.token === request.token;
  }

  async function request(source, path, options = {}) {
    let response;
    try {
      response = await fetcher(source.url + path, {
        ...options, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${source.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch {
      throw new Error('The API could not be reached. Your cached book is unchanged.');
    }
    let body;
    try { body = await response.json(); }
    catch { throw new Error('The API returned an unreadable response. Your cached book is unchanged.'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'The access token was rejected. Update this connection in Settings.' :
        typeof body.detail === 'string' ? body.detail : 'The API rejected this request.');
      error.status = response.status;
      if (response.status === 409) error.current = body.current === null ? null : validateRecord(body.current);
      throw error;
    }
    return body;
  }

  async function persist(url, update) {
    const old = connections.get(url);
    const next = { ...old, ...update };
    await storage.set({ [storageKey(url)]: next });
    connections.set(url, next);
  }

  async function connect({ url: value, token: supplied, name }) {
    const url = normalizeAPI(value);
    const token = supplied?.trim() || connections.get(url)?.token;
    if (!token) throw new Error('Enter the access token from this API.');
    const start = generation;
    return serial(async () => {
      if (generation !== start) throw new Error('The selected connection changed. Try connecting again.');
      const records = validateSnapshot(await request({ url, token }, '/labels'));
      if (generation !== start) throw new Error('The selected connection changed. Try connecting again.');
      const entry = { url, token, name: name?.trim() || (new URL(url).protocol === 'http:' ? 'Local' : new URL(url).hostname),
        records, syncedAt: now(), error: null };
      await storage.set({ [storageKey(url)]: entry });
      connections.set(url, entry);
      if (generation !== start) throw new Error('The selected connection changed. The new connection was saved but not selected.');
      await select(url);
      return state();
    });
  }

  async function select(value) {
    const url = normalizeAPI(value);
    if (!connections.has(url)) throw new Error('Add this connection first.');
    active = url;
    generation++;
    changed();
    const selectedGeneration = generation;
    selections = selections.catch(() => {}).then(() => storage.set({ activeConnection: url, selectionGeneration: selectedGeneration }));
    await selections;
    return state();
  }

  function refresh() {
    if (!active) return Promise.resolve(state());
    const source = capture();
    if (pull && pull.generation === source.generation && pull.url === source.url) return pull.promise;
    const promise = serial(async () => {
      if (!current(source)) return state();
      try {
        const records = validateSnapshot(await request(source, '/labels'));
        if (!current(source)) return state();
        await persist(source.url, { records, syncedAt: now(), error: null, needsRefresh: false });
      } catch (error) {
        if (!current(source)) return state();
        await persist(source.url, { error: error.message });
      }
      if (current(source)) changed();
      return state();
    });
    pull = { ...source, promise };
    promise.finally(() => { if (pull?.promise === promise) pull = null; }).catch(() => {});
    return promise;
  }

  async function save({ connectionKey, address: value, scope: rawScope, labels: names, version }) {
    if (connectionKey !== active) throw new Error('This draft belongs to another connection. Switch back to save it, or cancel.');
    const source = capture(connectionKey);
    const address = parseAddress(value);
    if (!address) throw new Error('Use a full Ethereum address.');
    const scope = normalizeScope(rawScope);
    const labels = normalizeLabels(names);
    if (!(version === null || typeof version === 'string')) throw new Error('Refresh this record before saving.');
    return serial(async () => {
      if (!current(source)) throw new Error('The connection changed before saving. Switch back and try again.');
      if (connections.get(source.url).needsRefresh) {
        const records = validateSnapshot(await request(source, '/labels'));
        if (!current(source)) throw new Error('The connection changed.');
        await persist(source.url, { records, syncedAt: now(), error: null, needsRefresh: false });
        const latest = findRecord(records, address, scope);
        if ((latest?.version || null) !== version) {
          const conflict = new Error('The previous save may have completed. Review the current list before saving again.');
          conflict.current = latest;
          conflict.status = 409;
          changed();
          throw conflict;
        }
      }
      let body;
      // A single bit survives a worker stopping mid-write; it is not a write queue.
      await persist(source.url, { needsRefresh: true });
      if (!current(source)) throw new Error('The connection changed before saving. Switch back and try again.');
      try {
        body = await request(source, `/labels/${encodeURIComponent(scope)}/${address}`, {
          method: 'PUT', body: JSON.stringify({ labels, version }),
        });
      } catch (error) {
        if (error.status === 409) {
          if (error.current && (error.current.address !== address || error.current.scope !== scope)) {
            throw new Error('The API returned a conflict for a different record. Refresh before trying again.');
          }
          const entries = connections.get(source.url).records.filter(entry => entry.address !== address || entry.scope !== scope);
          if (error.current) entries.push(error.current);
          await persist(source.url, { records: entries, needsRefresh: false });
          if (current(source)) changed();
        } else if (error.status && error.status < 500) {
          await persist(source.url, { needsRefresh: false });
        }
        throw error;
      }
      const saved = body.record === null ? null : validateRecord(body.record);
      if ((saved && (saved.address !== address || saved.scope !== scope || JSON.stringify(saved.labels) !== JSON.stringify(labels))) ||
          (!saved && labels.length) || (saved && !labels.length)) {
        throw new Error('The API confirmed a different record. Refresh before trying again.');
      }
      const records = connections.get(source.url).records.filter(entry => entry.address !== address || entry.scope !== scope);
      if (saved) records.push(saved);
      await persist(source.url, { records, error: null, needsRefresh: false });
      if (current(source)) changed();
      return { state: state() };
    });
  }

  return { init, state, connect, select, refresh, save };
}
