import { findRecord, validateSnapshot } from '../shared.js';

// The simplest book there is. It lives in this browser profile, nothing else
// writes to it, and a save is one atomic write. No server, no account, no setup.
export function createDeviceBook({ storage, key, now = Date.now }) {
  // A book that cannot be read is never treated as an empty book, because the
  // next save would write that emptiness over whatever is really there.
  const read = async () => {
    const saved = (await storage.get(key))[key];
    return saved === undefined ? [] : validateSnapshot({ records: saved });
  };

  return {
    load: read,
    async put({ address, scope, labels, version }) {
      const records = await read();
      const existing = findRecord(records, address, scope);
      if ((existing?.version ?? null) !== version) {
        const conflict = new Error('Saved elsewhere while you were editing.');
        conflict.status = 409;
        conflict.current = existing;
        throw conflict;
      }
      const rest = records.filter(entry => entry.address !== address || entry.scope !== scope);
      const saved = labels.length ? { address, scope, labels, version: String(now()) } : null;
      await storage.set({ [key]: saved ? [...rest, saved] : rest });
      return saved;
    },
  };
}
