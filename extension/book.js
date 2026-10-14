import { $, rpc, emptyState, currentSnapshot, syncText, locationPicker, serverForm, dismissDialog } from './ui.js';
import { parseAddress, normalizeScope } from './shared.js';
import { scopeName } from './networks.js';
import { checksumAddress } from './checksum.js';
import { createEditor, editorStyles } from './editor.js';
import { COPY_ICON, confirmCopied } from './icons.js';

let state = emptyState;
let busy = false;
let editor;
let entries = [];
let visibleRows = [];
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
const shadow = $('#editor-host').attachShadow({ mode: 'open' });
await editorStyles(shadow);
const theme = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => $('#editor-host').toggleAttribute('data-dark', theme.matches);
theme.addEventListener('change', applyTheme); applyTheme();
const setup = serverForm({ container: $('#server'), state: () => state, connected: render,
  busy: value => { busy = value; render(); }, error: tell,
});
const picker = locationPicker({ choose: async place => {
  if (place === 'server') return setup.open();
  try { render(await rpc({ type: 'Use', location: place })); tell(''); } catch (error) { tell(error); }
} });
function render(next = state) {
  if (!currentSnapshot(next, state)) return;
  if (next.location !== state.location) $('#search').value = '';
  state = next;
  picker(state);
  $('#location').disabled = busy;
  $('#refresh').disabled = busy || $('#refresh').hasAttribute('aria-busy');
  $('#export').disabled = !state.records.length;
  $('#sync').textContent = busy ? 'Connecting…' : syncText(state);
  $('#sync').title = state.error || '';
  $('#sync').dataset.offline = String(Boolean(state.error));
  const count = new Set(state.records.map(record => record.address)).size;
  $('#count').textContent = `${count} address${count === 1 ? '' : 'es'}`;
  entries = state.records.map(record => ({ record, text: [record.address, ...record.labels].join('\n').toLocaleLowerCase(), row: null }));
  if (editor) editor.updateState(state);
  search();
}
function edit(address, scope = 'global') {
  if (editor && !editor.closeIfUnchanged()) return;
  editor = createEditor(shadow, { address, scope, state, modal: true,
    save: draft => rpc({ type: 'Save', draft }), onSaved: render,
    close: () => { editor = null; shadow.replaceChildren(); $('#search').focus(); },
  });
}
function bookRow(record) {
  const displayAddress = checksumAddress(record.address);
  const row = document.createElement('tr');
  row.innerHTML = '<td><button class="record"><strong></strong><small></small></button></td><td><code></code></td><td></td>';
  const open = row.querySelector('.record');
  open.querySelector('strong').textContent = record.labels.join(' · ');
  open.querySelector('small').textContent = scopeName(record.scope);
  open.title = displayAddress; open.setAttribute('aria-label', `Edit tags for ${displayAddress}`);
  open.onclick = () => edit(record.address, record.scope);
  row.querySelector('code').textContent = displayAddress;
  const copy = document.createElement('button'); copy.className = 'quiet icon copy'; copy.innerHTML = COPY_ICON;
  copy.setAttribute('aria-label', `Copy ${displayAddress}`); copy.title = `Copy ${displayAddress}`;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      confirmCopied(copy, `Copied ${displayAddress}`);
    } catch {
      const range = document.createRange(); range.selectNodeContents(row.querySelector('code'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      tell('Address selected. Copy it with your keyboard.');
    }
  };
  row.lastElementChild.append(copy);
  return row;
}
function search() {
  const value = $('#search').value.trim().toLocaleLowerCase();
  const matches = entries.filter(entry => entry.text.includes(value));
  // Cache rows and checksums per snapshot; searches only filter the local book.
  const rows = matches.map(entry => entry.row ||= bookRow(entry.record));
  if (rows.length !== visibleRows.length || rows.some((row, index) => row !== visibleRows[index])) {
    $('#results').replaceChildren(...rows); visibleRows = rows;
  }
  $('#empty').hidden = Boolean(matches.length);
  $('#empty p').textContent = state.records.length ? 'No matching tags or addresses.' : 'No addresses tagged yet.';
}
$('#search').oninput = search;
const addDialog = $('#add-dialog');
const closeAdd = () => { addDialog.close(); $('#manual-form').reset(); $('#address-error').textContent = ''; $('#add-address').focus(); };
dismissDialog(addDialog, closeAdd);
$('#close-add').onclick = closeAdd; $('#cancel-add').onclick = closeAdd;
$('#add-address').onclick = () => { $('#manual-form').reset(); $('#address-error').textContent = ''; addDialog.showModal(); $('#manual-address').focus(); };
$('#manual-address').onchange = () => {
  const address = parseAddress($('#manual-address').value.trim());
  if (address) $('#manual-address').value = checksumAddress(address);
};
$('#manual-form').onsubmit = event => {
  event.preventDefault();
  try {
    const address = parseAddress($('#manual-address').value.trim());
    if (!address) throw new Error('Paste a full hexadecimal Ethereum address.');
    const id = $('#network').value.trim();
    const scope = id ? normalizeScope(`eip155:${id}`) : 'global';
    closeAdd(); edit(address, scope); tell('');
  } catch (error) { $('#address-error').textContent = error.message; }
};
$('#refresh').onclick = async () => {
  $('#refresh').disabled = true; $('#refresh').setAttribute('aria-busy', 'true');
  try { render(await rpc({ type: 'Refresh' })); tell(''); } catch (error) { tell(error); }
  finally { $('#refresh').removeAttribute('aria-busy'); render(); }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ records: state.records }, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = '0xlabel-book.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
chrome.runtime.onMessage.addListener(message => { if (message.type === 'Updated') render(message.state); });
render();
try { render((await rpc({ type: 'State' })).state); } catch (error) { tell(error); }
