import { COLORS } from './colors.js';
import { createStore } from './store.js';
import { hostPermission } from './shared.js';

let sites = {};
const health = new Map();
const store = createStore({ storage: chrome.storage.local, notify: broadcast });
const ready = initialize();

function siteOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enable an ordinary web page.');
  return url.origin;
}
const scriptId = origin => 'site-' + [...origin].map(char => char.charCodeAt(0).toString(16)).join('');

async function register(origin) {
  const id = scriptId(origin);
  const script = {
    id, matches: [hostPermission(origin)], js: ['content.js'], css: ['colors.css', 'page.css'],
    runAt: 'document_idle', allFrames: true, persistAcrossSessions: true,
  };
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length) {
    await chrome.scripting.updateContentScripts([script]);
  } else await chrome.scripting.registerContentScripts([script]);
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  sites = (await chrome.storage.local.get('sites')).sites || {};
  await store.init();
  for (const origin of Object.keys(sites)) {
    if (sites[origin] && await chrome.permissions.contains({ origins: [hostPermission(origin)] })) await register(origin);
    else delete sites[origin];
  }
  await chrome.storage.local.set({ sites });
  const ids = (await chrome.scripting.getRegisteredContentScripts()).filter(script =>
    !Object.keys(sites).some(origin => sites[origin] && script.id === scriptId(origin))).map(script => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  if (!await chrome.alarms.get('sync')) await chrome.alarms.create('sync', { periodInMinutes: 1 });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'edit-label', title: 'Label address with 0xlabel', contexts: ['page', 'link', 'selection'] });
  store.refresh().catch(() => {});
}

async function send(tabId, message, options = { frameId: 0 }) {
  try { return await chrome.tabs.sendMessage(tabId, message, options); } catch { return null; }
}
async function updateAction(tabId, value) {
  if (value) health.set(tabId, value); else health.delete(tabId);
  const active = value?.status === 'ready';
  const paused = value?.status === 'stale';
  const icon = active ? 'mark' : 'mark-idle';
  await Promise.all([
    chrome.action.setIcon({ tabId, path: Object.fromEntries([16, 24, 32, 48].map(size => [size, `icons/${icon}-${size}.png`])) }),
    chrome.action.setTitle({ tabId, title: active ? '0xlabel · Active on this page' : paused ? '0xlabel · Labeling paused' : '0xlabel' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS.warningBadge }),
    chrome.action.setBadgeText({ tabId, text: paused ? '!' : '' }),
  ]);
}
async function refreshAction(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = tab.url && /^https?:/.test(tab.url) ? siteOrigin(tab.url) : null;
  if (!origin || !sites[origin]) return updateAction(tabId, null);
  // Recover live status after a worker restart without scanning the page again.
  const result = await send(tabId, { type: 'Status' });
  const current = await chrome.tabs.get(tabId);
  if (current.url !== tab.url) return;
  if (result?.health && !health.has(tabId)) {
    await updateAction(tabId, { adapter: result.health.adapter || 'This site', ...result.health, origin });
  }
}
function broadcast(state) {
  chrome.runtime.sendMessage({ type: 'Updated', state }).catch(() => {});
  chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.map(tab => send(tab.id, { type: 'Updated', state }, {}))));
}
async function authorizedPage(sender) {
  try {
    const origin = siteOrigin(sender.url);
    if (sender.id !== chrome.runtime.id || !sender.tab || !sites[origin] || sender.origin !== origin) return false;
    // A website's embedded views share its permission. An enabled website
    // embedded by another origin cannot receive the book or submit edits.
    const tab = await chrome.tabs.get(sender.tab.id);
    return siteOrigin(tab.url) === origin;
  }
  catch { return false; }
}
function trustedView(sender) {
  return sender.id === chrome.runtime.id && ['popup.html', 'book.html'].some(page => sender.url === chrome.runtime.getURL(page));
}

async function handle(message, sender) {
  await ready;
  const view = trustedView(sender);
  const page = await authorizedPage(sender);
  if (message.type === 'State' && sender.id === chrome.runtime.id) {
    if (!view && !page) return { enabled: false };
    const tabId = view ? message.tabId : sender.tab.id;
    if (view && tabId && !health.has(tabId)) await refreshAction(tabId);
    return { state: store.state(), enabled: Boolean(page), ...(view ? { sites } : {}), health: health.get(tabId) || null };
  }
  if (!view && !page) throw new Error('This page is not enabled.');
  if (message.type === 'Save') return store.save(message.draft);
  if (message.type === 'Resume') { store.refresh().catch(() => {}); return {}; }
  if (message.type === 'Health' && page) {
    // The toolbar describes the outer page. Embedded views cannot replace its
    // adapter status (including unrelated contract and advertising frames).
    if (sender.frameId !== 0) return {};
    const value = { adapter: String(message.adapter).slice(0, 40), status: message.status, origin: siteOrigin(sender.url) };
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!tab.url || siteOrigin(tab.url) !== value.origin) return {};
    await updateAction(sender.tab.id, value);
    return {};
  }
  if (!view) throw new Error('Open 0xlabel to change settings.');
  if (message.type === 'Use') return store.use(message.book);
  if (message.type === 'AddBook') {
    const where = message.storage;
    if (where?.kind === 'server') {
      if (!await chrome.permissions.contains({ origins: [hostPermission(where.url)] })) {
        throw new Error('Allow access to that server first.');
      }
    }
    return store.add({ name: message.name, storage: where, copyFrom: message.copyFrom });
  }
  if (message.type === 'RenameBook') return store.rename(message.book, message.name);
  if (message.type === 'RemoveBook') return store.remove(message.book);
  if (message.type === 'Refresh') return store.refresh();
  if (message.type === 'Site') {
    const tab = await chrome.tabs.get(message.tabId);
    const origin = siteOrigin(tab.url);
    if (message.enabled) {
      if (!await chrome.permissions.contains({ origins: [hostPermission(origin)] })) throw new Error('Allow access to this website first.');
      sites[origin] = true;
      await chrome.storage.local.set({ sites });
      await register(origin);
    } else {
      delete sites[origin];
      await chrome.storage.local.set({ sites });
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
    }
    for (const other of await chrome.tabs.query({})) {
      if (other.url && /^https?:/.test(other.url) && siteOrigin(other.url) === origin) {
        if (message.enabled) {
          const target = { tabId: other.id, allFrames: true };
          await chrome.scripting.insertCSS({ target, files: ['colors.css', 'page.css'] });
          await chrome.scripting.executeScript({ target, files: ['content.js'] });
        } else {
          await send(other.id, { type: 'Disable' }, {}); await updateAction(other.id, null);
        }
      }
    }
    return { sites };
  }
  if (message.type === 'Retry') {
    await send(message.tabId, { type: 'Retry' }, {});
    return send(message.tabId, { type: 'Status' });
  }
  throw new Error('Unknown extension action.');
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'Updated') return false;
  handle(message || {}, sender).then(result => reply({ ok: true, result }), error =>
    reply({ ok: false, error: error.message, status: error.status, current: error.current }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'sync') ready.then(() => store.refresh()).catch(() => {}); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  ready.then(() => { if (tab?.id && sites[siteOrigin(tab.url)]) return send(tab.id, { type: 'OpenEditor', selection: info.selectionText, link: info.linkUrl }, { frameId: info.frameId || 0 }); }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => health.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading') updateAction(tabId, null).catch(() => {});
  if (change.status === 'complete') ready.then(() => refreshAction(tabId)).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  ready.then(async () => {
    for (const origin of Object.keys(sites)) {
      if (await chrome.permissions.contains({ origins: [hostPermission(origin)] })) continue;
      delete sites[origin];
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
    }
    await chrome.storage.local.set({ sites });
    for (const tab of await chrome.tabs.query({})) {
      await send(tab.id, { type: 'Recheck' }, {});
      await refreshAction(tab.id);
    }
  }).catch(() => {});
});
