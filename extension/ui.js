import { applyChange, hostPermission, parseConnectLink } from './shared.js';
import { COPIED_ICON, DEVICE_ICON, PENCIL_ICON, SERVER_ICON } from './icons.js';

export const emptyState = { books: [], activeBook: null, bookName: '', bookKind: 'device', records: [], stateRevision: -1, syncedAt: null, error: null };
export const $ = selector => document.querySelector(selector);
export async function rpc(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error || 'The extension could not respond.');
    Object.assign(error, { status: response?.status, current: response?.current });
    throw error;
  }
  return response.result;
}
// An update arrives either whole or as one record. A view that is not exactly
// one revision behind the same book has missed something and asks for the rest.
export function watchBook(held, render) {
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'Updated') return;
    if (message.state) { render(message.state); return; }
    const next = applyChange(held(), message);
    if (next) render(next);
    else rpc({ type: 'State' }).then(result => render(result.state)).catch(() => {});
  });
}

// Every control that carries one already has its own accessible name, so this
// is the sighted reader's half of a tooltip and nothing is announced twice.
export function tooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  document.body.append(tip);
  let showing = null;
  const hide = () => { showing = null; tip.hidden = true; };
  const show = element => {
    const text = element.dataset.tip;
    if (!text) return hide();
    showing = element;
    tip.textContent = text;
    tip.hidden = false;
    const anchor = element.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const under = anchor.bottom + 6;
    const fits = under + box.height < innerHeight;
    tip.style.left = `${Math.max(6, Math.min(innerWidth - box.width - 6, anchor.left + (anchor.width - box.width) / 2))}px`;
    tip.style.top = `${Math.max(6, fits ? under : anchor.top - box.height - 6)}px`;
  };
  const wanted = event => event.target.closest?.('[data-tip]') || null;
  document.addEventListener('pointerover', event => {
    const found = wanted(event);
    if (found !== showing) found ? show(found) : hide();
  });
  // A press is an answer; the hint has done its work.
  document.addEventListener('pointerdown', hide);
  document.addEventListener('focusin', event => { const found = wanted(event); found ? show(found) : hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
}

export function currentSnapshot(next, current) {
  return Number.isSafeInteger(next?.stateRevision) && next.stateRevision >= current.stateRevision;
}
export function syncText(state) {
  // A book kept here is simply saved; only a book that travels has news.
  if (state.bookKind === 'device') return '';
  if (state.error) return 'Using your saved copy';
  return state.syncedAt
    ? `Synced ${new Date(state.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Connecting…';
}
export function dismissDialog(dialog, close) {
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('pointerdown', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
}

// One control for the book in use, and the list of books it opens. A book is
// renamed in its own row, so a name has nowhere else to be changed. Editing is
// a local swap of that row: the list is rebuilt only once the edit is over.
export function bookPicker({ choose, add, rename }) {
  const trigger = $('#location');
  const menu = $('#location-menu');
  let latest = emptyState;
  let editing = null;
  const find = id => latest.books.find(item => item.id === id);
  const mark = item => `<i class="kept">${item.kind === 'server' ? SERVER_ICON : DEVICE_ICON}</i>`;

  menu.addEventListener('beforetoggle', event => {
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  // A browser popup is only as tall as its document, and a menu in the top
  // layer adds nothing to it, so the open menu asks the page for its room.
  menu.addEventListener('toggle', event => {
    if (event.newState === 'open') makeRoom(); else document.body.style.minHeight = '';
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.showPopover(); }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'F2' && document.activeElement?.dataset.book) {
      event.preventDefault(); startEdit(document.activeElement.dataset.book); return;
    }
    if (event.key === 'Tab') { menu.hidePopover(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.querySelectorAll('[role^="menuitem"]')];
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('button');
    if (!option) return;
    if (option.dataset.rename) { startEdit(option.dataset.rename); return; }
    menu.hidePopover();
    if (option.dataset.book) choose(option.dataset.book); else add();
  });

  function makeRoom() {
    if (!menu.matches(':popover-open')) return;
    // Asking for the room every time, not only when it is short, keeps a second
    // measurement from reading the room already made and taking it back.
    document.body.style.minHeight = `${Math.ceil(menu.getBoundingClientRect().bottom + scrollY + 20)}px`;
  }
  function startEdit(id) {
    const item = find(id);
    if (!item) return;
    editing = null; draw();
    editing = id;
    menu.querySelector(`[data-book="${id}"]`).closest('.book-option').replaceWith(editRow(item));
    const field = menu.querySelector('.name-edit');
    field.focus(); field.select();
  }
  // Leaving the field keeps what was typed and Escape drops it. A name the
  // books refuse is answered in the row it was typed in, which stays open.
  async function commit(item, value) {
    if (editing !== item.id) return;
    const name = value.trim();
    editing = null;
    if (!name || name === item.name) { draw(); return; }
    try {
      await rename(item.id, name);
    } catch (error) {
      editing = item.id;
      const note = document.createElement('p');
      note.className = 'message';
      note.setAttribute('role', 'alert');
      note.textContent = error.message;
      menu.querySelector('.editing').after(note);
      menu.querySelector('.name-edit').focus();
      makeRoom();
    }
  }

  function optionRow(item) {
    const row = document.createElement('div');
    row.className = 'book-option';
    row.setAttribute('role', 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.book = item.id;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(item.id === latest.activeBook));
    button.autofocus = item.id === latest.activeBook;
    // The host only earns a line when it is not already the book's name.
    const host = item.kind === 'server' && item.where !== item.name ? item.where : '';
    button.innerHTML = `${mark(item)}<span><strong></strong>${host ? '<small></small>' : ''}</span>${COPIED_ICON}`;
    button.querySelector('strong').textContent = item.name;
    if (host) button.querySelector('small').textContent = host;
    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'rename';
    pencil.dataset.rename = item.id;
    pencil.setAttribute('role', 'menuitem');
    pencil.setAttribute('aria-label', `Rename ${item.name}`);
    pencil.dataset.tip = `Rename ${item.name}`;
    pencil.innerHTML = PENCIL_ICON;
    row.append(button, pencil);
    return row;
  }
  function editRow(item) {
    const row = document.createElement('div');
    row.className = 'book-option editing';
    row.setAttribute('role', 'none');
    row.innerHTML = mark(item);
    const field = document.createElement('input');
    field.className = 'name-edit';
    field.maxLength = 40;
    field.autocomplete = 'off';
    field.value = item.name;
    field.setAttribute('aria-label', `Rename ${item.name}`);
    field.addEventListener('blur', () => commit(item, field.value));
    field.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); commit(item, field.value); }
      if (event.key === 'Escape') { event.preventDefault(); editing = null; draw(); menu.querySelector(`[data-book="${item.id}"]`)?.focus(); }
    });
    row.append(field);
    return row;
  }
  function draw() {
    trigger.querySelector('span').textContent = latest.bookName || 'Address book';
    trigger.setAttribute('aria-label', `Address book: ${latest.bookName}`);
    // A row being renamed owns the list until the name is settled.
    if (editing) return;
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'new-book';
    create.setAttribute('role', 'menuitem');
    create.textContent = '+ Add an address book';
    menu.replaceChildren(...latest.books.map(optionRow), create);
    makeRoom();
  }
  return state => { latest = state; draw(); };
}

// Making a book is the one moment its storage is chosen, and the one moment
// another book's addresses are copied into it.
export function newBookForm({ container, state, created, busy, error, visible = () => {} }) {
  const modal = container instanceof HTMLDialogElement;
  let pending = false;
  let named = false;
  container.innerHTML = `<header class="view-heading"><h2>New address book</h2><button type="button" class="quiet icon" data-cancel aria-label="Close">×</button></header>
    <form id="new-book" novalidate>
      <input id="book-name" maxlength="40" autocomplete="off" aria-label="Address book name" placeholder="Address book name">
      <fieldset class="choices">
        <legend>Where to keep it</legend>
        <label><input type="radio" name="where" value="device" checked><i class="kept">${DEVICE_ICON}</i><strong>On this device</strong><small>Nothing leaves your computer.</small></label>
        <label><input type="radio" name="where" value="server"><i class="kept">${SERVER_ICON}</i><strong>On a server</strong><small>Share it between your devices.</small></label>
      </fieldset>
      <div id="server-fields">
        <label for="connect-link">Link from your server</label>
        <input id="connect-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8712#key=…">
        <p class="muted setup-note">Run <code>uv run 0xtagger</code> and copy the line it prints.</p>
      </div>
      <label id="copy-row" class="check"><input type="checkbox" id="copy-current"> <span></span></label>
      <p id="server-error" class="message" role="alert"></p>
      <footer class="form-actions"><button type="button" class="quiet" data-cancel>Cancel</button><button id="connect" type="submit" class="primary">Create</button></footer>
    </form>`;
  const get = selector => container.querySelector(selector);
  const form = get('form');
  const kind = () => form.querySelector('input[name="where"]:checked').value;
  const opened = () => modal ? container.open : !container.hidden;
  function refit() {
    get('#server-fields').hidden = kind() !== 'server';
    const source = state();
    const copyable = source.records.length > 0;
    get('#copy-row').hidden = !copyable;
    get('#copy-row').querySelector('span').textContent = `Start with a copy of ${source.bookName}`;
  }
  function close() {
    if (modal) container.close(); else container.hidden = true;
    form.reset(); named = false; get('#server-error').textContent = '';
    visible(false); $('#location').focus();
  }
  container.querySelectorAll('[data-cancel]').forEach(button => { button.onclick = close; });
  if (modal) dismissDialog(container, close);
  else container.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  form.addEventListener('change', refit);
  get('#book-name').oninput = () => { named = true; };
  // The hostname is almost always the name people would have typed anyway.
  get('#connect-link').oninput = () => {
    if (named) return;
    try { get('#book-name').value = new URL(parseConnectLink(get('#connect-link').value).url).hostname; }
    catch { get('#book-name').value = ''; }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    let where;
    try {
      where = kind() === 'server'
        ? { kind: 'server', ...parseConnectLink(get('#connect-link').value) }
        : { kind: 'device' };
    } catch (failure) { get('#server-error').textContent = failure.message; return; }
    const permission = where.kind === 'server'
      ? chrome.permissions.request({ origins: [hostPermission(where.url)] })
      : Promise.resolve(true);
    pending = true; busy(true); get('#connect').disabled = true; get('#connect').textContent = 'Creating…';
    get('#server-error').textContent = '';
    form.querySelectorAll('input').forEach(input => { input.disabled = true; });
    try {
      if (!await permission) throw new Error('Access to that server was not granted.');
      await rpc({ type: 'AddBook', name: get('#book-name').value, storage: where,
        copyFrom: get('#copy-current').checked && !get('#copy-row').hidden ? state().activeBook : null });
      created();
      if (opened()) close();
    } catch (failure) {
      if (opened()) get('#server-error').textContent = failure.message; else error(failure);
    } finally {
      pending = false; busy(false); get('#connect').disabled = false; get('#connect').textContent = 'Create';
      form.querySelectorAll('input').forEach(input => { input.disabled = false; });
    }
  };
  return {
    open() {
      if (pending) return;
      form.reset(); named = false; get('#server-error').textContent = '';
      refit();
      if (modal) container.showModal(); else container.hidden = false;
      visible(true); get('#book-name').focus();
    },
  };
}
