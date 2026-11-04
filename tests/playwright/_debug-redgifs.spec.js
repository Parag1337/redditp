const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const extensionScript = path.resolve(__dirname, "../../browser-extension/content.js");
const extensionStyles = path.resolve(__dirname, "../../browser-extension/presentation.css");
const feedUrl = "https://www.reddit.com/r/pics/?redditp=mediamodedebug3";
const webm = fs.readFileSync(path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"));
const svgImage = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}/DASH_480.mp4" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

test("debug slideshow advance", async ({ page }) => {
  page.route("https://i.redd.it/**", (r) =>
    r.fulfill({ contentType: "image/svg+xml", body: svgImage }));
  page.route("https://v.redd.it/**", (r) =>
    r.fulfill({ contentType: "video/webm", body: webm }));
  const body = `${imagePost("t1", "Image 1")}${videoPost("t2", "Clip 3")}${imagePost("t3", "Image 3")}${imagePost("t4", "Image 4")}`;
  await page.route(feedUrl, (r) => r.fulfill({ contentType: "text/html", body: `<html><body>${body}</body></html>` }));
  await page.goto(feedUrl);
  await page.evaluate(() => {
    localStorage.setItem("redditpDebug", "1");
    localStorage.removeItem("redditpPresentationSettings");
    localStorage.setItem(
      "redditpPresentationSettings",
      JSON.stringify({ slideDurationSeconds: 1 }),
    );
  });
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  const t0 = Date.now();
  // Track title over time
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => {
      const el = document.querySelector(".redditp__auto");
      return {
        title: document.querySelector(".redditp__title")?.textContent,
        pressed: el?.getAttribute("aria-pressed"),
        video: document.querySelectorAll(".redditp__video").length,
        count: document.querySelector(".redditp__count")?.textContent,
      };
    });
    console.log(`t=${Date.now() - t0}ms`, JSON.stringify(state));
    if (i === 5) break;
  }
  const events = await page.evaluate(() =>
    window.__redditpPresentation.debug.log().map((e) => e.event + " " + JSON.stringify(e.detail)));
  console.log(events.join("\n"));
});
