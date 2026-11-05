// Standalone perf probe: counts numbered-bar button churn (added DOM nodes)
// during navigation across a long feed. Run against either the working-tree
// content.js or the HEAD version via AUDIT_BEFORE=1.
const path = require("path");
const fs = require("fs");
const { chromium } = require("@playwright/test");

const workingScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const imagePost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${id}</a></div>`;

(async () => {
  const before = process.env.AUDIT_BEFORE === "1";
  let scriptPath = workingScript;
  if (before) {
    const { execFileSync } = require("child_process");
    scriptPath = path.join(__dirname, "ui-probe-before-content.js");
    fs.writeFileSync(
      scriptPath,
      execFileSync("git", [
        "-C",
        path.resolve(__dirname, "../.."),
        "show",
        "HEAD:browser-extension/content.js",
      ]),
    );
  }
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  const posts = Array.from({ length: 130 }, (_, i) => imagePost(`n${i + 1}`)).join("");
  await page.setContent(`<base href="https://www.reddit.com/">${posts}`);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: scriptPath });
  const auto = page.locator(".redditp__auto");
  if ((await auto.getAttribute("aria-pressed")) === "true") await auto.click();

  const counts = await page.evaluate(async () => {
    const bar = document.querySelector(".redditp__numbers");
    let churn = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.classList?.contains("redditp__number")) churn += 1;
        }
      }
    }).observe(bar, { childList: true });
    const dispatch = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const navigations = 20;
    // measure wall time of the 20 renders' UI sync via performance.now()
    // around each press's synchronous handler
    const samples = [];
    window.addEventListener(
      "keydown",
      () => {
        const t0 = performance.now();
        // the content script's capture-phase handler runs first; time until next microtask pending
        samples.push(0);
        requestAnimationFrame(() => {});
        void t0;
      },
      true,
    );
    for (let i = 0; i < navigations; i += 1) {
      const t0 = performance.now();
      dispatch();
      void t0;
      // let renders settle
      await new Promise((r) => setTimeout(r, 50));
    }
    return { churn, navigations, buttons: bar.querySelectorAll(".redditp__number").length };
  });
  console.log(
    `${before ? "BEFORE(HEAD)" : "AFTER(worktree)"}: numberButtonsCreated=${counts.churn}/${counts.navigations} (buttons=${counts.buttons})`,
  );
  await browser.close();
})();
