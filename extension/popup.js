import { hostPermission } from './shared.js';
import { $, rpc, emptyState, currentSnapshot, syncText, bookPicker, connectForm, watchBook, tooltips } from './ui.js';

let state = emptyState;
let sites = {};
let tab;
let siteURL;
let busy = false;
let siteBusy = false;
let health = null;
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
const setup = connectForm({ container: $('#server'), state: () => state, created: render,
  busy: value => { busy = value; render(); }, error: tell,
  visible: open => { $('#home').hidden = open; tell(''); },
});
const picker = bookPicker({
  connect: () => setup.open(),
  // One field is not worth a dialog: the book is made and its row opens on its
  // own name. A refusal — twenty books already — lands where every other one
  // does, on the page behind the menu.
  create: async () => {
    try { const { book } = await rpc({ type: 'AddBook', name: '', storage: { kind: 'device' } }); tell(''); return book; }
    catch (error) { tell(error); throw error; }
  },
  choose: async book => {
    try { await rpc({ type: 'Use', book }); tell(''); } catch (error) { tell(error); }
  },
  // A refused name is reported in the row being typed in, so the picker keeps it.
  rename: async (book, name) => { await rpc({ type: 'RenameBook', book, name }); tell(''); },
});
function render(next = state) {
  if (!currentSnapshot(next, state)) return;
  state = next;
  picker(state);
  $('#location').disabled = busy;
  $('#sync').textContent = busy ? 'Connecting…' : syncText(state);
  $('#sync').dataset.tip = state.error || '';
  $('#sync').dataset.offline = String(Boolean(state.error));
  const enabled = Boolean(siteURL && sites[siteURL.origin]);
  // With no website in front of it the row has nothing to say, so it says
  // nothing rather than standing there explaining its own absence.
  $('.site').hidden = !siteURL;
  $('#site-toggle').setAttribute('aria-checked', String(enabled));
  // The switch still answers without a book, because a control that silently
  // ignores a click reads as broken rather than unavailable.
  $('#site-toggle').disabled = siteBusy;
  $('#site-toggle').dataset.tip = enabled ? 'Show the website originals again' : 'Show my tags on this website';
  // Only a website that keeps names of its own has any to bring in, and only
  // once it has been turned on. Everywhere else the row is not there at all.
  const offers = enabled && health?.imports && health.status === 'ready';
  $('#import-site').hidden = !offers;
  $('#import-site').disabled = busy || siteBusy;
  if (offers) $('#import-site').textContent = `Import names from ${health.adapter}`;
}
async function openBook() {
  const url = chrome.runtime.getURL('book.html');
  const [book] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (book) {
    await chrome.tabs.update(book.tabId, { active: true });
    await chrome.windows.update(book.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}
async function enable(enabled) {
  siteBusy = true; render();
  try {
    if (!siteURL) throw new Error('Open a website to enable tagging.');
    if (enabled && !await chrome.permissions.request({ origins: [hostPermission(siteURL.origin)] })) throw new Error('Website access was not granted.');
    sites = (await rpc({ type: 'Site', tabId: tab.id, enabled })).sites;
    $('#adapter-warning').hidden = true; tell('');
  } catch (error) { tell(error); }
  finally { siteBusy = false; render(); }
}
$('#site-toggle').onclick = () => enable(!sites[siteURL?.origin]);
$('#disable').onclick = () => enable(false);
$('#retry').onclick = async () => {
  try {
    const result = await rpc({ type: 'Retry', tabId: tab.id });
    if (result?.health) $('#adapter-warning').hidden = result.health.status !== 'stale';
    tell('');
  } catch (error) { tell(error); }
};
$('#open-book').onclick = async () => {
  const button = $('#open-book');
  if (button.disabled) return;
  button.disabled = true; tell('');
  try { await openBook(); }
  catch (error) { tell(error); }
  finally { button.disabled = false; }
};
// The website is asked what it keeps; the book page is where it is read and
// where the decision is made. Nothing is written from here.
$('#import-site').onclick = async () => {
  const button = $('#import-site');
  if (button.disabled) return;
  button.disabled = true; tell('');
  try {
    const result = await rpc({ type: 'Harvest', tabId: tab.id });
    if (!result.count) tell('This website is keeping no names to bring in.');
    else { await openBook(); window.close(); }
  } catch (error) { tell(error); }
  finally { button.disabled = false; }
};
tooltips();
watchBook(() => state, render);
render();
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) siteURL = new URL(tab.url);
  $('#site-name').textContent = siteURL?.hostname || '';
  const result = await rpc({ type: 'State', tabId: tab?.id });
  sites = result.sites; health = result.health; render(result.state);
  // The popup is only ever open for a moment, so ask while it is, rather than
  // waiting for a button press to make the time above it true. The ask is
  // conditional and rate limited, so opening the popup repeatedly costs little.
  rpc({ type: 'Sync' }).then(result => render({ ...state, syncedAt: result?.syncedAt ?? state.syncedAt })).catch(() => {});
  if (result.health?.status === 'stale' && sites[siteURL?.origin]) {
    $('#adapter-warning p').textContent = `${result.health.adapter} tagging paused. Your book is safe.`;
    $('#adapter-warning').hidden = false;
  }
} catch (error) { tell(error); }
