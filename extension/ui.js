import { hostPermission, normalizeAPI } from './shared.js';
import { COPIED_ICON } from './icons.js';

export const emptyState = { records: [], connections: [], connectionKey: null, selectionGeneration: -1, stateRevision: 0 };
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
  return Number.isSafeInteger(next?.selectionGeneration) && Number.isSafeInteger(next?.stateRevision) &&
    (next.selectionGeneration > current.selectionGeneration ||
      next.selectionGeneration === current.selectionGeneration && next.stateRevision >= current.stateRevision);
}
export function syncText(state) {
  return state.error ? 'Using cached book' : state.syncedAt ? `Synced ${new Date(state.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Connect your own API';
}
export function dismissDialog(dialog, close) {
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('pointerdown', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
}

// The two extension views share one small connection picker and setup form.
export function connectionPicker({ select, add, edit }) {
  const trigger = $('#connection');
  const menu = $('#connection-menu');
  menu.addEventListener('beforetoggle', event => {
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'open') menu.style.maxHeight = `${Math.max(72, Math.min(300, innerHeight - trigger.getBoundingClientRect().bottom - 12))}px`;
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
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('button');
    if (!option) return;
    menu.hidePopover();
    if (option.dataset.url) select(option.dataset.url);
    else if (option.dataset.action === 'edit') edit();
    else add();
  });
  return state => {
    const active = state.connections.find(connection => connection.url === state.connectionKey);
    trigger.querySelector('span').textContent = active?.name || 'Connect a book';
    trigger.setAttribute('aria-label', active ? `Active connection: ${active.name}` : 'Connect a book');
    trigger.title = active?.url || 'Add a connection';
    const focused = menu.contains(document.activeElement);
    const focusedURL = focused ? document.activeElement.dataset.url : null;
    const options = state.connections.map(connection => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.url = connection.url; button.title = connection.url;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(connection.url === state.connectionKey));
      button.autofocus = connection.url === state.connectionKey;
      button.innerHTML = `<span><strong></strong><small></small></span>${COPIED_ICON}`;
      button.querySelector('strong').textContent = connection.name;
      button.querySelector('small').textContent = connection.url.replace(/^https?:\/\//, '');
      return button;
    });
    for (const [action, text] of [['add', '+ Add connection'], ...(active && edit ? [['edit', 'Edit this connection']] : [])]) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.action = action; button.className = 'menu-action'; button.textContent = text;
      button.setAttribute('role', 'menuitem'); button.autofocus = !active && action === 'add';
      options.push(button);
    }
    menu.replaceChildren(...options);
    if (focused) (options.find(button => button.dataset.url === focusedURL) || options[0])?.focus();
  };
}

export function connectionForm({ container, state, connected, busy, error, visible = () => {} }) {
  const modal = container instanceof HTMLDialogElement;
  let pending = false;
  let editing = false;
  container.innerHTML = `<header class="view-heading"><h2>Add connection</h2><button type="button" class="quiet icon" data-cancel aria-label="Close connection setup">×</button></header>
    <form id="connection-form" novalidate>
      <label for="pairing">Connection JSON</label><textarea id="pairing" rows="3" autocomplete="off" spellcheck="false" placeholder="Paste the JSON from your helper"></textarea>
      <label for="name">Name <span class="muted">(optional)</span></label><input id="name" maxlength="50" autocomplete="off" placeholder="Local or Remote">
      <details id="manual-details"><summary>Enter API details manually</summary>
        <label for="api-url">API address</label><input id="api-url" type="url" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8712">
        <label for="token">Access token</label><input id="token" type="password" autocomplete="off" placeholder="Token from your helper">
      </details>
      <p class="muted setup-note">Each API keeps a separate book.</p><p id="connection-error" class="message" role="alert"></p>
      <footer class="form-actions"><button type="button" class="quiet" data-cancel>Cancel</button><button id="connect" type="submit" class="primary">Connect</button></footer>
    </form>`;
  const get = selector => container.querySelector(selector);
  const form = get('form');
  const opened = () => modal ? container.open : !container.hidden;
  function close() {
    if (modal) container.close(); else container.hidden = true;
    form.reset(); get('#manual-details').open = false; get('#connection-error').textContent = '';
    visible(false); $('#connection').focus();
  }
  container.querySelectorAll('[data-cancel]').forEach(button => { button.onclick = close; });
  if (modal) dismissDialog(container, close);
  else container.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  get('#pairing').oninput = event => {
    try {
      const value = JSON.parse(event.target.value);
      if (typeof value.url === 'string') get('#api-url').value = value.url;
      if (typeof value.token === 'string') get('#token').value = value.token;
      if (typeof value.name === 'string') get('#name').value = value.name.slice(0, 50);
    } catch { /* Keep incomplete pastes editable. */ }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    let connection;
    try {
      if (get('#pairing').value.trim()) JSON.parse(get('#pairing').value);
      if (!get('#api-url').value.trim()) { get('#manual-details').open = true; get('#api-url').focus(); throw new Error('Enter an API address or paste its connection JSON.'); }
      connection = { url: normalizeAPI(get('#api-url').value), token: get('#token').value, name: get('#name').value };
    } catch (failure) {
      get('#connection-error').textContent = failure instanceof SyntaxError ? 'Paste valid connection JSON, or clear it and enter the API details.' : failure.message;
      return;
    }
    const permission = chrome.permissions.request({ origins: [hostPermission(connection.url)] });
    pending = true; busy(true); get('#connect').disabled = true; get('#connect').textContent = 'Connecting…';
    get('#connection-error').textContent = '';
    container.querySelectorAll('input,textarea').forEach(input => { input.disabled = true; });
    container.querySelector('footer [data-cancel]').textContent = 'Back';
    try {
      if (!await permission) throw new Error('API access was not granted.');
      connected(await rpc({ type: 'Connect', connection }));
      if (opened()) close();
    } catch (failure) {
      if (opened()) get('#connection-error').textContent = failure.message;
      else error(failure);
    } finally {
      pending = false; busy(false); get('#connect').disabled = false; get('#connect').textContent = editing ? 'Save connection' : 'Connect';
      container.querySelectorAll('input,textarea').forEach(input => { input.disabled = false; });
      container.querySelector('footer [data-cancel]').textContent = 'Cancel';
    }
  };
  return {
    open(edit = false) {
      if (pending) return;
      editing = edit;
      form.reset(); get('#connection-error').textContent = '';
      get('#connect').textContent = edit ? 'Save connection' : 'Connect';
      get('h2').textContent = edit ? 'Edit connection' : 'Add connection';
      get('#api-url').value = edit ? state().connectionKey || '' : '';
      get('#name').value = edit ? state().connectionName || '' : '';
      get('#token').placeholder = edit ? 'Leave blank to keep the saved token' : 'Token from your helper';
      get('#manual-details').open = edit;
      if (modal) container.showModal(); else container.hidden = false;
      visible(true); (edit ? get('#name') : get('#pairing')).focus();
    },
  };
}
