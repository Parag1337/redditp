// Temporary Firefox runner for the audit regression spec and the phase-6
// animation/gesture spec (same injection style as browser-extension.spec.js,
// which is what the committed firefox project is scoped to). Not part of the
// default suite.
const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ["regression-audit.spec.js", "animations-gestures.spec.js"],
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
