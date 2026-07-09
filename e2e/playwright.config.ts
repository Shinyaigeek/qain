import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5599',
    // qain is Chromium-only by design: DOMSnapshot.captureSnapshot and
    // CSS.forcePseudoState have no Firefox or WebKit equivalent.
    channel: process.env.QAIN_CHROME_PATH ? undefined : 'chrome',
    launchOptions: process.env.QAIN_CHROME_PATH
      ? { executablePath: process.env.QAIN_CHROME_PATH }
      : {},
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:5599/base.html',
    reuseExistingServer: !process.env.CI,
  },
})
