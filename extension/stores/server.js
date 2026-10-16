import { sameTags, validateRecord, validateSnapshot } from '../shared.js';

// A book kept by a server the person runs. This is only the transport: the
// store above it owns the cached copy, so an unreachable server costs freshness
// and not the book itself.
// The server applies a batch inside one transaction, and its own limit is
// 5,000 changes. So a confirmed write is one request: splitting it would let
// half a book land and call it done. Anything larger is refused before it is
// sent, which the view enforces before anyone confirms.
const BATCH = 5000;
// Long enough for a server on the other end of a private network, short enough
// that nobody watches a button say "Saving…" wondering whether to press it
// again. A file carried in is the one write that can honestly take longer: it
// is thousands of records in one transaction, and giving up on one that is
// still being applied only buys an uncertain write to reconcile afterwards.
const TIMEOUT = 5000;
const BATCH_TIMEOUT = 20000;

export function createServerBook({ url, token, fetch: fetcher = globalThis.fetch }) {
  async function request(path, { headers = {}, timeout = TIMEOUT, ...options } = {}) {
    let response;
    try {
      response = await fetcher(url + path, {
        ...options, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(timeout),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      });
    } catch {
      // One line, whichever way it failed. A write that never answered may
      // well have landed, so nothing here says it did not: what the book now
      // holds is checked before anything is sent again, and that is the
      // store's business rather than something to read in a popover.
      throw new Error('That server could not be reached.');
    }
    const mark = response.headers?.get?.('ETag') || null;
    // The book has not changed since the copy we hold, so there is no body.
    if (response.status === 304) return { unchanged: true, mark };
    let body;
    try { body = await response.json(); }
    catch { throw new Error('That server returned an unreadable reply.'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? (token
        ? 'That server rejected the access key. Paste its link again.'
        : 'Your Tailscale identity was not allowed to open this address book.') :
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

  function confirm(saved, { address, scope, tags }) {
    if ((saved && (saved.address !== address || saved.scope !== scope ||
         !sameTags(saved.tags, tags))) ||
        (!saved && tags.length) || (saved && !tags.length)) {
      throw new Error('That server confirmed a different record. Refresh before trying again.');
    }
    return saved;
  }

  async function put({ address, scope, tags, version, source }) {
    const { body } = await request(`/tags/${encodeURIComponent(scope)}/${address}`, {
      method: 'PUT', body: JSON.stringify({ tags, version, source: source ?? null }),
    });
    return confirm(body.record === null ? null : validateRecord(body.record), { address, scope, tags });
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
      const answer = await request('/tags', { headers: mark ? { 'If-None-Match': mark } : {} });
      if (answer.unchanged) return { records: null, mark: answer.mark || mark };
      return { records: validateSnapshot(answer.body), mark: answer.mark };
    },
    // A file carried in is one decision, so it is one request the server
    // applies whole: all of it lands or none of it does.
    async putMany(wanted) {
      if (wanted.length > BATCH) {
        throw new Error(`A single write carries at most ${BATCH.toLocaleString()} addresses.`);
      }
      const changes = wanted.map(({ source, ...change }) => ({ ...change, source: source ?? null }));
      const { body } = await request('/tags', { method: 'PUT', body: JSON.stringify({ changes }), timeout: BATCH_TIMEOUT });
      if (!Array.isArray(body.records) || body.records.length !== changes.length) {
        throw new Error('That server confirmed a different number of records. Refresh before trying again.');
      }
      return body.records.map((record, index) =>
        confirm(record === null ? null : validateRecord(record), changes[index]));
    },
  };
}
