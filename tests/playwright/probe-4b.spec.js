const { test } = require("@playwright/test");
const path = require("path");

const extensionScript = path.resolve("browser-extension/content.js");
const extensionStyles = path.resolve("browser-extension/presentation.css");
const { chromium, firefox } = require("@playwright/test");

function posts(n) {
  return Array.from(
    { length: n },
    (_, i) =>
      `<div class="thing link" data-fullname="t3_n${i}" data-url="https://i.redd.it/n${i}.jpg" data-permalink="/r/pics/comments/n${i}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${i + 1}</a></div>`,
  ).join("");
}

async function openFeed(page, count) {
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  await page.setContent(`<base href="https://www.reddit.com/">${posts(count)}`);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await page.waitForTimeout(300);
  await page.keyboard.press("a"); // ensure manual mode determinism
  await page.waitForTimeout(100);
}

function measureBar() {
  const bar = document.querySelector(".redditp__numbers");
  const b = bar.getBoundingClientRect();
  const root = document.getElementById("redditp-presentation");
  return {
    scrollWidth: bar.scrollWidth,
    clientWidth: bar.clientWidth,
    boxLeft: +b.left.toFixed(1),
    boxWidth: +b.width.toFixed(1),
    scrollLeft: bar.scrollLeft,
    rootScrollLeft: root.scrollLeft,
    rootScrollWidth: root.scrollWidth,
    justify: getComputedStyle(bar).justifyContent,
    minContent: (() => {
      bar.style.minWidth = "0";
      const after = bar.getBoundingClientRect();
      const w = { clampedWidth: +after.width.toFixed(1) };
      bar.style.minWidth = "";
      return w;
    })(),
  };
}

test("probe bar mechanics", async ({ page }) => {
  // scrolled-to-end trailing padding check in both engines
  const { firefox } = require("@playwright/test");
  for (const browserType of [chromium, firefox]) {
    const b = await browserType.launch();
    const p2 = await b.newPage({ viewport: { width: 390, height: 844 } });
    await openFeed(p2, 100);
    const end = await p2.evaluate(() => {
      const bar = document.querySelector(".redditp__numbers");
      bar.scrollLeft = bar.scrollWidth;
      const last = [...document.querySelectorAll(".redditp__number")].pop();
      const lr = last.getBoundingClientRect();
      const track = bar.getBoundingClientRect();
      const root = document.getElementById("redditp-presentation");
      // active-scroll behavior (as sync does on every render)
      document
        .querySelector(".redditp__number--active")
        .scrollIntoView({ inline: "nearest", block: "nearest" });
      return {
        scrollWidth: bar.scrollWidth,
        clientWidth: bar.clientWidth,
        scrollLeft: bar.scrollLeft,
        lastRight: +lr.right.toFixed(1),
        lastLeft: +lr.left.toFixed(1),
        viewport: window.innerWidth,
        trackRight: +track.right.toFixed(1),
        rootScrollLeft: root.scrollLeft,
        docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    console.log(
      (browserType === chromium ? "CHROME" : "FIREFOX") + "=" +
        JSON.stringify(end),
    );
    await b.close();
  }
  // untouched open, 13 posts, 360 viewport (mirrors existing passing test)
  await page.setViewportSize({ width: 360, height: 780 });
  await openFeed(page, 13);
  console.log("OPEN13:", JSON.stringify(await page.evaluate(measureBar)));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
  console.log("NAV13:", JSON.stringify(await page.evaluate(measureBar)));

  // same but 100 posts
  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: 390, height: 844 });
  await openFeed(p2, 100);
  console.log("OPEN100:", JSON.stringify(await p2.evaluate(measureBar)));
  await p2.keyboard.press("ArrowRight");
  await p2.waitForTimeout(120);
  console.log("NAV100:", JSON.stringify(await p2.evaluate(measureBar)));
  // emulate what content.js does on every sync ("nearest" scrollIntoView):
  await p2.evaluate(() => {
    document
      .querySelector(".redditp__number--active")
      .scrollIntoView({ inline: "nearest", block: "nearest" });
  });
  await p2.waitForTimeout(120);
  console.log("SIV100:", JSON.stringify(await p2.evaluate(measureBar)));
  await p2.close();
});
