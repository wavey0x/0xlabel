import { startBook } from './book.js';
import { createStore } from './store.js';

// This page is a view of this server, never another place to keep a book.
const url = new URL('./', location.href).href.replace(/\/$/, '');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const settings = { books: [{ id: url, name: 'Address book', storage: { kind: 'server', url } }], activeBook: url };
let announce = () => {};
const store = createStore({
  storage: {
    async get(keys) {
      return structuredClone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, settings[key]])));
    },
    async set(values) { Object.assign(settings, structuredClone(values)); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete settings[key]; },
  },
  notify: state => announce(state),
});

try {
  await store.init();
  await store.refresh();
  if (store.state().error) throw new Error(store.state().error);
  await startBook({
    async rpc(message) {
      if (message.type === 'State') return { state: store.state() };
      if (message.type === 'Refresh') return store.refresh();
      if (message.type === 'Save') return store.save(message.draft);
      if (message.type === 'Import') return store.merge(message.records, message.book);
      throw new Error('This page opens the book kept by this server.');
    },
    watchBook: (_held, render) => { announce = render; },
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) store.sync().catch(() => {});
  });
} catch (error) {
  // A refused or unreachable server is not an empty address book.
  const main = document.querySelector('main');
  const message = document.querySelector('#message');
  message.textContent = error.message;
  const retry = document.createElement('button');
  retry.className = 'quiet'; retry.textContent = 'Try again'; retry.onclick = () => location.reload();
  main.replaceChildren(document.querySelector('.book-header'), message, retry);
  document.querySelector('.connection-line').hidden = true;
  main.hidden = false;
}
