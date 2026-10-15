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
export function bookPicker({ choose, create, connect, rename }) {
  const trigger = $('#location');
  const menu = $('#location-menu');
  let latest = emptyState;
  let editing = null;
  // A book just made on this device opens straight into its own name, in the
  // row it was made in: one field is not worth a dialog, and the name is
  // editable there for the rest of its life anyway.
  let naming = null;
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
    if (option.dataset.make) {
      // The menu stays open: the list grows a row and that row is the name.
      // Drawn again on the way out, because the book may have arrived before
      // this knew what to call it — and if it has not yet, the draw that
      // brings it finds the note still waiting.
      create().then(book => { naming = book; draw(); }).catch(() => {});
      return;
    }
    menu.hidePopover();
    if (option.dataset.book) choose(option.dataset.book); else connect();
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
    const actions = [['make', 'New on this device'], ['connect', 'Connect to a server']].map(([what, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'new-book';
      button.dataset[what] = 'yes';
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      return button;
    });
    menu.replaceChildren(...latest.books.map(optionRow), ...actions);
    makeRoom();
    // Drawn first, then opened for its name: the row has to exist to be typed in.
    if (naming && find(naming)) { const id = naming; naming = null; startEdit(id); }
  }
  return state => { latest = state; draw(); };
}

// Making a book is the one moment its storage is chosen, and the one moment
// another book's addresses are copied into it.
export function connectForm({ container, created, busy, error, visible = () => {} }) {
  const modal = container instanceof HTMLDialogElement;
  let pending = false;
  let checking;
  container.innerHTML = `<header class="view-heading"><h2>Connect a server</h2><button type="button" class="quiet icon" data-cancel aria-label="Close">\u00d7</button></header>
    <form id="connect-book" novalidate>
      <label for="connect-link">Server link</label>
      <input id="connect-link" type="text" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off" placeholder="http://127.0.0.1:8712#key=\u2026">
      <p id="server-error" class="message" role="alert"></p>
      <details class="setup-note"><summary>Need a link?</summary>
        <p class="muted">Run <code>uv run 0xtagger</code> and copy the line it prints.</p></details>
      <footer class="form-actions"><button type="button" class="quiet" data-cancel>Cancel</button><button id="connect" type="submit" class="primary">Connect</button></footer>
    </form>`;
  const get = selector => container.querySelector(selector);
  const form = get('form');
  const opened = () => (modal ? container.open : !container.hidden);
  function close() {
    if (modal) container.close(); else container.hidden = true;
    // The link carries the key to a book. It has no reason to outlive the
    // moment it was used in.
    clearTimeout(checking); form.reset(); get('#server-error').textContent = '';
    visible(false); $('#location').focus();
  }
  container.querySelectorAll('[data-cancel]').forEach(button => { button.onclick = close; });
  if (modal) dismissDialog(container, close);
  else container.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  // Read as it is typed, never reached for: the link is checked for being one,
  // and nothing is sent anywhere until Connect says so. Complaining mid-word
  // helps nobody, so the field is given a moment to be finished in first.
  get('#connect-link').oninput = () => {
    clearTimeout(checking);
    get('#server-error').textContent = '';
    const value = get('#connect-link').value.trim();
    if (!value) return;
    checking = setTimeout(() => {
      try { parseConnectLink(value); }
      catch (failure) { get('#server-error').textContent = failure.message; }
    }, 400);
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    let where;
    try { where = { kind: 'server', ...parseConnectLink(get('#connect-link').value) }; }
    catch (failure) { get('#server-error').textContent = failure.message; return; }
    // Asked for before anything is awaited: Chrome grants access only while
    // the click that asked for it is still the reason, and the first await
    // ends that. Everything else can wait for the answer.
    const permission = chrome.permissions.request({ origins: [hostPermission(where.url)] });
    clearTimeout(checking);
    pending = true; busy(true); get('#connect').disabled = true; get('#connect').textContent = 'Connecting\u2026';
    get('#server-error').textContent = '';
    form.querySelectorAll('input').forEach(input => { input.disabled = true; });
    try {
      if (!await permission) throw new Error('Access to that server was not granted.');
      await rpc({ type: 'AddBook', name: '', storage: where });
      created();
      // The book opening is the proof it worked, so nothing else says so — and
      // nothing is asked about carrying names over. A book that opens empty
      // says so itself, where it is empty, for as long as it stays that way.
      if (opened()) close();
    } catch (failure) {
      if (opened()) get('#server-error').textContent = failure.message; else error(failure);
    } finally {
      pending = false; busy(false); get('#connect').disabled = false; get('#connect').textContent = 'Connect';
      form.querySelectorAll('input').forEach(input => { input.disabled = false; });
    }
  };
  return {
    open() {
      if (pending) return;
      clearTimeout(checking); form.reset(); get('#server-error').textContent = '';
      if (modal) container.showModal(); else container.hidden = false;
      visible(true); get('#connect-link').focus();
    },
  };
}
