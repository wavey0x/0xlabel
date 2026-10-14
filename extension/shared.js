export const MAX_LABELS = 32;
export const MAX_NAME_LENGTH = 80;

// Marks every element 0xlabel adds to a page. Nothing carrying it is website
// content, so nothing carrying it is ever read as a wallet display.
export const UI_ATTRIBUTE = 'data-0xlabel-ui';
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

export function hostPermission(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeScope(value) {
  if (value === 'global') return value;
  if (typeof value !== 'string' || !/^eip155:[1-9][0-9]{0,19}$/.test(value)) throw new Error('Use a known network or global labels.');
  return value;
}

export function normalizeLabels(values) {
  if (!Array.isArray(values) || values.length > MAX_LABELS) throw new Error(`Use at most ${MAX_LABELS} names.`);
  const seen = new Set();
  return values.map(value => {
    if (typeof value !== 'string') throw new Error('Names must be plain text.');
    const name = value.trim();
    if (!name || name.length > MAX_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`Names must contain 1–${MAX_NAME_LENGTH} characters.`);
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) throw new Error('Each name in a list must be distinct.');
    seen.add(key);
    return name;
  });
}

export function validateRecord(value) {
  if (!value || typeof value !== 'object') throw new Error('The API returned an invalid record.');
  const address = parseAddress(value.address);
  if (!address || typeof value.version !== 'string' || !value.version || value.version.length > 128) throw new Error('The API returned an invalid record.');
  const labels = normalizeLabels(value.labels);
  if (!labels.length) throw new Error('An API record cannot have an empty name list.');
  return { address, scope: normalizeScope(value.scope), labels, version: value.version };
}

export function recordKey(address, scope = 'global') {
  return `${scope}/${address}`;
}

export function validateSnapshot(value) {
  if (!value || !Array.isArray(value.records)) throw new Error('This server did not return a valid 0xlabel book.');
  const seen = new Set();
  return value.records.map(item => {
    const entry = validateRecord(item);
    const key = recordKey(entry.address, entry.scope);
    if (seen.has(key)) throw new Error('The API book contains duplicate records.');
    seen.add(key);
    return entry;
  });
}

export function findRecord(records, address, scope) {
  return records.find(item => item.address === address && item.scope === scope) || null;
}

export function indexBook(records) {
  return new Map(records.map(entry => [recordKey(entry.address, entry.scope), entry]));
}
