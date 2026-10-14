import { hostPermission, parseConnectLink } from './shared.js';
import { COPIED_ICON } from './icons.js';

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
export function currentSnapshot(next, current) {
  return Number.isSafeInteger(next?.stateRevision) && next.stateRevision >= current.stateRevision;
}
export function syncText(state) {
  if (state.bookKind === 'device') return 'Saved on this device';
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

// One control for the book in use. The list of books only appears once there
// is more than one, so nothing talks about books until you have two.
export function bookPicker({ choose, add }) {
  const trigger = $('#location');
  const menu = $('#location-menu');
  menu.addEventListener('beforetoggle', event => {
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.showPopover(); }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Tab') { menu.hidePopover(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.querySelectorAll('button')];
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('button');
    if (!option) return;
    menu.hidePopover();
    if (option.dataset.book) choose(option.dataset.book); else add();
  });
  return state => {
    trigger.querySelector('span').textContent = state.bookName || 'Address book';
    trigger.setAttribute('aria-label', `Address book: ${state.bookName}`);
    const options = state.books.length > 1 ? state.books.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.book = item.id;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(item.id === state.activeBook));
      button.autofocus = item.id === state.activeBook;
      button.innerHTML = `<span><strong></strong><small></small></span>${COPIED_ICON}`;
      button.querySelector('strong').textContent = item.name;
      button.querySelector('small').textContent = item.where;
      return button;
    }) : [];
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'new-book';
    create.setAttribute('role', 'menuitem');
    create.textContent = '+ Add an address book';
    create.autofocus = !options.length;
    menu.replaceChildren(...options, create);
  };
}

// Making a book is the one moment its storage is chosen, and the one moment
// another book's addresses are copied into it.
export function newBookForm({ container, state, created, busy, error, visible = () => {} }) {
  const modal = container instanceof HTMLDialogElement;
  let pending = false;
  let named = false;
  container.innerHTML = `<header class="view-heading"><h2>New address book</h2><button type="button" class="quiet icon" data-cancel aria-label="Close">×</button></header>
    <form id="new-book" novalidate>
      <fieldset class="choices">
        <legend>Where to keep it</legend>
        <label><input type="radio" name="where" value="server" checked> On a server<small>Share it between your devices.</small></label>
        <label><input type="radio" name="where" value="device"> On this device<small>Nothing leaves your computer.</small></label>
      </fieldset>
      <div id="server-fields">
        <label for="connect-link">Link from your server</label>
        <input id="connect-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8712#key=…">
        <p class="muted setup-note">Run <code>uv run 0xlabel</code> and copy the line it prints.</p>
      </div>
      <label for="book-name">Name</label>
      <input id="book-name" maxlength="40" autocomplete="off" placeholder="Address book">
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
      created(await rpc({ type: 'AddBook', name: get('#book-name').value, storage: where,
        copyFrom: get('#copy-current').checked && !get('#copy-row').hidden ? state().activeBook : null }));
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
      visible(true); get('#connect-link').focus();
    },
  };
}
