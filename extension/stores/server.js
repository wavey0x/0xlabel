import { validateRecord, validateSnapshot } from '../shared.js';

// A book kept by a server the person runs. This is only the transport: the
// store above it owns the cached copy, so an unreachable server costs freshness
// and not the book itself.
const BATCH = 1000;

export function createServerBook({ url, token, fetch: fetcher = globalThis.fetch }) {
  async function request(path, { headers = {}, ...options } = {}) {
    let response;
    try {
      response = await fetcher(url + path, {
        ...options, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      });
    } catch {
      throw new Error('That server could not be reached. Your saved book is unchanged.');
    }
    const mark = response.headers?.get?.('ETag') || null;
    // The book has not changed since the copy we hold, so there is no body.
    if (response.status === 304) return { unchanged: true, mark };
    let body;
    try { body = await response.json(); }
    catch { throw new Error('That server returned an unreadable reply. Your saved book is unchanged.'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'That server rejected the access key. Paste its link again.' :
        typeof body.detail === 'string' ? body.detail : 'That server rejected the request.');
      error.status = response.status;
      if (response.status === 409) {
        if (body.current !== undefined) error.current = body.current === null ? null : validateRecord(body.current);
        if (Array.isArray(body.conflicts)) error.conflicts = body.conflicts.length;
      }
      throw error;
    }
    return { body, mark };
  }

  function confirm(saved, { address, scope, labels }) {
    if ((saved && (saved.address !== address || saved.scope !== scope ||
         JSON.stringify(saved.labels) !== JSON.stringify(labels))) ||
        (!saved && labels.length) || (saved && !labels.length)) {
      throw new Error('That server confirmed a different record. Refresh before trying again.');
    }
    return saved;
  }

  async function put({ address, scope, labels, version }) {
    const { body } = await request(`/labels/${encodeURIComponent(scope)}/${address}`, {
      method: 'PUT', body: JSON.stringify({ labels, version }),
    });
    return confirm(body.record === null ? null : validateRecord(body.record), { address, scope, labels });
  }

  return {
    // A write can be interrupted between leaving here and being recorded, so the
    // store refreshes before retrying one rather than repeating it blindly.
    uncertainWrites: true,
    put,
    // The mark is what the server last said this book was. Handing it back lets
    // the server answer "nothing changed" in a couple of hundred bytes, which
    // is the answer almost every sync gets.
    async load(mark) {
      const answer = await request('/labels', { headers: mark ? { 'If-None-Match': mark } : {} });
      if (answer.unchanged) return { records: null, mark: answer.mark || mark };
      return { records: validateSnapshot(answer.body), mark: answer.mark };
    },
    // A file carried in travels in batches, each one a single request the
    // server applies whole. One round trip per thousand addresses, not one per
    // address.
    async putMany(wanted) {
      const saved = [];
      for (let at = 0; at < wanted.length; at += BATCH) {
        const changes = wanted.slice(at, at + BATCH);
        const { body } = await request('/labels', { method: 'PUT', body: JSON.stringify({ changes }) });
        if (!Array.isArray(body.records) || body.records.length !== changes.length) {
          throw new Error('That server confirmed a different number of records. Refresh before trying again.');
        }
        body.records.forEach((record, index) =>
          saved.push(confirm(record === null ? null : validateRecord(record), changes[index])));
      }
      return saved;
    },
  };
}
