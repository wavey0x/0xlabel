import { $, rpc, emptyState, currentSnapshot, syncText, bookPicker, newBookForm, watchBook, dismissDialog, tooltips } from './ui.js';
import { parseAddress, normalizeScope, readBookFile, reviewImport, sourceName } from './shared.js';
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
  // A review is a decision about one book. If that book moved under it, what
  // it would add is worked out again; if you left that book entirely, the
  // decision is about somewhere you are no longer looking, so it is put away
  // rather than quietly retargeted.
  if (pending && pending.book !== state.activeBook) {
    const left = state.books.find(item => item.id === pending.book)?.name;
    showReview(false);
    tell(`Those names were for ${left || 'another address book'}. Import them again from here.`);
  } else if (pending) renderReview();
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
// A file picked and a file dropped are the same file, so they meet here and
// go to the same review.
async function openFile(file) {
  if (!file) return;
  try {
    const { records, unnamed } = readBookFile(await file.text());
    review(records, { unnamed, what: file.name });
  } catch (error) {
    tell(error instanceof SyntaxError ? 'That file is not a 0xtagger export or a Safe address book.' : error);
  }
}
$('#import').onclick = () => $('#import-file').click();
$('#import-file').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  openFile(file);
};

// Dragging anything else over the page is somebody passing through, so only a
// drag carrying files is answered. Enter and leave fire once per element the
// pointer crosses, so they are counted rather than trusted one at a time.
let carried = 0;
const carriesFile = event => [...(event.dataTransfer?.types || [])].includes('Files');
const showDrop = on => { carried = on ? carried : 0; $('#drop').hidden = !on; };
addEventListener('dragenter', event => { if (carriesFile(event)) { carried += 1; showDrop(true); } });
// Without this the browser leaves the page and opens the file on its own.
addEventListener('dragover', event => { if (carriesFile(event)) event.preventDefault(); });
addEventListener('dragleave', event => {
  if (carriesFile(event) && (carried = Math.max(0, carried - 1)) === 0) showDrop(false);
});
addEventListener('drop', event => {
  if (!carriesFile(event)) return;
  event.preventDefault();
  showDrop(false);
  // One book is one decision. A handful dropped together is not an order to
  // guess which, so the first is read and the rest are said out loud.
  const files = [...event.dataTransfer.files];
  if (files.length > 1) tell(`Reading ${files[0].name}. Drop one book at a time.`);
  openFile(files[0]);
});
$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ records: state.records }, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = '0xtagger-book.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// One screen you read. It says where the names are going and what will be
// added; everything else it has to say, it says in a line. Nothing is chosen
// here, because asking to import was the choice — a row can be left out, and
// that is the whole of it.
let pending = null;
function showReview(on) {
  $('.book-panel').hidden = on;
  $('.book-heading').hidden = on;
  $('#review').hidden = !on;
  // A second import can arrive while one is being read. It waits rather than
  // interrupting, so closing this one is the moment to look again.
  if (!on) { pending = null; readPending().catch(tell); }
}
function review(records, { unnamed = 0, what = '' } = {}) {
  // A file that named a network for nothing lands everywhere, and the network
  // is shown rather than asked about. Offering to change it is only honest
  // where the file itself said nothing either way.
  const scoped = records.some(item => item.scope && item.scope !== 'global');
  // The book these names were read against. Confirming sends it back, so a
  // switch between reading the screen and pressing the button is refused
  // rather than quietly redirected.
  pending = { records, unnamed, what, scoped, book: state.activeBook, left: new Set(), badScope: '' };
  showReview(true);
  $('#review-into').textContent = `Into ${state.bookName}${what ? ` · ${what}` : ''}`;
  $('#review-scope').hidden = scoped || !records.length;
  $('#review-network').value = '';
  tell('');
  renderReview();
}
function renderReview() {
  if (!pending) return;
  // A network nobody can use is a correction to make, not a reason to throw
  // the screen away: the names stay on it and the button waits.
  let wanted;
  try { wanted = scoped(); pending.badScope = ''; }
  catch (error) { pending.badScope = error.message; }
  let outcome;
  try { outcome = reviewImport(wanted ?? pending.records, state.records); }
  catch (error) { tell(error); showReview(false); return; }
  // Left out by the row a name came in on. A position in a list that is worked
  // out again on every change names a different thing each time it changes.
  const rows = outcome.add.filter(entry => !pending.left.has(entry.row));
  $('#review-rows').replaceChildren(...outcome.add.map(entry => {
    const row = document.createElement('tr');
    const out = pending.left.has(entry.row);
    if (out) row.setAttribute('data-left-out', '');
    const name = document.createElement('td'); name.textContent = entry.tags.join(' · ');
    const at = document.createElement('td'); at.className = 'address';
    at.textContent = checksumAddress(entry.address);
    const where = document.createElement('td'); where.textContent = scopeName(entry.scope);
    const drop = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'quiet drop';
    button.textContent = out ? 'Put back' : 'Leave out';
    button.setAttribute('aria-label', `${out ? 'Put back' : 'Leave out'} ${entry.tags[0]}`);
    button.onclick = () => {
      if (out) pending.left.delete(entry.row); else pending.left.add(entry.row);
      renderReview();
    };
    drop.append(button);
    row.append(name, at, where, drop);
    return row;
  }));
  const said = [];
  if (outcome.kept) said.push(`${outcome.kept} name${outcome.kept === 1 ? '' : 's'} you already have ${outcome.kept === 1 ? 'was' : 'were'} kept`);
  if (pending.unnamed) said.push(`${pending.unnamed} unnamed row${pending.unnamed === 1 ? '' : 's'} skipped`);
  $('#review-summary').textContent = outcome.add.length ? `${said.join('. ')}${said.length ? '.' : ''}`
    : said.length ? `All names are already in your book. ${said.join('. ')}.` : 'All names are already in your book.';
  const bad = $('#review-invalid');
  bad.hidden = !outcome.invalid.length;
  bad.querySelector('summary').textContent = `${outcome.invalid.length} row${outcome.invalid.length === 1 ? '' : 's'} could not be read`;
  bad.querySelector('ul').replaceChildren(...outcome.invalid.map(item => {
    const line = document.createElement('li');
    line.textContent = `Row ${item.row}: ${item.reason[0].toLocaleLowerCase()}${item.reason.slice(1)}`;
    return line;
  }));
  $('#confirm-import').textContent = rows.length
    ? `Import ${rows.length.toLocaleString()} name${rows.length === 1 ? '' : 's'}` : 'Nothing to import';
  $('#confirm-import').disabled = busy || !rows.length || Boolean(pending.badScope);
  $('#review-network').setAttribute('aria-invalid', String(Boolean(pending.badScope)));
  if (pending.badScope) $('#review-summary').textContent = pending.badScope;
  pending.ready = rows;
}
// What the file said, with the one network choice the screen offers applied to
// a file that named none. Recomputed before anything is written.
function scoped() {
  const id = $('#review-network').value.trim();
  if (pending.scoped || !id) return pending.records;
  const scope = normalizeScope(`eip155:${id}`);
  return pending.records.map(item => ({ ...item, scope }));
}
$('#review-network').oninput = () => { tell(''); renderReview(); };
// A website was asked what names it keeps, and this is where they are read.
// The popup may be bringing them to a tab that is already open, so this page
// hears about them rather than only looking once while it was starting.
async function readPending() {
  if (pending) return;
  const held = await rpc({ type: 'PendingImport' }).catch(() => null);
  if (held?.records?.length) review(held.records, { what: sourceName(held.records[0]?.source) });
}
chrome.storage.session.onChanged.addListener(changes => {
  if (changes.pendingImport?.newValue) readPending().catch(tell);
});
$('#cancel-import').onclick = () => { showReview(false); tell(''); };
$('#confirm-import').onclick = async () => {
  if (!pending?.ready?.length) return;
  const wanted = pending.ready;
  busy = true; renderReview();
  try {
    const result = await rpc({ type: 'Import', records: wanted, book: pending.book });
    showReview(false);
    tell(`${result.added.toLocaleString()} name${result.added === 1 ? '' : 's'} imported.`);
  } catch (error) {
    // The screen and what was left out stay exactly as they were; only the
    // comparison against the book is worth doing again.
    tell(error?.status === 409 ? 'Some names changed. Review and import again.' : error);
  } finally { busy = false; renderReview(); }
};

tooltips();
watchBook(() => state, render);
try {
  const [, response] = await ready;
  render(response.state);
  await readPending();
} catch (error) { render(); tell(error); }
finally {
  $('.book').hidden = false;
  $('#search').focus({ preventScroll: true });
}
