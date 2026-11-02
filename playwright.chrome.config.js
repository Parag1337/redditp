const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/playwright',
  timeout: 30 * 1000,
  expect: { timeout: 10 * 1000 },
  use: {
    trace: 'on-first-retry',
    channel: 'chrome',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], channel: 'chrome' },
  }],

});
