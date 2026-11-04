const { defineConfig, devices } = require("@playwright/test");
module.exports = defineConfig({
  testDir: ".",
  testMatch: "_debug*.spec.js",
  timeout: 30 * 1000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
