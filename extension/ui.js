import { hostPermission, parseConnectLink } from './shared.js';
import { COPIED_ICON } from './icons.js';

export const emptyState = { records: [], location: 'device', locationName: 'On this device', server: null, stateRevision: -1, syncedAt: null, error: null };
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
  if (state.location === 'device') return 'Saved on this device';
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

// Where a book can live. The list is the whole vocabulary: there is nothing to
// pair, name or configure, only a place to keep it.
export const PLACES = [
  { id: 'device', label: 'On this device', note: 'Nothing leaves your computer.' },
  { id: 'server', label: 'On my own server', note: 'Share it between your devices.' },
];

export function placeLabel(state) {
  return state.location === 'server' && state.server ? new URL(state.server).hostname
    : PLACES.find(place => place.id === state.location)?.label || 'On this device';
}

// One control in both views: it says where the book is and offers the others.
export function locationPicker({ choose }) {
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
    choose(option.dataset.place);
  });
  return state => {
    trigger.querySelector('span').textContent = placeLabel(state);
    trigger.setAttribute('aria-label', `Your book is kept ${placeLabel(state).toLowerCase()}`);
    trigger.title = state.server || 'Your address book';
    menu.replaceChildren(...PLACES.map(place => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.place = place.id;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(place.id === state.location));
      button.autofocus = place.id === state.location;
      button.innerHTML = `<span><strong></strong><small></small></span>${COPIED_ICON}`;
      button.querySelector('strong').textContent = place.label;
      button.querySelector('small').textContent = place.id === 'server' && state.server
        ? new URL(state.server).hostname : place.note;
      return button;
    }));
  };
}

// The only thing a server needs: the line it printed.
export function serverForm({ container, state, connected, busy, error, visible = () => {} }) {
  const modal = container instanceof HTMLDialogElement;
  let pending = false;
  container.innerHTML = `<header class="view-heading"><h2>Your own server</h2><button type="button" class="quiet icon" data-cancel aria-label="Close">×</button></header>
    <form id="server-form" novalidate>
      <label for="connect-link">Paste the link your server printed</label>
      <input id="connect-link" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8712#key=…">
      <p class="muted setup-note">Run <code>uv run 0xlabel</code> and copy the line it prints.</p>
      <p id="server-error" class="message" role="alert"></p>
      <footer class="form-actions"><button type="button" class="quiet" data-cancel>Cancel</button><button id="connect" type="submit" class="primary">Use this server</button></footer>
    </form>`;
  const get = selector => container.querySelector(selector);
  const form = get('form');
  const opened = () => modal ? container.open : !container.hidden;
  function close() {
    if (modal) container.close(); else container.hidden = true;
    form.reset(); get('#server-error').textContent = '';
    visible(false); $('#location').focus();
  }
  container.querySelectorAll('[data-cancel]').forEach(button => { button.onclick = close; });
  if (modal) dismissDialog(container, close);
  else container.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    let link;
    try { link = parseConnectLink(get('#connect-link').value); }
    catch (failure) { get('#server-error').textContent = failure.message; return; }
    const permission = chrome.permissions.request({ origins: [hostPermission(link.url)] });
    pending = true; busy(true); get('#connect').disabled = true; get('#connect').textContent = 'Connecting…';
    get('#server-error').textContent = '';
    get('#connect-link').disabled = true;
    try {
      if (!await permission) throw new Error('Access to that server was not granted.');
      connected(await rpc({ type: 'Use', location: 'server', url: link.url, token: link.token }));
      if (opened()) close();
    } catch (failure) {
      if (opened()) get('#server-error').textContent = failure.message; else error(failure);
    } finally {
      pending = false; busy(false); get('#connect').disabled = false; get('#connect').textContent = 'Use this server';
      get('#connect-link').disabled = false;
    }
  };
  return {
    open() {
      if (pending) return;
      form.reset(); get('#server-error').textContent = '';
      get('#connect-link').value = state()?.server || '';
      if (modal) container.showModal(); else container.hidden = false;
      visible(true); get('#connect-link').focus();
    },
  };
}
