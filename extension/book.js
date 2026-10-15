import { $, rpc, emptyState, currentSnapshot, syncText, bookPicker, newBookForm, watchBook, dismissDialog, tooltips } from './ui.js';
import { parseAddress, normalizeScope, readBookFile } from './shared.js';
import { scopeName } from './networks.js';
import { checksumAddress } from './checksum.js';
import { createEditor, editorStyles } from './editor.js';
import { COPY_ICON, TRASH_ICON, confirmCopied } from './icons.js';

let state = emptyState;
let busy = false;
let editor;
let entries = [];
let visibleRows = [];
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
const shadow = $('#editor-host').attachShadow({ mode: 'open' });
// Paint the saved book once, rather than an unfinished shell and an empty book.
const ready = Promise.all([editorStyles(shadow), rpc({ type: 'State' })]);
const theme = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => $('#editor-host').toggleAttribute('data-dark', theme.matches);
theme.addEventListener('change', applyTheme); applyTheme();
const setup = newBookForm({ container: $('#server'), state: () => state, created: render,
  busy: value => { busy = value; render(); }, error: tell,
});
const picker = bookPicker({
  add: () => setup.open(),
  choose: async book => {
    try { await rpc({ type: 'Use', book }); tell(''); } catch (error) { tell(error); }
  },
  // A refused name is reported in the row being typed in, so the picker keeps it.
  rename: async (book, name) => { await rpc({ type: 'RenameBook', book, name }); tell(''); },
});
function render(next = state) {
  if (!currentSnapshot(next, state)) return;
  if (next.activeBook !== state.activeBook) $('#search').value = '';
  state = next;
  picker(state);
  $('#location').disabled = busy;
  // Only a book kept somewhere else can be out of date with what it holds.
  $('#refresh').hidden = state.bookKind !== 'server';
  $('#remove-book').disabled = state.books.length < 2;
  $('#remove-book').dataset.tip = state.books.length < 2 ? '0xtagger keeps at least one address book.' : 'Remove this address book';
  $('#refresh').disabled = busy || $('#refresh').hasAttribute('aria-busy');
  $('#export').disabled = !state.records.length;
  $('#sync').textContent = busy ? 'Connecting…' : syncText(state);
  $('#sync').dataset.tip = state.error || '';
  $('#sync').dataset.offline = String(Boolean(state.error));
  const count = new Set(state.records.map(record => record.address)).size;
  $('#count').textContent = `${count.toLocaleString()} address${count === 1 ? '' : 'es'}`;
  // Sorted by name, so the order is a property of the book rather than of the
  // order it happened to be written in.
  entries = state.records
    .map(record => ({ record, text: [record.address, ...record.tags].join('\n').toLocaleLowerCase(), row: null }))
    .sort((one, two) => one.record.tags[0].localeCompare(two.record.tags[0]) ||
      one.record.address.localeCompare(two.record.address));
  if (editor) editor.updateState(state);
  search();
}
function edit(address, scope = 'global') {
  if (editor && !editor.closeIfUnchanged()) return;
  editor = createEditor(shadow, { address, scope, state, modal: true,
    save: draft => rpc({ type: 'Save', draft }),
    close: () => { editor = null; shadow.replaceChildren(); $('#search').focus(); },
  });
}
function bookRow(record) {
  const displayAddress = checksumAddress(record.address);
  const row = document.createElement('tr');
  row.innerHTML = '<td><button class="record"><strong></strong><small></small></button></td><td><code></code></td><td></td>';
  const open = row.querySelector('.record');
  open.querySelector('strong').textContent = record.tags.join(' · ');
  open.querySelector('small').textContent = scopeName(record.scope);
  open.dataset.tip = displayAddress; open.setAttribute('aria-label', `Edit tags for ${displayAddress}`);
  open.onclick = () => edit(record.address, record.scope);
  row.querySelector('code').textContent = displayAddress;
  const copy = document.createElement('button'); copy.className = 'quiet icon copy'; copy.innerHTML = COPY_ICON;
  copy.setAttribute('aria-label', `Copy ${displayAddress}`); copy.dataset.tip = `Copy ${displayAddress}`;
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
// A screenful at a time. Building a row for every address in a large book
// costs seconds and shows nobody anything: searching is how you find one.
const SHOWN = 250;
function search() {
  const value = $('#search').value.trim().toLocaleLowerCase();
  const matches = entries.filter(entry => entry.text.includes(value));
  // Cache rows and checksums per snapshot; searches only filter the local book.
  const rows = matches.slice(0, SHOWN).map(entry => entry.row ||= bookRow(entry.record));
  if (rows.length !== visibleRows.length || rows.some((row, index) => row !== visibleRows[index])) {
    $('#results').replaceChildren(...rows); visibleRows = rows;
  }
  $('#empty').hidden = Boolean(matches.length);
  $('#empty p').textContent = state.records.length ? 'No matching tags or addresses.' : 'No addresses tagged yet.';
  // A search that found nothing is not the moment to explain importing.
  $('#empty-hint').hidden = Boolean(state.records.length);
  $('#shown').hidden = matches.length <= SHOWN;
  $('#shown').textContent = `Showing ${SHOWN} of ${matches.length.toLocaleString()}. Search to narrow.`;
}
$('#search').oninput = search;

// Removing a book kept here destroys its addresses; removing one kept on a
// server only forgets it. Same button, deliberately different words.
const removeDialog = $('#remove-dialog');
const closeRemove = () => { removeDialog.close(); $('#remove-error').textContent = ''; $('#location').focus(); };
dismissDialog(removeDialog, closeRemove);
$('#close-remove').onclick = closeRemove;
$('#keep-book').onclick = closeRemove;
$('#remove-book').innerHTML = TRASH_ICON;
// Only a book kept here is destroyed by this, so only that one is typed out
// first. Forgetting a book a server holds is undone by pasting its link again.
const typed = () => $('#remove-name').value.trim() === state.books.find(item => item.id === state.activeBook)?.name;
$('#remove-name').oninput = () => { $('#confirm-remove').disabled = !typed(); };
$('#remove-name').onkeydown = event => { if (event.key === 'Enter' && typed()) $('#confirm-remove').click(); };
$('#remove-book').onclick = () => {
  const current = state.books.find(item => item.id === state.activeBook);
  if (!current) return;
  const here = current.where === 'On this device';
  const count = new Set(state.records.map(record => record.address)).size;
  const addresses = `${count} address${count === 1 ? '' : 'es'}`;
  $('#remove-heading').textContent = here ? 'Delete address book' : 'Remove address book';
  $('#remove-copy').textContent = here
    ? `Deletes ${current.name} and its ${addresses}. This cannot be undone.`
    : `Removes ${current.name} from 0xtagger. ${current.where} keeps its ${addresses}.`;
  $('#confirm-remove').textContent = here ? 'Delete' : 'Remove';
  $('#remove-name').hidden = !here;
  $('#remove-name').value = '';
  $('#confirm-remove').disabled = here;
  $('#remove-error').textContent = '';
  removeDialog.showModal();
  (here ? $('#remove-name') : $('#confirm-remove')).focus();
};
$('#confirm-remove').onclick = async () => {
  try { await rpc({ type: 'RemoveBook', book: state.activeBook }); closeRemove(); }
  catch (error) { $('#remove-error').textContent = error.message; }
};
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
  try {
    const result = await rpc({ type: 'Refresh' });
    render({ ...state, syncedAt: result?.syncedAt ?? state.syncedAt });
    tell('');
  } catch (error) { tell(error); }
  finally { $('#refresh').removeAttribute('aria-busy'); render(); }
};
$('#import').onclick = () => $('#import-file').click();
$('#import-file').onchange = async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const { records, unnamed } = readBookFile(await file.text());
    const result = await rpc({ type: 'Import', records });
    const skipped = unnamed ? ` ${unnamed} unnamed row${unnamed === 1 ? '' : 's'} skipped.` : '';
    tell(`Added ${result.added} address${result.added === 1 ? '' : 'es'} to ${state.bookName}.${skipped}`);
  } catch (error) {
    tell(error instanceof SyntaxError ? 'That file is not a 0xtagger export or a Safe address book.' : error);
  }
};
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ records: state.records }, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = '0xtagger-book.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
tooltips();
watchBook(() => state, render);
try {
  const [, response] = await ready;
  render(response.state);
} catch (error) { render(); tell(error); }
finally {
  $('.book').hidden = false;
  $('#search').focus({ preventScroll: true });
}
