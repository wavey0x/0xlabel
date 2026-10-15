import { startBook } from './book.js';
import { rpc, watchBook } from './ui.js';

startBook({ rpc, watchBook, manageBooks: true,
  watchPending: listener => chrome.storage.session.onChanged.addListener(listener),
});
