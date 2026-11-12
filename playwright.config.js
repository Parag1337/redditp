const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/playwright",
  timeout: 30 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      // The extension specs inject content.js directly, so the same suite
      // also covers the Firefox add-on build. The RedGIFs bridge spec is
      // included because it exercises the same injected-files path.
      name: "firefox",
      testMatch: /(?:browser-extension|redgifs-bridge)\.spec\.js/,
      use: {
        ...devices["Desktop Firefox"],
      },
    },
  ],

});
