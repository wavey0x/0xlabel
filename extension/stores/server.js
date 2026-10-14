import { validateRecord, validateSnapshot } from '../shared.js';

// A book kept by a server the person runs. This is only the transport: the
// store above it owns the cached copy, so an unreachable server costs freshness
// and not the book itself.
export function createServerBook({ url, token, fetch: fetcher = globalThis.fetch }) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetcher(url + path, {
        ...options, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch {
      throw new Error('That server could not be reached. Your saved book is unchanged.');
    }
    let body;
    try { body = await response.json(); }
    catch { throw new Error('That server returned an unreadable reply. Your saved book is unchanged.'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'That server rejected the access key. Paste its link again.' :
        typeof body.detail === 'string' ? body.detail : 'That server rejected the request.');
      error.status = response.status;
      if (response.status === 409) error.current = body.current === null ? null : validateRecord(body.current);
      throw error;
    }
    return body;
  }

  return {
    // A write can be interrupted between leaving here and being recorded, so the
    // store refreshes before retrying one rather than repeating it blindly.
    uncertainWrites: true,
    async load() {
      return validateSnapshot(await request('/labels'));
    },
    async put({ address, scope, labels, version }) {
      const body = await request(`/labels/${encodeURIComponent(scope)}/${address}`, {
        method: 'PUT', body: JSON.stringify({ labels, version }),
      });
      const saved = body.record === null ? null : validateRecord(body.record);
      if ((saved && (saved.address !== address || saved.scope !== scope ||
           JSON.stringify(saved.labels) !== JSON.stringify(labels))) ||
          (!saved && labels.length) || (saved && !labels.length)) {
        throw new Error('That server confirmed a different record. Refresh before trying again.');
      }
      return saved;
    },
  };
}
