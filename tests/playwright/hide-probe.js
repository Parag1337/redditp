// Standalone hide-button stability probe (temp, not part of the suite):
// toggles hide/show three times at every requested breakpoint on Chrome and
// Firefox, records the eye chip's box each time, and screenshots the visible
// and hidden states.
const path = require("path");
const fs = require("fs");
const { chromium, firefox } = require("@playwright/test");

const script = path.resolve(__dirname, "../../browser-extension/content.js");
const styles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const VIEWPORTS = [
  ["port320", 320, 780],
  ["port360", 360, 780],
  ["port390", 390, 844],
  ["port430", 430, 915],
  ["land844", 844, 390],
  ["desk1280", 1280, 800],
  ["desk1920", 1920, 1080],
];

const feed = Array.from({ length: 3 }, (_, i) =>
  `<div class="thing link" data-fullname="t3_h${i}" data-url="https://i.redd.it/h${i}.jpg" data-permalink="/r/pics/comments/h${i}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${i + 1}</a></div>`,
).join("");

async function measure(page) {
  return page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      const s = svg ? svg.getBoundingClientRect() : null;
      return {
        left: +b.left.toFixed(1),
        top: +b.top.toFixed(1),
        right: +b.right.toFixed(1),
        bottom: +b.bottom.toFixed(1),
        svgW: s ? +s.width.toFixed(1) : null,
        hidden: el.hidden || !!(el.offsetWidth === 0 && el.offsetHeight === 0),
      };
    };
    const chips = ["close", "rotate", "settings-button", "fullscreen", "hide"]
      .map((c) => [c, r(`.redditp__${c}`)]);
    const details = document.querySelector(".redditp__details");
    const dStyle = getComputedStyle(details);
    return {
      chips,
      hiddenAttr: details.hidden,
      display: dStyle.display,
      visibility: dStyle.visibility,
      eyeBg: getComputedStyle(document.querySelector(".redditp__hide")).backgroundColor,
      eyeOpacity: getComputedStyle(document.querySelector(".redditp__hide")).opacity,
    };
  });
}

(async () => {
  const out = {};
  const shotDir = path.join(__dirname, "hide-probe-shots");
  fs.mkdirSync(shotDir, { recursive: true });
  for (const [name, type, channel] of [
    ["chrome", chromium, "chrome"],
    ["firefox", firefox, undefined],
  ]) {
    const browser = await type.launch({ channel });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("https://*.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    await page.route("https://www.reddit.com/r/pics/?redditp=1", (route) =>
      route.fulfill({ contentType: "text/html", body: feed }),
    );
    await page.goto("https://www.reddit.com/r/pics/?redditp=1");
    await page.addStyleTag({ path: styles });
    await page.addScriptTag({ path: script });
    await page.evaluate(() => {
      const b = document.querySelector(".redditp__auto");
      if (b && b.getAttribute("aria-pressed") === "true") b.click();
    });
    out[name] = {};
    for (const [label, w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(80);
      const measurements = { start: await measure(page) };
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await page.locator(".redditp__hide").click();
        await page.waitForTimeout(60);
        const hiddenState = await measure(page);
        if (cycle === 1) {
          await page.screenshot({
            path: path.join(shotDir, `${name}-${label}-hidden.png`),
          });
        }
        await page.locator(".redditp__hide").click();
        await page.waitForTimeout(60);
        const shownState = await measure(page);
        if (cycle === 1) {
          await page.screenshot({
            path: path.join(shotDir, `${name}-${label}-visible.png`),
          });
        }
        measurements[`cycle${cycle}`] = { shown: shownState, hidden: hiddenState };
      }
      out[name][label] = measurements;
      // stability summary
      const eye = (m) => m.chips[4][1];
      const base = eye(measurements.start);
      const moves = [];
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        for (const st of ["shown", "hidden"]) {
          const b = eye(measurements[`cycle${cycle}`][st]);
          if (
            Math.abs(b.left - base.left) > 0.6 ||
            Math.abs(b.top - base.top) > 0.6
          ) {
            moves.push(`cycle${cycle}-${st} L${base.left}->${b.left} T${base.top}->${b.top}`);
          }
        }
      }
      console.log(`${name} ${label}: eye(${base.left},${base.top}) ` +
        (moves.length ? "MOVES " + moves.join(" | ") : "stable"));
      if (measurements.cycle1.hidden.hiddenAttr) {
        console.log(`${name} ${label}: details hiddenAttr=true in hidden state (reflow fixed or not)`);
      }
      console.log(`${name} ${label}: hidden eye bg=${measurements.cycle1.hidden.eyeBg} opacity=${measurements.cycle1.hidden.eyeOpacity} svg=${measurements.cycle1.hidden.chips[4][1].svgW}`);
    }
    await browser.close();
  }
  fs.writeFileSync(
    path.join(__dirname, "hide-probe-result.json"),
    JSON.stringify(out, null, 1),
  );
})();
