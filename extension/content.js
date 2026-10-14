// One controller per isolated world, including when a site is enabled mid-page.
if (!globalThis.__oxlabelStarting) {
  globalThis.__oxlabelStarting = true;
  import(chrome.runtime.getURL('page.js')).then(module => module.startPage()).catch(error => {
    console.warn('0xlabel could not start:', error.message);
    globalThis.__oxlabelStarting = false;
  });
}
