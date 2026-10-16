import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 30000,
  // Without this a click on an element that never appears waits for the whole
  // test budget, which reports a timeout instead of naming what was missing.
  use: { headless: true, baseURL: 'http://127.0.0.1:8719', viewport: { width: 1200, height: 800 }, actionTimeout: 10000 },
  webServer: [
    // Keep-alive, because the controller suites import page.js and it pulls in
    // nine more modules at once. On HTTP/1.0 every one of them is its own
    // connection, and the fixture server dropped enough of them to fail an
    // import outright in two runs out of three.
    { command: 'uv run python -m http.server 8719 --bind 127.0.0.1 --protocol HTTP/1.1', url: 'http://127.0.0.1:8719/tests/fixtures/page.html', reuseExistingServer: false },
    { command: 'uv run python tests/serve_book.py --port 8721', url: 'http://127.0.0.1:8721/tags', reuseExistingServer: false },
    { command: 'uv run python tests/serve_book.py --port 8722 --tls', url: 'https://127.0.0.1:8722/tags', ignoreHTTPSErrors: true, reuseExistingServer: false },
    { command: 'uv run python tests/serve_book.py --port 8723 --web', url: 'http://127.0.0.1:8723/0xtagger/colors.css', reuseExistingServer: false },
  ],
});
