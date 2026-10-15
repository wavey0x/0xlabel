export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 80;

// Marks every element 0xtagger adds to a page. Nothing carrying it is website
// content, so nothing carrying it is ever read as a wallet display.
export const UI_ATTRIBUTE = 'data-0xtagger-ui';
export const UI = `[${UI_ATTRIBUTE}]`;

// Elements that are editable, interactive, or not a display surface. The
// detection kernel and the controller's final check share this one list.
export const UNSAFE_HOST = 'input,textarea,select,script,style,button,[role="button"],.sr-only,' +
  `[aria-hidden="true"],[contenteditable]:not([contenteditable="false"]),${UI}`;

export function parseAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

export function query(root, selector) {
  const children = [...root.querySelectorAll(selector)];
  if (root.nodeType === 1 && root.matches(selector)) children.unshift(root);
  return children;
}

export function normalizeAPI(value) {
  const url = new URL(String(value).trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('Use an API address without credentials, a query, or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Remote APIs require HTTPS. HTTP is allowed only on localhost.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// A server prints one line to paste. The key rides in the fragment, which the
// browser never sends to the server, so pasting it cannot leak it onward.
export function parseConnectLink(value) {
  let link;
  try { link = new URL(String(value).trim()); }
  catch { throw new Error('Invalid server link.'); }
  const key = new URLSearchParams(link.hash.slice(1)).get('key');
  if (!key) throw new Error('That link has no access key. Copy the whole line your server printed.');
  return { url: normalizeAPI(link.origin + link.pathname), token: key };
}

export function hostPermission(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeScope(value) {
  if (value === 'global') return value;
  if (typeof value !== 'string' || !/^eip155:[1-9][0-9]{0,19}$/.test(value)) throw new Error('Use a known network or global tags.');
  return value;
}

export function normalizeTags(values) {
  if (!Array.isArray(values) || values.length > MAX_TAGS) throw new Error(`Use at most ${MAX_TAGS} tags.`);
  const seen = new Set();
  return values.map(value => {
    if (typeof value !== 'string') throw new Error('Tags must be plain text.');
    const tag = value.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || /[\x00-\x1f\x7f]/.test(tag)) throw new Error(`Tags must contain 1–${MAX_TAG_LENGTH} characters.`);
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) throw new Error('Each tag in a list must be distinct.');
    seen.add(key);
    return tag;
  });
}

export function validateRecord(value) {
  if (!value || typeof value !== 'object') throw new Error('The API returned an invalid record.');
  const address = parseAddress(value.address);
  if (!address || typeof value.version !== 'string' || !value.version || value.version.length > 128) throw new Error('The API returned an invalid record.');
  const tags = normalizeTags(value.tags);
  if (!tags.length) throw new Error('An API record cannot have an empty tag list.');
  return { address, scope: normalizeScope(value.scope), tags, version: value.version };
}

export function recordKey(address, scope = 'global') {
  return `${scope}/${address}`;
}

export function validateSnapshot(value) {
  if (!value || !Array.isArray(value.records)) throw new Error('This server did not return a valid 0xtagger book.');
  const seen = new Set();
  return value.records.map(item => {
    const entry = validateRecord(item);
    const key = recordKey(entry.address, entry.scope);
    if (seen.has(key)) throw new Error('The API book contains duplicate records.');
    seen.add(key);
    return entry;
  });
}

// Two tag lists mean the same thing only in the same order: the first tag
// is the one a website shows.
export function sameTags(left, right) {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

export function findRecord(records, address, scope) {
  return records.find(item => item.address === address && item.scope === scope) || null;
}

// One record, applied to the copy a view already holds. Anything other than
// the very next revision of the same book means this view has missed
// something, and the answer to that is to ask for the whole book again.
export function applyChange(state, message) {
  if (!message?.change || message.activeBook !== state.activeBook) return null;
  if (message.stateRevision !== state.stateRevision + 1) return null;
  const { address, scope, record } = message.change;
  const records = state.records.filter(item => item.address !== address || item.scope !== scope);
  if (record) records.push(record);
  return { ...state, records, stateRevision: message.stateRevision,
    syncedAt: message.syncedAt ?? state.syncedAt };
}

// What it would take for `held` to say what `incoming` says: the records that
// differ, and the ones that are gone, named with no tags because that is how
// a removal is written everywhere else. An empty answer means a sync learned
// nothing, which should then cost nothing downstream.
export function difference(held, incoming) {
  const before = new Map(held.map(record => [recordKey(record.address, record.scope), record]));
  const after = new Map(incoming.map(record => [recordKey(record.address, record.scope), record]));
  const changes = [];
  for (const [key, record] of after) if (before.get(key)?.version !== record.version) changes.push(record);
  for (const [key, record] of before) if (!after.has(key)) changes.push({ address: record.address, scope: record.scope, tags: [] });
  return changes;
}

export function indexBook(records) {
  return new Map(records.map(entry => [recordKey(entry.address, entry.scope), entry]));
}

// A book arrives either as our own JSON export or as Safe's address book,
// which is a CSV of `address,name,chainId` with one row per chain. Both say
// the same three things: an address, the tags for it, and the network those
// tags belong to. Reading them here keeps file formats out of the views.
const SAFE_COLUMNS = ['address', 'name', 'chainId'];

// RFC 4180 fields: commas and newlines survive inside quotes, and a doubled
// quote is a literal one. A name people typed is allowed to contain both.
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[at + 1] === '"') { field += '"'; at += 1; }
      else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[at + 1] === '\n') at += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell.trim()));
}

export function readBookFile(text) {
  // A byte-order mark is what a spreadsheet leaves behind; it is not content.
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('{') || body.startsWith('[')) {
    const parsed = JSON.parse(body);
    return parsed.records ?? parsed;
  }
  const [header, ...rows] = csvRows(body);
  if (!header || header.length !== SAFE_COLUMNS.length ||
      !SAFE_COLUMNS.every((column, at) => header[at].trim() === column)) {
    throw new Error('That file is not a 0xtagger export or a Safe address book.');
  }
  // Safe names one chain per row, and names none for an address kept everywhere.
  return rows.map(([address, name, chain]) => ({
    address: address?.trim(),
    tags: [name?.trim()],
    scope: chain?.trim() ? `eip155:${chain.trim()}` : 'global',
  }));
}

// What a file is allowed to carry. The receiving book issues its own versions,
// so an imported record never brings one, and a record that names no network
// is one that stands on every network. Rows are counted the way a spreadsheet
// shows them, because that is where the reader will go to fix it.
export function validateImport(records) {
  if (!Array.isArray(records)) throw new Error('That file is not an address book.');
  const seen = new Set();
  return records.map((item, at) => {
    try {
      const address = parseAddress(item?.address);
      if (!address) throw new Error('That is not a full Ethereum address.');
      const scope = normalizeScope(item.scope ?? 'global');
      const tags = normalizeTags(item.tags);
      if (!tags.length) throw new Error('It names no tags.');
      const key = recordKey(address, scope);
      if (seen.has(key)) throw new Error('This address and network are already in the file.');
      seen.add(key);
      return { address, scope, tags };
    } catch (failure) {
      throw new Error(`Row ${at + 1}: ${failure.message[0].toLowerCase()}${failure.message.slice(1)}`);
    }
  });
}
