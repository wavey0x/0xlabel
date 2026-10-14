import { hostPermission, normalizeAPI, normalizeScope, parseAddress } from './shared.js';
import { createEditor, editorStyles } from './editor.js';
import { checksumAddress } from './checksum.js';
import { COPY_ICON, COPIED_ICON } from './icons.js';

const $ = selector => document.querySelector(selector);
let state = { records: [], connections: [], connectionKey: null, selectionGeneration: -1, stateRevision: 0 };
let sites = {};
let tab;
let editor;
let siteURL;
let busy = false;
let bookEntries = [];
let visibleRows = [];
const editorHost = $('#editor-host');
const shadow = editorHost.attachShadow({ mode: 'open' });
await editorStyles(shadow);
if (matchMedia('(prefers-color-scheme: dark)').matches) editorHost.setAttribute('data-dark', '');

async function rpc(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error || 'The extension could not respond.');
    Object.assign(error, { status: response?.status, current: response?.current });
    throw error;
  }
  return response.result;
}
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
function render(next = state) {
  if (!Number.isSafeInteger(next.selectionGeneration) || !Number.isSafeInteger(next.stateRevision)) return;
  if (next.selectionGeneration < state.selectionGeneration) return;
  if (next.selectionGeneration === state.selectionGeneration && next.stateRevision < state.stateRevision) return;
  state = next;
  bookEntries = state.records.map(record => ({ record, text: [record.address, ...record.labels].join('\n').toLocaleLowerCase(), row: null }));
  if (editor) editor.updateState(next);
  const select = $('#connection');
  select.replaceChildren();
  if (!state.connections.length) select.append(new Option('Add a connection', ''));
  for (const connection of state.connections) select.append(new Option(connection.name, connection.url));
  select.value = state.connectionKey || '';
  $('#sync').textContent = state.error ? `Using cached labels · ${state.error}` :
    state.syncedAt ? `Last synced ${new Date(state.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Connect to your helper to start.';
  $('#refresh').disabled = !state.connectionKey || busy;
  $('#export').disabled = !state.connectionKey;
  $('#count').textContent = `${state.records.length} lists`;
  const enabled = Boolean(siteURL && sites[siteURL.origin]);
  $('#site-toggle').setAttribute('aria-checked', String(enabled));
  $('#site-toggle').title = enabled ? 'Show website defaults' : 'Show my labels';
  $('#site-view').textContent = enabled ? 'Your labels' : 'Website defaults';
  search();
}
function settings() {
  $('#settings').hidden = !$('#settings').hidden;
  if (!$('#settings').hidden) {
    $('#api-url').value = state.connectionKey || 'http://127.0.0.1:8712';
    $('#name').value = state.connectionName || '';
    $('#token').value = '';
    $('#pairing').focus();
  }
}
$('#settings-toggle').onclick = settings;
$('#pairing').addEventListener('input', event => {
  try {
    const value = JSON.parse(event.target.value);
    if (typeof value.url === 'string') $('#api-url').value = value.url;
    if (typeof value.token === 'string') $('#token').value = value.token;
    if (typeof value.name === 'string') $('#name').value = value.name;
  } catch { /* Allow partially pasted JSON; validate on submit. */ }
});
$('#connection-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  try {
    const url = normalizeAPI($('#api-url').value);
    // Request optional access directly from this user gesture.
    const permission = chrome.permissions.request({ origins: [hostPermission(url)] });
    busy = true; $('#connect').disabled = true; tell('');
    if (!await permission) throw new Error('API access was not granted.');
    render(await rpc({ type: 'Connect', connection: { url, token: $('#token').value, name: $('#name').value } }));
    $('#settings').hidden = true; $('#pairing').value = ''; $('#token').value = '';
  } catch (error) { tell(error); }
  finally { busy = false; $('#connect').disabled = false; render(); }
};
$('#connection').onchange = async event => {
  try { render(await rpc({ type: 'Select', url: event.target.value })); tell(''); }
  catch (error) { tell(error); }
};
$('#refresh').onclick = async () => {
  if (busy) return;
  busy = true; render();
  try { render(await rpc({ type: 'Refresh' })); tell(''); }
  catch (error) { tell(error); }
  finally { busy = false; render(); }
};
async function enable(enabled) {
  $('#site-toggle').disabled = true;
  try {
    if (!siteURL) throw new Error('Open a website to enable labeling.');
    if (enabled && !await chrome.permissions.request({ origins: [hostPermission(siteURL.origin)] })) throw new Error('Website access was not granted.');
    const result = await rpc({ type: 'Site', tabId: tab.id, enabled });
    sites = result.sites; render(); tell('');
    $('#adapter-warning').hidden = true;
  } catch (error) { tell(error); }
  finally { $('#site-toggle').disabled = !siteURL; }
}
$('#site-toggle').onclick = () => enable(!sites[siteURL?.origin]);
$('#disable').onclick = () => enable(false);
$('#retry').onclick = async () => {
  try {
    const result = await rpc({ type: 'Retry', tabId: tab.id });
    if (result?.health) $('#adapter-warning').hidden = result.health.status !== 'stale';
    tell('');
  }
  catch (error) { tell(error); }
};

function edit(address, scope = 'global') {
  if (!state.connectionKey) { tell('Connect to an API first.'); return; }
  editorHost.hidden = false;
  editor = createEditor(shadow, { address, scope, state,
    save: draft => rpc({ type: 'Save', draft }), onSaved: render,
    close: () => { editor = null; shadow.replaceChildren(); editorHost.hidden = true; $('#search').focus(); },
  });
}
function bookRow(record) {
  const displayAddress = checksumAddress(record.address);
  const row = document.createElement('div'); row.className = 'result';
  const open = document.createElement('button'); open.className = 'record';
  const name = document.createElement('strong'); name.textContent = record.labels.join(' · ');
  const address = document.createElement('small'); address.textContent = `${displayAddress.slice(0, 8)}…${displayAddress.slice(-6)} · ${record.scope}`;
  open.append(name, address); open.title = displayAddress;
  open.onclick = () => edit(record.address, record.scope);
  const copy = document.createElement('button'); copy.className = 'quiet copy'; copy.innerHTML = COPY_ICON;
  copy.setAttribute('aria-label', `Copy ${displayAddress}`); copy.title = `Copy ${displayAddress}`;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress); copy.innerHTML = COPIED_ICON;
      copy.setAttribute('aria-label', `Copied ${displayAddress}`); copy.title = 'Copied';
    }
    catch { $('#manual-address').value = displayAddress; $('#manual-address').select(); }
  };
  row.append(open, copy);
  return row;
}
function search() {
  const value = $('#search').value.trim().toLocaleLowerCase();
  const matches = bookEntries.filter(entry => entry.text.includes(value));
  // Build a row and its checksum once per snapshot, not once per letter.
  const rows = matches.slice(0, 100).map(entry => entry.row ||= bookRow(entry.record));
  if (rows.length !== visibleRows.length || rows.some((row, index) => row !== visibleRows[index])) {
    $('#results').replaceChildren(...rows);
    visibleRows = rows;
  }
  const full = parseAddress(value);
  if (full) $('#manual-address').value = checksumAddress(full);
  const empty = !matches.length ? state.records.length ? 'No matching labels. You can name an address below.' : 'This book is empty. Name an address below or on an enabled website.' : matches.length > 100 ? 'Showing the first 100 matches. Search to narrow the list.' : '';
  if ($('#empty').textContent !== empty) $('#empty').textContent = empty;
}
$('#search').oninput = search;
$('#manual-address').onchange = () => {
  const address = parseAddress($('#manual-address').value.trim());
  if (address) $('#manual-address').value = checksumAddress(address);
};
$('#manual-form').onsubmit = event => {
  event.preventDefault();
  try {
    const address = parseAddress($('#manual-address').value.trim());
    if (!address) throw new Error('Paste a full hexadecimal Ethereum address.');
    $('#manual-address').value = checksumAddress(address);
    const id = $('#network').value.trim();
    const scope = id ? normalizeScope(`eip155:${id}`) : 'global';
    edit(address, scope); tell('');
  } catch (error) { tell(error); }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ records: state.records }, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = '0xlabel-book.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
chrome.runtime.onMessage.addListener(message => { if (message.type === 'Updated') render(message.state); });
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) siteURL = new URL(tab.url);
  $('#site-name').textContent = siteURL?.hostname || 'Open a website to enable labeling';
  $('#site-toggle').disabled = !siteURL;
  const result = await rpc({ type: 'State', tabId: tab?.id });
  sites = result.sites; render(result.state);
  if (result.health?.status === 'stale' && sites[siteURL?.origin]) {
    $('#adapter-warning p').textContent = `${result.health.adapter} labeling paused because the page changed. Your book is safe.`;
    $('#adapter-warning').hidden = false;
  }
  if (!state.connectionKey) settings();
} catch (error) { tell(error); }
