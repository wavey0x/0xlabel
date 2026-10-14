import { findRecord, MAX_LABELS, MAX_NAME_LENGTH, normalizeLabels } from './shared.js';
import { checksumAddress } from './checksum.js';
import { COPY_ICON, COPIED_ICON } from './icons.js';

const element = (tag, text, attrs = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

export async function editorStyles(root) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await (await fetch(new URL('./editor.css', import.meta.url))).text());
  root.adoptedStyleSheets = [sheet];
}

// Shared by the page popover and book. The draft never follows a recycled row.
export function createEditor(container, { address, scope = 'global', state, save, close, onSaved = () => {}, onLayout = () => {}, visibility, toggleVisibility, modal = false }) {
  const connectionKey = state.connectionKey;
  const connectionName = state.connectionName || 'No connection';
  const displayAddress = checksumAddress(address);
  const own = findRecord(state.records, address, scope);
  const initial = own || (scope !== 'global' && findRecord(state.records, address, 'global'));
  const draft = { labels: [...(initial?.labels || [''])], version: own?.version || null };
  let phase = 'idle';
  let closed = false;
  let activeState = state;
  let pageNotice = '';

  const panel = element(modal ? 'dialog' : 'section', undefined, { class: 'editor', role: 'dialog', 'aria-label': 'Edit wallet labels' });
  panel.innerHTML = `<header><strong><span class="brand">0x</span>label</strong><span class="source"></span>${visibility ? '<div class="visibility-group"><span>This address</span><button type="button" class="switch visibility" role="switch" aria-label="Show my tags for this address" aria-checked="true"><span></span></button></div>' : '<button type="button" class="quiet close" aria-label="Close editor" title="Close">×</button>'}</header>
    <div class="address-line"><code></code><button type="button" class="quiet copy" aria-label="Copy">${COPY_ICON}</button></div>
    <div class="rows"></div>
    <p class="preview"></p><p class="notice" role="status"></p><div class="conflict" hidden></div>
    <footer><button type="button" class="quiet add" aria-label="Add label" title="Add label">+</button>${modal && own ? '<button type="button" class="quiet clear">Remove tags</button>' : ''}<button type="button" class="primary save">Save</button></footer>`;
  container.replaceChildren(panel);
  if (modal) panel.showModal();
  const get = selector => panel.querySelector(selector);
  get('code').textContent = displayAddress;
  get('.source').textContent = connectionName;
  get('.source').title = `Saving to ${connectionName}${connectionKey ? ` · ${connectionKey}` : ''}`;
  get('.source').setAttribute('aria-label', `Saving to ${connectionName}`);
  get('.copy').title = `Copy ${displayAddress}`;
  get('.save').title = `Save to ${connectionName}`;
  function outside(event) {
    const path = event.composedPath();
    const box = modal && panel.getBoundingClientRect();
    const inside = path.includes(panel) && (!modal || event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom);
    if (event.button === 0 && !inside && !path.some(node => node.matches?.('[data-0xlabel-edit]'))) finish();
  }
  // Dismiss before the browser focuses the clicked website control. The
  // composed path distinguishes panel content across its shadow boundary.
  panel.ownerDocument.addEventListener('pointerdown', outside, true);
  function finish() {
    if (!closed) {
      closed = true;
      panel.ownerDocument.removeEventListener('pointerdown', outside, true);
      if (modal) panel.close();
      close();
    }
  }
  function focus() {
    (panel.querySelector('.row input:not(:disabled), .add:not(:disabled)') || get('.copy')).focus({ preventScroll: true });
  }
  function updateVisibility() {
    if (!visibility || closed) return;
    const view = visibility();
    const button = get('.visibility');
    get('.visibility-group').hidden = !view.available;
    button.disabled = !view.enabled;
    button.setAttribute('aria-checked', String(!view.hidden));
    button.title = `${view.hidden ? 'Show my tags' : 'Show website original'} for this address on this page. Resets on refresh.`;
  }
  if (visibility) get('.visibility').onclick = () => { if (!closed) { toggleVisibility(); updateVisibility(); } };
  else get('.close').onclick = finish;
  if (modal) panel.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  if (get('.clear')) get('.clear').onclick = () => { draft.labels = []; renderRows(); };
  get('.copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      get('.copy').innerHTML = COPIED_ICON;
      get('.copy').setAttribute('aria-label', 'Copied'); get('.copy').title = 'Copied';
    }
    catch { get('.notice').textContent = 'Select the full address above to copy it.'; queueMicrotask(onLayout); }
  };
  function preview() {
    const names = draft.labels;
    const fallback = scope !== 'global' ? findRecord(activeState.records, address, 'global')?.labels[0] : null;
    get('.preview').hidden = names.length > 0;
    get('.preview').textContent = fallback ? `Removing this override will show ${fallback}.` : 'Removing all names restores the original address display.';
    queueMicrotask(onLayout);
  }
  function guard() {
    const switched = activeState.connectionKey !== connectionKey;
    updateControls();
    get('.notice').textContent = phase === 'saved' ? '' : switched ? `This draft belongs to ${connectionName}. Switch back to save it, or close this editor.` : pageNotice;
    queueMicrotask(onLayout);
  }
  function updateControls() {
    updateVisibility();
    const busy = phase !== 'idle';
    get('.save').disabled = busy || activeState.connectionKey !== connectionKey || !connectionKey;
    if (phase === 'saved') {
      get('.save').innerHTML = COPIED_ICON;
      get('.save').setAttribute('aria-label', 'Saved');
      get('.save').title = 'Saved';
    } else {
      get('.save').textContent = busy ? 'Saving…' : 'Save';
      get('.save').removeAttribute('aria-label');
      get('.save').title = `Save to ${connectionName}`;
    }
    panel.querySelectorAll('input').forEach(input => { input.disabled = busy; });
    const rows = panel.querySelectorAll('.row');
    rows.forEach((row, index) => {
      row.querySelector('[aria-label^="Move up"]').disabled = busy || index === 0;
      row.querySelector('[aria-label^="Move down"]').disabled = busy || index === rows.length - 1;
      row.querySelector('[aria-label^="Remove"]').disabled = busy;
    });
    get('.add').disabled = busy || rows.length >= MAX_LABELS;
    if (get('.clear')) get('.clear').disabled = busy || !draft.labels.length;
  }
  function renderRows(focus = 0) {
    const rows = get('.rows');
    rows.replaceChildren();
    draft.labels.forEach((name, index) => {
      const row = element('div', undefined, { class: 'row' });
      // Search inputs are excluded by Bitwarden even when ignore hints are disabled.
      // Keep the accessible role a textbox: this edits a label, not a search query.
      const input = element('input', undefined, { type: 'search', role: 'textbox', name: `0xlabel-label-${index + 1}`, maxlength: MAX_NAME_LENGTH, 'aria-label': `Label ${index + 1}`, placeholder: 'Add a label', autocomplete: 'off', 'data-bwignore': 'true', spellcheck: 'false' });
      input.value = name;
      // Typing changes no panel geometry; avoid positioning/layout work per letter.
      input.oninput = () => { draft.labels[index] = input.value; };
      const controls = element('div', undefined, { class: 'rank' });
      if (index === 0 && draft.labels.length > 1) controls.append(element('small', 'Default', { class: 'default' }));
      for (const [text, label, offset] of [['↑', 'Move up', -1], ['↓', 'Move down', 1], ['×', 'Remove name', 0]]) {
        const button = element('button', text, { type: 'button', class: 'quiet', 'aria-label': `${label} ${index + 1}` });
        button.onclick = () => {
          const names = draft.labels;
          if (!offset) names.splice(index, 1);
          else [names[index], names[index + offset]] = [names[index + offset], names[index]];
          renderRows(Math.max(0, index + offset));
        };
        controls.append(button);
      }
      row.append(input, controls);
      rows.append(row);
    });
    updateControls();
    preview();
    const input = rows.querySelectorAll('input')[focus];
    if (input) { input.focus(); input.select(); }
    else get('.add').focus();
  }
  get('.add').onclick = () => { draft.labels.push(''); renderRows(draft.labels.length - 1); };

  async function submit() {
    if (closed || phase !== 'idle' || activeState.connectionKey !== connectionKey || !connectionKey) return;
    let labels;
    try { labels = normalizeLabels(draft.labels); }
    catch (error) { get('.notice').textContent = error.message; queueMicrotask(onLayout); return; }
    phase = 'saving';
    guard();
    try {
      const result = await save({ connectionKey, address, scope, labels, version: draft.version });
      if (closed) return;
      phase = 'saved';
      guard();
      onSaved(result.state);
      // Confirm the write first; a small local animation never determines
      // whether a save succeeded. Keep the button locked until it closes.
      const frames = matchMedia('(prefers-reduced-motion: reduce)').matches ? [{ opacity: 1 }, { opacity: 1 }] : [
        { transform: 'scale(1)', boxShadow: '0 0 0 0 #4169e100' },
        { transform: 'scale(1.06)', boxShadow: '0 0 0 4px #4169e133', offset: .35 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 #4169e100' },
      ];
      await get('.save').animate(frames, { duration: 300, easing: 'ease-out' }).finished.catch(() => {});
      finish();
    } catch (error) {
      if (closed) return;
      get('.notice').textContent = error.message;
      if (error.status === 409) {
        const conflict = error.current;
        const box = get('.conflict');
        box.hidden = false;
        box.replaceChildren(element('p', `Currently saved: ${conflict?.labels.join(' · ') || 'No names'}`));
        const review = element('button', 'Keep my labels', { type: 'button', class: 'quiet' });
        review.onclick = () => {
          draft.version = conflict?.version || null;
          box.hidden = true;
          get('.notice').textContent = 'Review your labels, then Save to replace the current list.';
        };
        box.append(review);
      }
    } finally {
      phase = 'idle';
      if (!closed) {
        updateControls();
        queueMicrotask(onLayout);
      }
    }
  }
  // The editor shares the page DOM. Website scripts must not submit the book.
  get('.save').addEventListener('click', event => { if (event.isTrusted) submit(); });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
    if (event.isTrusted && event.key === 'Enter' && event.target.matches('.row input') && !event.isComposing) { event.preventDefault(); event.stopPropagation(); submit(); }
  });
  guard();
  renderRows();
  return {
    focus, updateVisibility,
    closeIfUnchanged() {
      const names = initial?.labels || [];
      const entered = draft.labels.filter(name => name.trim());
      const changed = draft.version !== (own?.version || null) || entered.length !== names.length ||
        entered.some((name, index) => name !== names[index]);
      if (phase !== 'idle' || changed) {
        pageNotice = 'Save or close this draft to edit another address.';
        guard(); focus();
        return false;
      }
      finish();
      return true;
    },
    updateState(next) { activeState = next; guard(); },
    detach(message = 'The page integration paused. Your draft is still safe to save to the book.') { pageNotice = message; guard(); },
    close: finish,
  };
}
