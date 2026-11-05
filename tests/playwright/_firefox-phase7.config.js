// Temporary Firefox runner for the phase-7 full cross-check of the
// prior-phase suites that the committed firefox project does not scope
// (same injection style as browser-extension.spec.js). Not part of the
// default suite. pagination.spec.js and media-mode.spec.js were Session-6
// Chromium-only until now; this config adds their Firefox coverage.
const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: [
    "animations-gestures.spec.js",
    "regression-audit.spec.js",
    "pagination.spec.js",
    "media-mode.spec.js",
  ],
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
