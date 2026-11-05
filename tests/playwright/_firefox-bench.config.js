// Temporary Firefox runner for the phase-7 preload benchmark spec (same
// injection style as browser-extension.spec.js, which is what the committed
// firefox project is scoped to). Not part of the default suite.
const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ["preload-benchmarks.spec.js"],
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
