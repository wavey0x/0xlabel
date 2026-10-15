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

// Where a record came from, named as a kind rather than as a host: a host
// alone cannot tell someone's private tag from a public explorer label. It is
// set when the record is created and never rewritten, because it describes
// history rather than permission — a name corrected later still came from
// wherever it came from. It ranks nothing and permits nothing.
export const SOURCES = ['safe:address-book', 'safe:page', 'etherscan:page'];

export function normalizeSource(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!SOURCES.includes(value)) throw new Error('That is not a source a record can carry.');
  return value;
}

// What to call a source in front of a person. A live suggestion is described in
// the present tense, because the name in the field is the site's at that moment.
// A stored record is described as history, because the name may since have been
// rewritten and still came from wherever it came from.
const SOURCE_NAMES = {
  'safe:address-book': "Safe's address book",
  'safe:page': 'Safe',
  'etherscan:page': 'Etherscan',
};
export const sourceName = source => SOURCE_NAMES[source] || '';
export const suggestedBy = source => (SOURCE_NAMES[source] ? `Suggested by ${SOURCE_NAMES[source]}` : '');
export const addedFrom = source => (SOURCE_NAMES[source] ? `Added from ${SOURCE_NAMES[source]}` : '');

// Records carry a source only when they have one, so a record composed by hand
// is the plain object it has always been.
const withSource = (record, source) => (source ? { ...record, source } : record);

// A name a website displays is worth offering back only if it is a name: not
// an address or a piece of one, and nothing a tag could not hold anyway. Which
// of a site's own words are placeholders is its adapter's business, not this
// one's. Nothing here restricts what a person may deliberately type.
export function usableName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || /^(?:[a-z]+:)?0x[0-9a-f]/i.test(name)) return null;
  try { return normalizeTags([name])[0]; } catch { return null; }
}

export function validateRecord(value) {
  if (!value || typeof value !== 'object') throw new Error('The API returned an invalid record.');
  const address = parseAddress(value.address);
  if (!address || typeof value.version !== 'string' || !value.version || value.version.length > 128) throw new Error('The API returned an invalid record.');
  const tags = normalizeTags(value.tags);
  if (!tags.length) throw new Error('An API record cannot have an empty tag list.');
  return withSource({ address, scope: normalizeScope(value.scope), tags, version: value.version }, normalizeSource(value.source));
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

// A book arrives in one of three shapes: our own JSON export, Safe's address
// book — `address,name,chainId` with a header and one row per chain — or Safe's
// signer export, which is written from bare arrays and so carries no header at
// all, two columns, and a blank name for a signer nobody has named. All three
// say the same things: an address, the tags for it, and the network those tags
// belong to. Reading them here keeps file formats out of the views.
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

// Returns the records a file names, and how many rows named an address but no
// name. A row that names nobody says nothing, so it carries nothing in — but it
// is not a broken file either, and the reader is told how many it passed over.
export function readBookFile(text) {
  // A byte-order mark is what a spreadsheet leaves behind; it is not content.
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('{') || body.startsWith('[')) {
    const parsed = JSON.parse(body);
    return { records: parsed.records ?? parsed, unnamed: 0 };
  }
  const rows = csvRows(body);
  // A signer export opens on data rather than on column names, and nothing else
  // begins with a whole address, so the first cell settles which file this is.
  const headerless = Boolean(parseAddress(rows[0]?.[0]?.trim()));
  if (!headerless) {
    const header = rows.shift();
    if (!header || header.length !== SAFE_COLUMNS.length ||
        !SAFE_COLUMNS.every((column, at) => header[at].trim() === column)) {
      throw new Error('That file is not a 0xtagger export or a Safe address book.');
    }
  }
  const records = rows.map(([address, name, chain], at) => ({
    // Both of Safe's files are Safe's own address book, however they are laid
    // out, so a record read from one says where it came from.
    source: 'safe:address-book',
    // The line a spreadsheet shows this on, carried so that dropping an unnamed
    // row above a broken one cannot renumber the complaint about the broken one.
    row: at + (headerless ? 1 : 2),
    address: address?.trim(),
    tags: [name?.trim()],
    // Safe names one chain per address-book row, and names none for an address
    // kept everywhere. A signer export names none at all, because a signer is a
    // person rather than a deployment: which networks they stand on is the
    // reader's choice to make, not ours to infer from the file it came in.
    scope: !headerless && chain?.trim() ? `eip155:${chain.trim()}` : 'global',
  }));
  const named = records.filter(record => record.tags[0]);
  return { records: named, unnamed: records.length - named.length };
}

// What a file is allowed to carry. The receiving book issues its own versions,
// so an imported record never brings one, and a record that names no network
// is one that stands on every network. Rows are counted the way a spreadsheet
// shows them, because that is where the reader will go to fix it.
function entryOf(item, seen) {
  const address = parseAddress(item?.address);
  if (!address) throw new Error('That is not a full Ethereum address.');
  const scope = normalizeScope(item.scope ?? 'global');
  const tags = normalizeTags(item.tags);
  if (!tags.length) throw new Error('It names no tags.');
  const key = recordKey(address, scope);
  if (seen.has(key)) throw new Error('This address and network are already in the file.');
  seen.add(key);
  return withSource({ address, scope, tags }, normalizeSource(item.source));
}

export function validateImport(records) {
  if (!Array.isArray(records)) throw new Error('That file is not an address book.');
  const seen = new Set();
  return records.map((item, at) => {
    try { return entryOf(item, seen); }
    catch (failure) {
      throw new Error(`Row ${item?.row ?? at + 1}: ${failure.message[0].toLowerCase()}${failure.message.slice(1)}`);
    }
  });
}

// What an import would do to the book it is going into: the records it would
// add, how many addresses it names that this book already names, and the rows
// that are not records at all.
//
// An address already in the book is kept as it is, whatever network either
// side names it on: the unit is the address, the same as it is everywhere
// else, and comparing two names is a job for the editor rather than for the
// busiest screen in the app. A row nobody can read does not stop the rest —
// it is set aside with its reason, and the readable rows still come in.
// A name already in a book covers an incoming one when it stands on the same
// network, or on every network. A name on some other chain covers nothing
// here: an address named on Ethereum is still nameless on Base, and leaving it
// that way would be the import quietly deciding it knew better.
export function alreadyNamed(index, { address, scope }) {
  return index.has(recordKey(address, scope)) || index.has(recordKey(address, 'global'));
}

export function reviewImport(records, held = []) {
  if (!Array.isArray(records)) throw new Error('That file is not an address book.');
  const known = new Set(held.map(record => recordKey(record.address, record.scope)));
  const seen = new Set();
  const add = [];
  const invalid = [];
  let kept = 0;
  records.forEach((item, at) => {
    const row = item?.row ?? at + 1;
    let entry;
    try { entry = entryOf(item, seen); }
    catch (failure) { invalid.push({ row, reason: failure.message }); return; }
    if (alreadyNamed(known, entry)) kept += 1;
    // The row this came in on, carried through: a screen that lets one be left
    // out needs to say which one, and a position in a list that is worked out
    // again on every change is not a name for anything.
    else add.push({ ...entry, row });
  });
  return { add, kept, invalid };
}
