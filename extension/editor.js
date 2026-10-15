import { addedFrom, findRecord, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, sameTags, suggestedBy, usableName } from './shared.js';
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
export function createEditor(container, { address, scope = 'global', state, save, close, onLayout = () => {}, visibility, toggleVisibility, suggestion = null, modal = false }) {
  const book = state.activeBook;
  // Which book a save goes to only matters once there is more than one.
  const bookName = state.books.length > 1 ? state.bookName : '';
  const displayAddress = checksumAddress(address);
  const own = findRecord(state.records, address, scope);
  // What the book says about this address, and the version a save must match.
  // A scope with no record of its own starts from the tags shown everywhere.
  const reading = from => {
    const mine = findRecord(from.records, address, scope);
    const shown = mine || (scope !== 'global' && findRecord(from.records, address, 'global'));
    return { tags: shown?.tags || [], version: mine?.version || null };
  };
  let loaded = reading(state);
  // What the website calls this address. Where nothing is saved it is a
  // starting value, so saving is the only thing left to do. Where something is
  // saved the address is settled, and the site's name is only ever offered.
  const offered = suggestion?.name && usableName(suggestion.name) ? suggestion : null;
  const prefill = offered && !loaded.tags.length ? offered : null;
  const draft = { tags: [...(loaded.tags.length ? loaded.tags : [prefill ? prefill.name : ''])], version: loaded.version };
  // Compared as a save would store them, so a stray space is not an edit.
  const written = () => draft.tags.map(tag => tag.trim()).filter(Boolean);
  // A name this editor put in the field itself is not something anyone typed.
  // Treating it as an unsaved draft would make opening one address and then
  // another ask to save work nobody did.
  const untouched = () => Boolean(prefill) && !loaded.tags.length && sameTags(written(), [prefill.name]);
  const edited = () => !untouched() && !sameTags(written(), loaded.tags);
  const adopt = next => {
    loaded = next;
    draft.tags = [...(next.tags.length ? next.tags : [''])];
    draft.version = next.version;
  };
  let phase = 'idle';
  let closed = false;
  let activeState = state;
  let pageNotice = '';

  const panel = element(modal ? 'dialog' : 'section', undefined, { class: 'editor', role: 'dialog', 'aria-label': 'Edit wallet tags' });
  panel.innerHTML = `<header><strong class="brand" role="img" aria-label="0xtagger">${EDITOR_MARK}tagger</strong><span class="source"></span>${visibility ? '<div class="visibility-group"><span>Show tags</span><button type="button" class="switch visibility" role="switch" aria-label="Show my tags for this address" aria-checked="true"><span></span></button></div>' : '<button type="button" class="quiet close" aria-label="Close editor" title="Close">×</button>'}</header>
    <div class="address-line"><code></code><button type="button" class="quiet copy" aria-label="Copy">${COPY_ICON}</button></div>
    <div class="rows"></div>
    <p class="preview"></p><p class="attribution" hidden></p><p class="offer" hidden></p><p class="notice" role="status"></p><div class="conflict" hidden></div>
    <footer><button type="button" class="quiet add" aria-label="Add tag" title="Add tag">+</button>${modal && own ? '<button type="button" class="quiet clear">Remove tags</button>' : ''}<button type="button" class="primary save">Save</button></footer>`;
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
    if (event.button === 0 && !inside && !path.some(node => node.matches?.('[data-0xtagger-edit]'))) finish();
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
  if (get('.clear')) get('.clear').onclick = () => { draft.tags = []; renderRows(); };
  get('.copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      confirmCopied(get('.copy'));
    }
    catch { get('.notice').textContent = 'Select the full address above to copy it.'; queueMicrotask(onLayout); }
  };
  // A record for one network giving way to a global one is worth saying, because
  // the tag that takes over is not on screen. That emptying the field puts the
  // address back is the field in front of you, said twice.
  // Attribution describes the name now in the first field, so it goes the
  // moment that name stops being the site's. The offer below it is for an
  // address already named: the site's name is shown, never substituted, and
  // adding it appends — the preferred name stays where it is.
  function attribution() {
    const live = Boolean(prefill) && draft.tags[0] === prefill.name;
    // A live suggestion describes the name in the field, so it is said in the
    // present tense and goes when that name does. A record's own origin is
    // history: it stays true however often the name has been rewritten since.
    const history = !live && addedFrom(own?.source);
    get('.attribution').hidden = !live && !history;
    get('.attribution').textContent = live ? suggestedBy(prefill.source) : history || '';
    const spare = offered && !prefill && !draft.tags.some(tag => tag.trim() === offered.name);
    get('.offer').hidden = !spare;
    get('.offer').replaceChildren();
    if (spare) {
      const button = element('button', 'Add tag', { type: 'button', class: 'quiet' });
      button.onclick = () => { draft.tags.push(offered.name); renderRows(draft.tags.length - 1); };
      get('.offer').append(element('span', offered.name),
        element('small', suggestedBy(offered.source)), button);
    }
  }
  function preview() {
    const fallback = !draft.tags.length && scope !== 'global'
      ? findRecord(activeState.records, address, 'global')?.tags[0] : null;
    get('.preview').hidden = !fallback;
    get('.preview').textContent = fallback ? `Removing this override will show ${fallback}.` : '';
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
      if (!get('.save').classList.contains('confirmed')) get('.save').innerHTML = COPIED_ICON;
      get('.save').classList.add('confirmed');
      get('.save').setAttribute('aria-label', 'Saved');
      get('.save').title = 'Saved';
    } else {
      get('.save').classList.remove('confirmed');
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
    get('.add').disabled = busy || rows.length >= MAX_TAGS;
    if (get('.clear')) get('.clear').disabled = busy || !draft.tags.length;
  }
  function renderRows(focus = 0) {
    const rows = get('.rows');
    rows.replaceChildren();
    draft.tags.forEach((tag, index) => {
      const row = element('div', undefined, { class: 'row' });
      // Search inputs are excluded by Bitwarden even when ignore hints are disabled.
      // Keep the accessible role a textbox: this edits a tag, not a search query.
      const input = element('input', undefined, { type: 'search', role: 'textbox', name: `0xtagger-tag-${index + 1}`, maxlength: MAX_TAG_LENGTH, 'aria-label': `Tag ${index + 1}`, placeholder: 'Add a tag', autocomplete: 'off', 'data-bwignore': 'true', spellcheck: 'false' });
      input.value = tag;
      // Typing changes no panel geometry; avoid positioning/layout work per letter.
      input.oninput = () => { draft.tags[index] = input.value; if (index === 0) attribution(); };
      const controls = element('div', undefined, { class: 'rank' });
      if (index === 0 && draft.tags.length > 1) controls.append(element('small', 'Default', { class: 'default' }));
      for (const [text, action, offset] of [['↑', 'Move up', -1], ['↓', 'Move down', 1], ['×', 'Remove tag', 0]]) {
        const button = element('button', text, { type: 'button', class: 'quiet', 'aria-label': `${action} ${index + 1}` });
        button.onclick = () => {
          const tags = draft.tags;
          if (!offset) tags.splice(index, 1);
          else [tags[index], tags[index + offset]] = [tags[index + offset], tags[index]];
          renderRows(Math.max(0, index + offset));
        };
        controls.append(button);
      }
      row.append(input, controls);
      rows.append(row);
    });
    updateControls();
    attribution();
    preview();
    if (focus === null) return;
    const input = rows.querySelectorAll('input')[focus];
    if (input) { input.focus(); input.select(); }
    else get('.add').focus();
  }
  get('.add').onclick = () => { draft.tags.push(''); renderRows(draft.tags.length - 1); };

  async function submit() {
    if (closed || phase !== 'idle' || activeState.activeBook !== book) return;
    let tags;
    try { tags = normalizeTags(draft.tags); }
    catch (error) { get('.notice').textContent = error.message; queueMicrotask(onLayout); return; }
    phase = 'saving';
    guard();
    try {
      // A suggestion rewritten before it was ever saved is a name composed by
      // hand, and carries no origin. The book keeps the origin of a record that
      // already has one, so this only ever names a record being created.
      const source = prefill && tags[0] === prefill.name ? prefill.source : undefined;
      await save({ book, address, scope, tags, version: draft.version, source });
      if (closed) return;
      phase = 'saved';
      guard();
      // Confirm the write first; a small local animation never determines
      // whether a save succeeded. Keep the button locked until it closes.
      // The button gives a little under the press and comes back past where it
      // started, while a ring leaves it and the tick draws itself on. Brief
      // enough to be over before anyone waits for it.
      const frames = matchMedia('(prefers-reduced-motion: reduce)').matches ? [{ opacity: 1 }, { opacity: 1 }] : [
        { transform: 'scale(1)', boxShadow: '0 0 0 0 var(--0xtagger-accent-glow)' },
        { transform: 'scale(.95)', boxShadow: '0 0 0 2px var(--0xtagger-accent-pulse)', offset: .2 },
        { transform: 'scale(1.05)', boxShadow: '0 0 0 8px transparent', offset: .62 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
      ];
      await get('.save').animate(frames, { duration: 340, easing: 'cubic-bezier(.2,.9,.3,1)' }).finished.catch(() => {});
      finish();
    } catch (error) {
      if (closed) return;
      get('.notice').textContent = error.message;
      // A refusal only ever means the book now says something else. Show what
      // it says and offer the two answers, each of them one click.
      if (error.status === 409) {
        const theirs = { tags: error.current?.tags || [], version: error.current?.version || null };
        const box = get('.conflict');
        box.hidden = false;
        const take = element('button', 'Use these', { type: 'button', class: 'quiet' });
        take.onclick = () => { adopt(theirs); box.hidden = true; get('.notice').textContent = ''; renderRows(); };
        const keep = element('button', 'Keep mine', { type: 'button', class: 'quiet' });
        keep.onclick = () => { draft.version = theirs.version; box.hidden = true; get('.notice').textContent = ''; submit(); };
        box.replaceChildren(element('p', theirs.tags.join(' · ') || 'No tags'), take, keep);
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
        if (fresh.version !== loaded.version || !sameTags(fresh.tags, loaded.tags)) {
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
