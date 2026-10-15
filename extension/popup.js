import { hostPermission } from './shared.js';
import { $, rpc, emptyState, currentSnapshot, syncText, bookPicker, newBookForm, watchBook } from './ui.js';

let state = emptyState;
let sites = {};
let tab;
let siteURL;
let busy = false;
let siteBusy = false;
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
const setup = newBookForm({ container: $('#server'), state: () => state, created: render,
  busy: value => { busy = value; render(); }, error: tell,
  visible: open => { $('#home').hidden = open; tell(''); },
});
const picker = bookPicker({
  add: () => setup.open(),
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
  $('#sync').title = state.error || '';
  $('#sync').dataset.offline = String(Boolean(state.error));
  const enabled = Boolean(siteURL && sites[siteURL.origin]);
  // With no website in front of it the row has nothing to say, so it says
  // nothing rather than standing there explaining its own absence.
  $('.site').hidden = !siteURL;
  $('#site-toggle').setAttribute('aria-checked', String(enabled));
  // The switch still answers without a book, because a control that silently
  // ignores a click reads as broken rather than unavailable.
  $('#site-toggle').disabled = siteBusy;
  $('#site-toggle').title = enabled ? 'Show the website originals again' : 'Show my tags on this website';
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
  try {
    const url = chrome.runtime.getURL('book.html');
    const [book] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
    if (book) {
      await chrome.tabs.update(book.tabId, { active: true });
      await chrome.windows.update(book.windowId, { focused: true });
    } else await chrome.tabs.create({ url });
  } catch (error) { tell(error); }
  finally { button.disabled = false; }
};
watchBook(() => state, render);
render();
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) siteURL = new URL(tab.url);
  $('#site-name').textContent = siteURL?.hostname || '';
  const result = await rpc({ type: 'State', tabId: tab?.id });
  sites = result.sites; render(result.state);
  // The popup is only ever open for a moment, so ask while it is, rather than
  // waiting for a button press to make the time above it true. The ask is
  // conditional and rate limited, so opening the popup repeatedly costs little.
  rpc({ type: 'Sync' }).then(result => render({ ...state, syncedAt: result?.syncedAt ?? state.syncedAt })).catch(() => {});
  if (result.health?.status === 'stale' && sites[siteURL?.origin]) {
    $('#adapter-warning p').textContent = `${result.health.adapter} tagging paused. Your book is safe.`;
    $('#adapter-warning').hidden = false;
  }
} catch (error) { tell(error); }
