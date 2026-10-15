// One controller per isolated world, including when a site is enabled mid-page.
if (!globalThis.__oxtaggerStarting) {
  globalThis.__oxtaggerStarting = true;
  import(chrome.runtime.getURL('page.js')).then(module => module.startPage()).catch(error => {
    console.warn('0xtagger could not start:', error.message);
    globalThis.__oxtaggerStarting = false;
  });
}
