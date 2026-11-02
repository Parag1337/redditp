const { test } = require("@playwright/test");
const path = require("path");

const scriptPath = path.resolve(process.env.PROBE_SCRIPT || "browser-extension/content.js");
const stylePath = path.resolve(process.env.PROBE_STYLE || "browser-extension/presentation.css");

function postsHtml(n) {
  return Array.from(
    { length: n },
    (_, i) =>
      `<div class="thing link" data-fullname="t3_s${i}" data-url="https://i.redd.it/s${i}.jpg" data-permalink="/r/pics/comments/s${i}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${i + 1}</a></div>`,
  ).join("");
}

async function openFeed(page, count) {
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  await page.setContent(`<base href="https://www.reddit.com/">${postsHtml(count)}`);
  await page.addStyleTag({ path: stylePath });
  await page.addScriptTag({ path: scriptPath });
  await page.waitForTimeout(300);
  await page.keyboard.press("a"); // manual mode for determinism
  await page.waitForTimeout(100);
}

// measures the whole-viewer anchoring state
const TEM = () => {
  const root = document.getElementById("redditp-presentation");
  const b = root.getBoundingClientRect();
  return {
    rootScrollLeft: root.scrollLeft,
    rootScrollTop: root.scrollTop,
    rootScrollWidth: root.scrollWidth,
    rootClientWidth: root.clientWidth,
    boxLeft: +b.left.toFixed(1),
    boxWidth: +b.width.toFixed(1),
    docScrollX: document.documentElement.scrollLeft,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    bar: (() => {
      const bar = document.querySelector(".redditp__numbers");
      return {
        sw: bar.scrollWidth,
        cw: bar.clientWidth,
        sl: bar.scrollLeft,
      };
    })(),
    countText: document.querySelector(".redditp__count")?.textContent,
    title: document.querySelector(".redditp__title")?.textContent,
  };
};

test("probe viewer shift on rapid arrow navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFeed(page, 25);
  console.log("T0=" + JSON.stringify(await page.evaluate(TEM)));
  // rapid sequence: 12 quick ArrowRight presses
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(30);
  }
  console.log("T12=" + JSON.stringify(await page.evaluate(TEM)));
  // many more
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowRight");
  }
  await page.waitForTimeout(150);
  console.log("T24=" + JSON.stringify(await page.evaluate(TEM)));
  // left arrow back
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.waitForTimeout(150);
  console.log("TLEFT=" + JSON.stringify(await page.evaluate(TEM)));
});
