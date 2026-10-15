import { adapters } from './adapters.js';
import { addressAt } from './detect.js';
import { applyChange, indexBook, parseAddress, query, recordKey, normalizeScope, UI, UI_ATTRIBUTE, UNSAFE_HOST } from './shared.js';
import { createEditor } from './editor.js';
import { createOverlay } from './overlay.js';
import { TAG_ICON } from './icons.js';
import { checksumAddress } from './checksum.js';

const ADDRESS = 'data-0xtagger-address';
const TAG = 'data-0xtagger-tag';
// The address kept beside a name on the one display a page is about.
const SHORT = 'data-0xtagger-short';
const abbreviate = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

export async function createPageController({
  url = () => new URL(location.href), state: initialState,
  save, report = () => {}, resume = () => {}, framed,
}) {
  const doc = document;
  const win = doc.defaultView;
  // Whether this document is one a page embedded. Comparing the two window
  // references touches nothing a cross-origin parent would withhold.
  const embedded = framed ?? (win.top !== win);
  let state = initialState;
  let book = indexBook(state.records);
  let adapter;
  let observed;
  let surface;
  let health = { status: 'waiting' };
  let href = '';
  let stopped = false;
  let paused = false;
  let timer;
  let grace;
  let probing = false;
  let reported = false;
  let editor;
  let editorTarget;
  let contextTarget;
  const targets = new Map();
  const dirty = new Set();
  // Temporary comparisons belong to this page and chain, never the saved book.
  const hiddenTags = new Set();

  const overlay = await createOverlay(doc, win);
  // Keep the editor beside the row it belongs to, while there still is one.
  const position = (fit = false) => { if (editor) overlay.position(editorTarget?.element, fit); };
  const abort = new AbortController();
  const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: abort.signal });

  // Each shadow host needs the surface marked on it. The editor's stylesheet
  // resets the host with `all: initial`, and in a real page the palette does
  // not reach past that, so an unmarked host renders in light colours whatever
  // the website's own surface is.
  function markSurface(element) {
    element.toggleAttribute('data-dark', surface === 'dark');
  }
  function row(parent) {
    if (!parent) return false;
    const style = win.getComputedStyle(parent);
    return style.display.includes('flex') && !style.flexDirection.startsWith('column');
  }
  // An adapter matches the element that proves identity, which on some sites is
  // only a wrapper: a search suggestion matches the link, whose address sits two
  // boxes further in. Annotating the wrapper gives the name and the glyph a line
  // of their own under the row, because the wrapper's content is block-level. So
  // follow the address down to the innermost box that still holds all of it, and
  // annotate that. Where the match already is that box, nothing moves.
  function displayBox(element, address) {
    const shows = box => box.textContent.toLowerCase().replace(/\s/g, '').includes(address);
    for (let box = element; ; ) {
      const inside = [...box.children].filter(child => !child.matches(UI) && child.textContent.trim());
      // Follow the address wherever exactly one child still shows it: a row that
      // sets a site's name above the address keeps the two on separate lines,
      // and only one of those lines is the one being annotated. Failing that,
      // follow a child that holds everything this box holds.
      const showing = inside.filter(shows);
      const next = showing.length === 1 ? showing[0]
        : inside.length === 1 && inside[0].textContent.trim() === box.textContent.trim() ? inside[0] : null;
      // An inline child shares the line it was given, so the annotation is
      // already on the right one. Only a block-level child takes a line of its
      // own, and that is the line the name and the glyph have to follow it onto.
      if (!next || win.getComputedStyle(next).display.startsWith('inline')) return box;
      box = next;
    }
  }
  // A rescan replaces the box whenever the site rebuilds it; until one happens,
  // the match itself is always still there to fall back on.
  const shownOn = target => (target.display?.isConnected ? target.display : target.element);
  function addEditButton(target) {
    const slot = doc.createElement('span');
    slot.setAttribute(UI_ATTRIBUTE, '');
    slot.setAttribute('data-0xtagger-edit', '');
    markSurface(slot);
    slot.style.cssText = 'display:inline-flex;vertical-align:middle;flex-shrink:0;width:20px;height:20px;margin-inline-start:3px;';
    const root = slot.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = overlay.shadow.adoptedStyleSheets;
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'inline-tag';
    button.setAttribute('aria-label', 'Edit wallet tags'); button.title = 'Edit tags';
    button.innerHTML = TAG_ICON;
    // Keep a suggestion's search field focused until activation. Otherwise its
    // blur handler can hide this button before the browser delivers the click.
    button.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); open(targets.get(target.element)); };
    root.append(button);
    // The glyph may follow the display wherever it stays on the same line: in
    // inline flow, or as the next item on a flex row. Anything else — a block,
    // a cell, a column or a grid — would give it a line of its own, so there it
    // goes inside the box that shows the address. Its SVG lives in a shadow
    // root and so contributes no text to the site's own copy sources.
    const shown = shownOn(target);
    const anchor = shown === target.element ? (target.element.closest('a[href]') || target.element) : shown;
    const style = win.getComputedStyle(anchor);
    // A box that clips what overflows it — a truncating cell — would swallow the
    // glyph, so there it goes beside the box rather than inside it.
    const beside = style.display.startsWith('inline') || style.overflow !== 'visible' || row(anchor.parentElement);
    if (beside) anchor.after(slot); else anchor.append(slot);
    target.editButton = slot;
  }
  function remove(element) {
    const target = targets.get(element);
    if (!target) return;
    // The name may have been painted on a box further in, and a rescan may have
    // moved it since, so clear both candidates rather than guessing.
    for (const box of new Set([element, target.display])) {
      box?.removeAttribute(TAG);
      box?.removeAttribute(SHORT);
    }
    element.removeAttribute(ADDRESS);
    if (target.description && element.getAttribute('aria-description') === target.description) element.removeAttribute('aria-description');
    targets.delete(element);
    target.editButton?.remove();
  }
  function clear() {
    for (const element of targets.keys()) remove(element);
    editor?.updateVisibility();
  }
  function recordFor(target) {
    return target.network && book.get(recordKey(target.address, target.network)) || book.get(recordKey(target.address));
  }
  function paint(target) {
    if (target.element.getAttribute(ADDRESS) !== target.address) target.element.setAttribute(ADDRESS, target.address);
    if (!target.editButton?.isConnected) addEditButton(target);
    const tag = target.naming !== false && !hiddenTags.has(recordKey(target.address, target.network)) &&
      recordFor(target)?.tags[0];
    const shown = shownOn(target);
    if (shown !== target.element) { target.element.removeAttribute(TAG); target.element.removeAttribute(SHORT); }
    if (tag) {
      // Preserve native nodes and copy sources; CSS substitutes only their
      // visible glyphs with the shared custom-tag typography.
      if (shown.getAttribute(TAG) !== tag) shown.setAttribute(TAG, tag);
      const trailer = adapter.subject && target.element.matches(adapter.subject)
        ? abbreviate(checksumAddress(target.address)) : null;
      if (trailer) { if (shown.getAttribute(SHORT) !== trailer) shown.setAttribute(SHORT, trailer); }
      else shown.removeAttribute(SHORT);
      const description = `0xtagger: ${tag}`;
      if (!target.element.hasAttribute('aria-description') || target.description === target.element.getAttribute('aria-description')) {
        if (target.element.getAttribute('aria-description') !== description) target.element.setAttribute('aria-description', description);
        target.description = description;
      }
    } else {
      shown.removeAttribute(TAG);
      shown.removeAttribute(SHORT);
      if (target.description && target.element.getAttribute('aria-description') === target.description) target.element.removeAttribute('aria-description');
      target.description = null;
    }
  }
  function validate(item) {
    const element = item.element;
    const address = parseAddress(item.address);
    if (!address || !(element instanceof win.HTMLElement) || !element.isConnected || element.closest(UNSAFE_HOST) ||
        element.querySelector('input,textarea,select,button,a[href],[role="button"],[contenteditable]:not([contenteditable="false"])')) return null;
    const style = win.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return null;
    // A native prefix remains authoritative. Never fight the site's pseudo-element.
    const nativePrefix = win.getComputedStyle(element, '::before').content;
    if (!element.hasAttribute(TAG) && nativePrefix && !['none', 'normal', '""'].includes(nativePrefix)) return null;
    const network = item.network || health.network;
    if (network) { normalizeScope(network); if (network === 'global') throw new Error('adapter-network-invalid'); }
    return { element, address, network, naming: item.naming !== false, display: displayBox(element, address) };
  }
  function scan(root) {
    const claims = new Map();
    for (const item of adapter.scan(root, { document: doc, url: url() })) {
      const target = validate(item);
      if (!target) continue;
      const prior = claims.get(target.element);
      if (prior && (prior.address !== target.address || prior.network !== target.network)) throw new Error('duplicate-target-identity');
      claims.set(target.element, target);
    }
    // Nested claims would show the name twice. Prefer the innermost address.
    for (const element of claims.keys()) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) if (claims.has(parent)) claims.delete(parent);
    }
    // Only targets this branch covers can have gone stale. Disconnected ones
    // are swept once per batch in run(), whatever branch they were found in.
    for (const element of root === doc ? [...targets.keys()] : query(root, `[${ADDRESS}]`)) {
      if (!claims.has(element)) remove(element);
    }
    for (const [element, target] of claims) {
      const previous = targets.get(element);
      if (previous && previous.address === target.address && previous.network === target.network) {
        target.description = previous.description; target.editButton = previous.editButton;
      }
      else if (previous) remove(element);
      // What the display said when the adapter last vouched for it, so a repaint
      // that writes the same text back can be told from one that does not.
      target.text = element.textContent.trim();
      targets.set(element, target);
      paint(target);
    }
  }
  function setHealth(next, reason) {
    const changed = health.status !== next.status || health.network !== next.network;
    health = next;
    if (changed || reason || !reported) { reported = true; report({ adapter: adapter?.id || 'This site', ...next }); }
    if (reason) console.warn(`0xtagger ${adapter?.id}: ${reason}`);
  }
  function fail(reason) {
    paused = true;
    clear();
    if (editor) { editorTarget = null; editor.detach(); }
    setHealth({ status: 'stale' }, reason);
  }
  function probe(force = false) {
    const nextURL = url();
    const routed = nextURL.href !== href;
    if (routed) {
      hiddenTags.clear();
      clear();
      if (editor) { editorTarget = null; editor.detach(); }
      href = nextURL.href;
      adapter = adapters.find(candidate => candidate.matches(nextURL)) || adapters.at(-1);
      if (adapter !== observed) { observed = adapter; observe(); overlay.applyStyles(adapter.styles); }
      reported = false;
      paused = false;
      probing = false;
      clearTimeout(grace);
    }
    if (paused && !force) return false;
    if (force) { paused = false; probing = false; clearTimeout(grace); }
    const next = adapter.probe({ document: doc, url: nextURL, embedded });
    if (next.status === 'stale') {
      clear();
      if (probing || force) fail(next.reason);
      else {
        probing = true;
        setHealth({ status: 'waiting' });
        grace = setTimeout(() => { if (!stopped) run(true); }, 1000);
      }
      return false;
    }
    probing = false;
    clearTimeout(grace);
    const wasReady = health.status === 'ready';
    setHealth(next);
    if (next.status !== 'ready') { clear(); return false; }
    if (routed || force || !wasReady) dirty.add(doc);
    return true;
  }
  function run(force = false) {
    timer = null;
    if (stopped) return;
    try {
      if (!probe(force)) { dirty.clear(); return; }
      const nextSurface = overlay.theme();
      if (nextSurface !== surface) {
        surface = nextSurface;
        for (const target of targets.values()) if (target.editButton) markSurface(target.editButton);
      }
      const roots = new Set(dirty);
      dirty.clear();
      // Drop branches an ancestor branch already covers. Walking up to a dirty
      // ancestor costs the tree depth; comparing every pair of branches does not
      // scale, and it was that cost, not scanning, which forced a whole-page
      // rescan as soon as a page changed in many places at once.
      const branches = roots.has(doc) ? [doc] : [...roots].filter(root => {
        if (!root.isConnected) return false;
        for (let parent = root.parentNode; parent; parent = parent.parentNode) if (roots.has(parent)) return false;
        return true;
      });
      for (const root of branches) scan(root);
      for (const element of [...targets.keys()]) if (!element.isConnected) remove(element);
      if (editorTarget) {
        const live = targets.get(editorTarget.element);
        if (!live || live.address !== editorTarget.address || live.network !== editorTarget.network) {
          const hidden = editorTarget.element?.isConnected && !editorTarget.element.getClientRects().length;
          editorTarget = null;
          editor.detach(hidden ? '' : 'This row changed. Your draft still belongs to the address above.');
        }
      }
      editor?.updateVisibility();
      position();
    } catch (error) { fail(error.message); }
  }
  function schedule(root = doc) {
    dirty.add(root);
    // Far more branches than this and the whole document is the cheaper scan.
    if (dirty.size > 256) { dirty.clear(); dirty.add(doc); }
    if (!timer) timer = setTimeout(run, 40);
  }
  const observer = new MutationObserver(changes => {
    for (const change of changes) {
      const element = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (!element || element.closest(UI)) continue;
      if (change.type === 'childList') {
        const nodes = [...change.addedNodes, ...change.removedNodes];
        if (nodes.length && nodes.every(node => node.nodeType === 1 && node.matches(UI))) continue;
      }
      if (change.type === 'attributes' && (change.attributeName.startsWith('data-0xtagger') || change.attributeName === 'aria-description')) continue;
      if (change.type === 'attributes' && change.oldValue === element.getAttribute(change.attributeName)) continue;
      const existing = element.closest(`[${ADDRESS}]`);
      // Hover styling and tooltip text do not change a verified wallet identity.
      const presentation = change.type === 'attributes' &&
        (['class', 'style', 'hidden'].includes(change.attributeName) ||
         ['title', 'aria-label'].includes(change.attributeName) &&
         (!parseAddress(element.getAttribute(change.attributeName)) || parseAddress(element.getAttribute(change.attributeName)) === targets.get(existing)?.address));
      // A framework repainting a live panel writes the same text back into the
      // same row. That is not a change of identity, and tearing the annotation
      // down for it — to rebuild it a frame later — is what makes the panel
      // flicker. Anything that genuinely reads differently, and every change to
      // an attribute identity rests on, still clears at once.
      const rewritten = change.type !== 'attributes' && existing &&
        targets.get(existing)?.text === existing.textContent.trim();
      if (!presentation) {
        // Targets are never nested, so the annotation attribute is their index.
        // An ancestor is found by one lookup; descendants by a scoped query.
        if (existing && !rewritten) remove(existing);
        if (change.type === 'childList') {
          for (const node of change.removedNodes) {
            if (node.nodeType === 1) for (const gone of query(node, `[${ADDRESS}]`)) remove(gone);
          }
        } else if (!existing) {
          for (const inside of query(element, `[${ADDRESS}]`)) remove(inside);
        }
      }
      // A tooltip added to the page root needs only its own branch scanned.
      if (change.type === 'childList' && (element === doc.body || element === doc.documentElement)) {
        for (const node of [...change.addedNodes, ...change.removedNodes]) if (node.nodeType === 1 && !node.matches(UI)) schedule(node);
      } else schedule(existing || element);
    }
  });
  // Links and presentation always matter; the active adapter adds the
  // attributes its own site keeps address evidence in.
  const WATCHED = ['href', 'class', 'hidden', 'style'];
  function observe() {
    observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
      attributeFilter: [...new Set([...WATCHED, ...(adapter?.watch || [])])] });
  }
  observe();

  function open(target) {
    if (!target) return;
    if (editor && editorTarget?.address === target.address && editorTarget.network === target.network &&
        editorTarget.book === state.activeBook) {
      editorTarget = { ...target, book: state.activeBook };
      position(true); editor.focus();
      return;
    }
    if (editor && !editor.closeIfUnchanged()) { position(true); return; }
    editorTarget = { ...target, book: state.activeBook };
    // About to edit is the moment a stale copy becomes a conflict, so this is
    // worth an ask. It is conditional and rate limited in the worker.
    resume();
    overlay.show();
    overlay.theme();
    const book = state.activeBook;
    const key = recordKey(target.address, target.network);
    const visibility = () => {
      const live = targets.get(editorTarget?.element);
      return {
        available: target.naming !== false && Boolean(recordFor(target)), hidden: hiddenTags.has(key),
        enabled: state.activeBook === book && health.status === 'ready' && href === url().href &&
          live?.element.isConnected && live.address === target.address && live.network === target.network,
      };
    };
    editor = createEditor(overlay.box, { address: target.address, scope: recordFor(target)?.scope || 'global', state, save,
      visibility,
      toggleVisibility: () => {
        const view = visibility();
        if (!view.available || !view.enabled) return;
        if (view.hidden) hiddenTags.delete(key); else hiddenTags.add(key);
        for (const item of targets.values()) if (recordKey(item.address, item.network) === key) paint(item);
        position();
      },
      onLayout: position,
      close: () => {
        editor = null;
        editorTarget = null;
        overlay.hide();
        if (target.element?.isConnected && targets.has(target.element)) {
          target.element.focus({ preventScroll: true });
        }
      },
    });
    position();
  }
  listen(doc, 'contextmenu', event => {
    const element = event.target instanceof win.Element ? event.target.closest(`[${ADDRESS}]`) : null;
    contextTarget = targets.get(element);
  });
  // Only independently scrolling panels need a correction. The page itself
  // scrolls the absolute editor in the same browser frame as its address.
  listen(doc, 'scroll', event => { if (event.target !== doc) position(); }, { capture: true, passive: true });
  listen(win, 'resize', () => position(true), { passive: true });
  // A system scheme change can repaint a website without touching its DOM, so
  // nothing else would tell us the surface our tags sit on has moved.
  listen(win.matchMedia('(prefers-color-scheme: dark)'), 'change', () => schedule());
  listen(win, 'popstate', () => schedule());
  listen(win, 'hashchange', () => schedule());
  listen(doc, 'visibilitychange', () => { if (!doc.hidden) { schedule(); resume(); } });
  listen(win, 'pageshow', () => { schedule(); resume(); });
  const routeCheck = setInterval(() => { if (url().href !== href) schedule(); }, 1000);

  function updateState(next) {
    if (!next || !Number.isSafeInteger(next.stateRevision)) return;
    if (next.stateRevision < state.stateRevision) return;
    const switched = next.activeBook !== state.activeBook;
    if (switched) hiddenTags.clear();
    state = next;
    book = indexBook(next.records);
    if (editor) editor.updateState(next);
    if (switched) { clear(); schedule(); }
    else if (!paused && health.status === 'ready') for (const target of targets.values()) paint(target);
  }
  // One record, applied to the index this page already holds: no book to rebuild
  // and only the addresses it names to repaint. A view that has fallen behind
  // says so, and the caller asks for the whole book instead.
  function patch(message) {
    const next = applyChange(state, message);
    if (!next) return false;
    state = next;
    const { address, scope, record } = message.change;
    const key = recordKey(address, scope);
    if (record) book.set(key, record); else book.delete(key);
    if (editor) editor.updateState(state);
    if (!paused && health.status === 'ready') {
      for (const target of targets.values()) if (target.address === address) paint(target);
    }
    return true;
  }
  function stop() {
    stopped = true;
    clearTimeout(timer); clearTimeout(grace);
    clearInterval(routeCheck);
    observer.disconnect(); abort.abort(); clear();
    if (editor) editor.close();
    overlay.destroy();
  }
  dirty.add(doc);
  run();
  return {
    updateState, patch, stop,
    retry() { dirty.add(doc); run(true); },
    openEditor(info = {}) {
      if (contextTarget) {
        const target = targets.get(contextTarget.element);
        return open(target?.address === contextTarget.address ? contextTarget : { ...contextTarget, element: null });
      }
      const address = parseAddress(info.selection?.trim()) || (info.link && addressAt(info.link)?.address);
      if (address) open({ address, network: health.network, element: null });
    },
    get health() { return health; },
  };
}

export async function startPage() {
  const rpc = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) { const error = new Error(response?.error || 'The extension could not respond. Try reopening this page.'); Object.assign(error, { status: response?.status, current: response?.current }); throw error; }
    return response.result;
  };
  const initial = await rpc({ type: 'State' });
  if (!initial.enabled) { globalThis.__oxtaggerStarting = false; return; }
  let controller;
  let latest;
  let missed = false;
  let disabled = false;
  const resync = () => rpc({ type: 'State' })
    .then(result => { if (result?.state) controller?.updateState(result.state); })
    .catch(() => {});
  function message(value, _sender, reply) {
    if (value.type === 'Updated') {
      if (value.state) { latest = value.state; controller?.updateState(value.state); }
      else if (!controller) missed = true;
      else if (!controller.patch(value)) resync();
    }
    if (value.type === 'Status') reply?.({ health: controller?.health });
    if (value.type === 'Retry') { controller?.retry(); reply?.({ health: controller?.health }); }
    if (value.type === 'OpenEditor') controller?.openEditor(value);
    if (value.type === 'Recheck') rpc({ type: 'State' }).then(result => { if (!result.enabled) message({ type: 'Disable' }); }).catch(() => {});
    if (value.type === 'Disable') {
      disabled = true; controller?.stop(); chrome.runtime.onMessage.removeListener(message); globalThis.__oxtaggerStarting = false;
    }
  }
  chrome.runtime.onMessage.addListener(message);
  controller = await createPageController({ state: initial.state,
    save: draft => rpc({ type: 'Save', draft }),
    report: value => rpc({ type: 'Health', ...value }).catch(() => {}),
    resume: () => rpc({ type: 'Resume' }).catch(() => {}),
  });
  if (latest) controller.updateState(latest);
  if (missed) await resync();
  if (disabled) controller.stop();
  else rpc({ type: 'Resume' }).catch(() => {});
}
