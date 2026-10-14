import config from './playwright.config.js';

export default {
  ...config, testDir: './docs/demo',
  use: { ...config.use, viewport: { width: 1120, height: 570 }, deviceScaleFactor: 2 },
  webServer: config.webServer.slice(0, 1),
};
