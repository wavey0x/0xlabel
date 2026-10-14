import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 30000,
  use: { headless: true, baseURL: 'http://127.0.0.1:8719', viewport: { width: 1200, height: 800 } },
  webServer: [
    { command: 'uv run python -m http.server 8719 --bind 127.0.0.1', url: 'http://127.0.0.1:8719/tests/fixtures/page.html', reuseExistingServer: false },
    { command: 'uv run python tests/serve_book.py --port 8721', url: 'http://127.0.0.1:8721/labels', reuseExistingServer: false },
    { command: 'uv run python tests/serve_book.py --port 8722 --tls', url: 'https://127.0.0.1:8722/labels', ignoreHTTPSErrors: true, reuseExistingServer: false },
  ],
});
