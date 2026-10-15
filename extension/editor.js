import { findRecord, MAX_LABELS, MAX_NAME_LENGTH, normalizeLabels, sameLabels } from './shared.js';
import { checksumAddress } from './checksum.js';
import { EDITOR_MARK, COPY_ICON, COPIED_ICON, confirmCopied } from './icons.js';

const element = (tag, text, attrs = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

export async function editorStyles(root) {
  const sheet = new CSSStyleSheet();
  const styles = await Promise.all(['colors.css', 'editor.css'].map(async file =>
    (await fetch(new URL(file, import.meta.url))).text()));
  sheet.replaceSync(styles.join('\n'));
  root.adoptedStyleSheets = [sheet];
}

// Shared by the page popover and book. The draft never follows a recycled row.
export function createEditor(container, { address, scope = 'global', state, save, close, onLayout = () => {}, visibility, toggleVisibility, modal = false }) {
  const book = state.activeBook;
  // Which book a save goes to only matters once there is more than one.
  const bookName = state.books.length > 1 ? state.bookName : '';
  const displayAddress = checksumAddress(address);
  const own = findRecord(state.records, address, scope);
  // What the book says about this address, and the version a save must match.
  // A scope with no record of its own starts from the names shown everywhere.
  const reading = from => {
    const mine = findRecord(from.records, address, scope);
    const shown = mine || (scope !== 'global' && findRecord(from.records, address, 'global'));
    return { labels: shown?.labels || [], version: mine?.version || null };
  };
  let loaded = reading(state);
  const draft = { labels: [...(loaded.labels.length ? loaded.labels : [''])], version: loaded.version };
  // Compared as a save would store them, so a stray space is not an edit.
  const edited = () => !sameLabels(draft.labels.map(name => name.trim()).filter(Boolean), loaded.labels);
  const adopt = next => {
    loaded = next;
    draft.labels = [...(next.labels.length ? next.labels : [''])];
    draft.version = next.version;
  };
  let phase = 'idle';
  let closed = false;
  let activeState = state;
  let pageNotice = '';

  const panel = element(modal ? 'dialog' : 'section', undefined, { class: 'editor', role: 'dialog', 'aria-label': 'Edit wallet labels' });
  panel.innerHTML = `<header><strong class="brand" role="img" aria-label="0xlabel">${EDITOR_MARK}label</strong><span class="source"></span>${visibility ? '<div class="visibility-group"><span>Show tags</span><button type="button" class="switch visibility" role="switch" aria-label="Show my tags for this address" aria-checked="true"><span></span></button></div>' : '<button type="button" class="quiet close" aria-label="Close editor" title="Close">×</button>'}</header>
    <div class="address-line"><code></code><button type="button" class="quiet copy" aria-label="Copy">${COPY_ICON}</button></div>
    <div class="rows"></div>
    <p class="preview"></p><p class="notice" role="status"></p><div class="conflict" hidden></div>
    <footer><button type="button" class="quiet add" aria-label="Add label" title="Add label">+</button>${modal && own ? '<button type="button" class="quiet clear">Remove tags</button>' : ''}<button type="button" class="primary save">Save</button></footer>`;
  container.replaceChildren(panel);
  if (modal) panel.showModal();
  const get = selector => panel.querySelector(selector);
  get('code').textContent = displayAddress;
  get('.source').textContent = bookName;
  get('.source').title = bookName ? `Saving to ${bookName}` : 'Saving to your address book';
  get('.source').setAttribute('aria-label', bookName ? `Saving to ${bookName}` : 'Saving to your address book');
  get('.copy').title = `Copy ${displayAddress}`;
  get('.save').title = bookName ? `Save to ${bookName}` : 'Save';
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
      confirmCopied(get('.copy'));
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
    const switched = activeState.activeBook !== book;
    updateControls();
    get('.notice').textContent = phase === 'saved' ? '' : switched ? `You switched to ${activeState.bookName}. Close this editor and try again.` : pageNotice;
    queueMicrotask(onLayout);
  }
  function updateControls() {
    updateVisibility();
    const busy = phase !== 'idle';
    get('.save').disabled = busy || activeState.activeBook !== book;
    if (phase === 'saved') {
      get('.save').innerHTML = COPIED_ICON;
      get('.save').setAttribute('aria-label', 'Saved');
      get('.save').title = 'Saved';
    } else {
      get('.save').textContent = busy ? 'Saving…' : 'Save';
      get('.save').removeAttribute('aria-label');
      get('.save').title = bookName ? `Save to ${bookName}` : 'Save';
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
    if (focus === null) return;
    const input = rows.querySelectorAll('input')[focus];
    if (input) { input.focus(); input.select(); }
    else get('.add').focus();
  }
  get('.add').onclick = () => { draft.labels.push(''); renderRows(draft.labels.length - 1); };

  async function submit() {
    if (closed || phase !== 'idle' || activeState.activeBook !== book) return;
    let labels;
    try { labels = normalizeLabels(draft.labels); }
    catch (error) { get('.notice').textContent = error.message; queueMicrotask(onLayout); return; }
    phase = 'saving';
    guard();
    try {
      await save({ book, address, scope, labels, version: draft.version });
      if (closed) return;
      phase = 'saved';
      guard();
      // Confirm the write first; a small local animation never determines
      // whether a save succeeded. Keep the button locked until it closes.
      const frames = matchMedia('(prefers-reduced-motion: reduce)').matches ? [{ opacity: 1 }, { opacity: 1 }] : [
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
        { transform: 'scale(1.06)', boxShadow: '0 0 0 4px var(--0xlabel-accent-pulse)', offset: .35 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
      ];
      await get('.save').animate(frames, { duration: 300, easing: 'ease-out' }).finished.catch(() => {});
      finish();
    } catch (error) {
      if (closed) return;
      get('.notice').textContent = error.message;
      // A refusal only ever means the book now says something else. Show what
      // it says and offer the two answers, each of them one click.
      if (error.status === 409) {
        const theirs = { labels: error.current?.labels || [], version: error.current?.version || null };
        const box = get('.conflict');
        box.hidden = false;
        const take = element('button', 'Use these', { type: 'button', class: 'quiet' });
        take.onclick = () => { adopt(theirs); box.hidden = true; get('.notice').textContent = ''; renderRows(); };
        const keep = element('button', 'Keep mine', { type: 'button', class: 'quiet' });
        keep.onclick = () => { draft.version = theirs.version; box.hidden = true; get('.notice').textContent = ''; submit(); };
        box.replaceChildren(element('p', theirs.labels.join(' · ') || 'No names'), take, keep);
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
      if (phase !== 'idle' || edited()) {
        pageNotice = 'Save or close this draft to edit another address.';
        guard(); focus();
        return false;
      }
      finish();
      return true;
    },
    // A draft nobody has touched follows the book, so a name saved in another
    // tab or window is simply what you see rather than a conflict waiting to
    // happen. A draft with typing in it is never overwritten.
    updateState(next) {
      activeState = next;
      if (phase === 'idle' && !edited()) {
        const fresh = reading(next);
        if (fresh.version !== loaded.version || !sameLabels(fresh.labels, loaded.labels)) {
          adopt(fresh);
          const inputs = [...panel.querySelectorAll('.row input')];
          const here = inputs.indexOf(panel.getRootNode().activeElement);
          renderRows(here >= 0 ? here : null);
        }
      }
      guard();
    },
    detach(message = 'The page integration paused. Your draft is still safe to save to the book.') { pageNotice = message; guard(); },
    close: finish,
  };
}
