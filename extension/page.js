import { adapters } from './adapters.js';
import { indexBook, parseAddress, recordKey, normalizeScope, UNSAFE_HOST } from './shared.js';
import { createEditor } from './editor.js';
import { createOverlay } from './overlay.js';
import { LABEL_ICON } from './icons.js';

const ADDRESS = 'data-0xlabel-address';
const LABEL = 'data-0xlabel-label';
const UI = '[data-0xlabel-ui]';

export async function createPageController({
  url = () => new URL(location.href), state: initialState,
  save, report = () => {}, resume = () => {},
}) {
  const doc = document;
  const win = doc.defaultView;
  let state = initialState;
  let book = indexBook(state.records);
  let adapter;
  let observed;
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
  const hiddenLabels = new Set();

  const overlay = await createOverlay(doc, win);
  // Keep the editor beside the row it belongs to, while there still is one.
  const position = (fit = false) => { if (editor) overlay.position(editorTarget?.element, fit); };
  const abort = new AbortController();
  const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: abort.signal });

  function addEditButton(target) {
    const slot = doc.createElement('span');
    slot.setAttribute('data-0xlabel-ui', '');
    slot.setAttribute('data-0xlabel-edit', '');
    slot.style.cssText = 'display:inline-flex;vertical-align:middle;flex-shrink:0;width:20px;height:20px;margin-inline-start:3px;';
    const root = slot.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = overlay.shadow.adoptedStyleSheets;
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'inline-label';
    button.setAttribute('aria-label', 'Edit wallet labels'); button.title = 'Edit labels';
    button.innerHTML = LABEL_ICON;
    // Keep a suggestion's search field focused until activation. Otherwise its
    // blur handler can hide this button before the browser delivers the click.
    button.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
    button.onclick = event => { event.preventDefault(); event.stopPropagation(); open(targets.get(target.element)); };
    root.append(button);
    // Keep edit buttons outside native links. Block displays keep the glyph on
    // their address line; its SVG contributes no text to native copy sources.
    const anchor = target.element.closest('a[href]') || target.element;
    if (anchor.matches('td,p,div')) anchor.append(slot); else anchor.after(slot);
    target.editButton = slot;
  }
  function remove(element) {
    const target = targets.get(element);
    if (!target) return;
    element.removeAttribute(LABEL);
    element.style.removeProperty('--0xlabel-font-size');
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
    const name = !hiddenLabels.has(recordKey(target.address, target.network)) && recordFor(target)?.labels[0];
    if (name) {
      // Preserve native nodes and copy sources; CSS substitutes only their
      // visible glyphs, using the site's font size captured before substitution.
      if (!target.element.hasAttribute(LABEL)) target.element.style.setProperty('--0xlabel-font-size', win.getComputedStyle(target.element).fontSize);
      if (target.element.getAttribute(LABEL) !== name) target.element.setAttribute(LABEL, name);
      const description = `0xlabel: ${name}`;
      if (!target.element.hasAttribute('aria-description') || target.description === target.element.getAttribute('aria-description')) {
        if (target.element.getAttribute('aria-description') !== description) target.element.setAttribute('aria-description', description);
        target.description = description;
      }
    } else {
      target.element.removeAttribute(LABEL);
      target.element.style.removeProperty('--0xlabel-font-size');
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
    if (!element.hasAttribute(LABEL) && nativePrefix && !['none', 'normal', '""'].includes(nativePrefix)) return null;
    const network = item.network || health.network;
    if (network) { normalizeScope(network); if (network === 'global') throw new Error('adapter-network-invalid'); }
    return { element, address, network };
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
    for (const element of [...targets.keys()]) {
      if (!element.isConnected || (root === doc || root === element || root.contains(element)) && !claims.has(element)) remove(element);
    }
    for (const [element, target] of claims) {
      const previous = targets.get(element);
      if (previous && previous.address === target.address && previous.network === target.network) {
        target.description = previous.description; target.editButton = previous.editButton;
      }
      else if (previous) remove(element);
      targets.set(element, target);
      paint(target);
    }
  }
  function setHealth(next, reason) {
    const changed = health.status !== next.status || health.network !== next.network;
    health = next;
    if (changed || reason || !reported) { reported = true; report({ adapter: adapter?.id || 'This site', ...next }); }
    if (reason) console.warn(`0xlabel ${adapter?.id}: ${reason}`);
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
      hiddenLabels.clear();
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
    const next = adapter.probe({ document: doc, url: nextURL });
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
      const roots = [...dirty];
      dirty.clear();
      // A bounded number of changed branches; collapse redundant descendants.
      const branches = roots.includes(doc) ? [doc] : roots.filter(root => root.isConnected && !roots.some(other => other !== root && other.contains(root)));
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
    if (dirty.size > 32) { dirty.clear(); dirty.add(doc); }
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
      if (change.type === 'attributes' && (change.attributeName.startsWith('data-0xlabel') || change.attributeName === 'aria-description')) continue;
      if (change.type === 'attributes' && change.oldValue === element.getAttribute(change.attributeName)) continue;
      const existing = element.closest(`[${ADDRESS}]`);
      // Hover styling and tooltip text do not change a verified wallet identity.
      const presentation = change.type === 'attributes' &&
        (['class', 'style', 'hidden'].includes(change.attributeName) ||
         ['title', 'aria-label'].includes(change.attributeName) &&
         (!parseAddress(element.getAttribute(change.attributeName)) || parseAddress(element.getAttribute(change.attributeName)) === targets.get(existing)?.address));
      if (!presentation) {
        for (const target of [...targets.values()]) {
          const affected = change.type === 'childList' ?
            target.element.contains(element) || [...change.removedNodes].some(node => node.contains(target.element)) :
            (existing && existing.contains(target.element)) || element.contains(target.element);
          if (affected) remove(target.element);
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
        editorTarget.connectionKey === state.connectionKey) {
      editorTarget = { ...target, connectionKey: state.connectionKey };
      position(true); editor.focus();
      return;
    }
    if (editor && !editor.closeIfUnchanged()) { position(true); return; }
    editorTarget = { ...target, connectionKey: state.connectionKey };
    overlay.show();
    overlay.theme();
    const connectionKey = state.connectionKey;
    const key = recordKey(target.address, target.network);
    const visibility = () => {
      const live = targets.get(editorTarget?.element);
      return {
        available: Boolean(recordFor(target)), hidden: hiddenLabels.has(key),
        enabled: state.connectionKey === connectionKey && health.status === 'ready' && href === url().href &&
          live?.element.isConnected && live.address === target.address && live.network === target.network,
      };
    };
    editor = createEditor(overlay.box, { address: target.address, scope: recordFor(target)?.scope || 'global', state, save,
      visibility,
      toggleVisibility: () => {
        const view = visibility();
        if (!view.available || !view.enabled) return;
        if (view.hidden) hiddenLabels.delete(key); else hiddenLabels.add(key);
        for (const item of targets.values()) if (recordKey(item.address, item.network) === key) paint(item);
        position();
      },
      onLayout: position,
      onSaved: updateState,
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
  listen(win, 'popstate', () => schedule());
  listen(win, 'hashchange', () => schedule());
  listen(doc, 'visibilitychange', () => { if (!doc.hidden) { schedule(); resume(); } });
  listen(win, 'pageshow', () => { schedule(); resume(); });
  const routeCheck = setInterval(() => { if (url().href !== href) schedule(); }, 1000);

  function updateState(next) {
    if (!next || !Number.isSafeInteger(next.selectionGeneration) || !Number.isSafeInteger(next.stateRevision)) return;
    if (next.selectionGeneration < state.selectionGeneration) return;
    if (next.selectionGeneration === state.selectionGeneration && next.stateRevision < state.stateRevision) return;
    const switched = next.connectionKey !== state.connectionKey || next.selectionGeneration !== state.selectionGeneration;
    if (switched) hiddenLabels.clear();
    state = next;
    book = indexBook(next.records);
    if (editor) editor.updateState(next);
    if (switched) { clear(); schedule(); }
    else if (!paused && health.status === 'ready') for (const target of targets.values()) paint(target);
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
    updateState, stop,
    retry() { dirty.add(doc); run(true); },
    openEditor(info = {}) {
      if (contextTarget) {
        const target = targets.get(contextTarget.element);
        return open(target?.address === contextTarget.address ? contextTarget : { ...contextTarget, element: null });
      }
      const address = parseAddress(info.selection?.trim()) || (info.link && parseAddress(new URL(info.link).pathname.match(/^\/address\/([^/]+)\/?$/)?.[1]));
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
  if (!initial.enabled) { globalThis.__oxlabelStarting = false; return; }
  let controller;
  let latest;
  let disabled = false;
  function message(value, _sender, reply) {
    if (value.type === 'Updated') { latest = value.state; controller?.updateState(value.state); }
    if (value.type === 'Status') reply?.({ health: controller?.health });
    if (value.type === 'Retry') { controller?.retry(); reply?.({ health: controller?.health }); }
    if (value.type === 'OpenEditor') controller?.openEditor(value);
    if (value.type === 'Recheck') rpc({ type: 'State' }).then(result => { if (!result.enabled) message({ type: 'Disable' }); }).catch(() => {});
    if (value.type === 'Disable') {
      disabled = true; controller?.stop(); chrome.runtime.onMessage.removeListener(message); globalThis.__oxlabelStarting = false;
    }
  }
  chrome.runtime.onMessage.addListener(message);
  controller = await createPageController({ state: initial.state,
    save: draft => rpc({ type: 'Save', draft }),
    report: value => rpc({ type: 'Health', ...value }).catch(() => {}),
    resume: () => rpc({ type: 'Resume' }).catch(() => {}),
  });
  if (latest) controller.updateState(latest);
  if (disabled) controller.stop();
  else rpc({ type: 'Resume' }).catch(() => {});
}
