import { hostPermission } from './shared.js';
import { $, rpc, emptyState, currentSnapshot, syncText, connectionPicker, connectionForm } from './ui.js';

let state = emptyState;
let sites = {};
let tab;
let siteURL;
let busy = false;
let siteBusy = false;
const tell = error => { $('#message').textContent = error?.message || String(error || ''); };
const setup = connectionForm({ container: $('#settings'), state: () => state, connected: render,
  busy: value => { busy = value; render(); }, error: tell,
  visible: open => { $('#home').hidden = open; tell(''); },
});
const picker = connectionPicker({ add: () => setup.open(), select: async url => {
  try { render(await rpc({ type: 'Select', url })); tell(''); } catch (error) { tell(error); }
} });
function render(next = state) {
  if (!currentSnapshot(next, state)) return;
  state = next;
  picker(state);
  $('#connection').disabled = busy;
  $('#settings-toggle').disabled = busy;
  $('#refresh').disabled = !state.connectionKey || busy || $('#refresh').hasAttribute('aria-busy');
  $('#sync').textContent = busy ? 'Connecting…' : syncText(state);
  $('#sync').title = state.error || '';
  $('#sync').dataset.offline = String(Boolean(state.error));
  const enabled = Boolean(siteURL && sites[siteURL.origin]);
  $('#site-toggle').setAttribute('aria-checked', String(enabled));
  $('#site-toggle').disabled = !siteURL || siteBusy || !state.connectionKey && !enabled;
  $('#site-view').textContent = !siteURL ? 'Open a website to use your tags' : enabled ? 'Your tags are on' : 'Website originals';
}
$('#settings-toggle').onclick = () => setup.open(Boolean(state.connectionKey));
$('#refresh').onclick = async () => {
  if (busy) return;
  $('#refresh').disabled = true; $('#refresh').setAttribute('aria-busy', 'true');
  try { render(await rpc({ type: 'Refresh' })); tell(''); } catch (error) { tell(error); }
  finally { $('#refresh').removeAttribute('aria-busy'); render(); }
};
async function enable(enabled) {
  siteBusy = true; render();
  try {
    if (!siteURL) throw new Error('Open a website to enable labeling.');
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
$('#open-book').onclick = () => chrome.runtime.openOptionsPage().catch(tell);
chrome.runtime.onMessage.addListener(message => { if (message.type === 'Updated') render(message.state); });
render();
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) siteURL = new URL(tab.url);
  $('#site-name').textContent = siteURL?.hostname || 'No website open';
  const result = await rpc({ type: 'State', tabId: tab?.id });
  sites = result.sites; render(result.state);
  if (result.health?.status === 'stale' && sites[siteURL?.origin]) {
    $('#adapter-warning p').textContent = `${result.health.adapter} labeling paused. Your book is safe.`;
    $('#adapter-warning').hidden = false;
  }
} catch (error) { tell(error); }
