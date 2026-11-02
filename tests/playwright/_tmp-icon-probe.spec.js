const { test, chromium } = require("@playwright/test");
const path = require("path");
test("tmp icon probe", async ({}, testInfo) => {
  if (process.env.SKIP_PROBE) return;
{
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.route("https://i.redd.it/**", r => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>' }));
  await p.setContent('<base href="https://www.reddit.com/">' + '<div class="thing link" data-url="https://i.redd.it/x.jpg" data-permalink="/r/pics/comments/x/post/" data-author="a" data-subreddit="pics"><a class="title">One</a></div>');
  await p.addStyleTag({ path: "browser-extension/presentation.css" });
  await p.addScriptTag({ path: "browser-extension/content.js" });
  await p.waitForTimeout(400);
  console.log("INITIAL:", JSON.stringify(await p.evaluate(() => {
    const a = document.querySelector(".redditp__auto");
    return { html: a.innerHTML.slice(0, 40), label: a.getAttribute("aria-label"), pressed: a.getAttribute("aria-pressed"), text: a.textContent, title: a.title, count: document.querySelector(".redditp__count").textContent, countBox: JSON.stringify(document.querySelector(".redditp__count").getBoundingClientRect()), autoBoxCenter: (r => (r.top + r.height/2).toFixed(1))(document.querySelector(".redditp__auto").getBoundingClientRect()), countBoxCenter: (r => (r.top + r.height/2).toFixed(1))(document.querySelector(".redditp__count").getBoundingClientRect()) };
  })));
  // keyboard: focus auto + Enter toggles
  await p.evaluate(() => document.querySelector(".redditp__auto").focus());
  await p.keyboard.press("Enter");
  console.log("AFTER-ENTER:", JSON.stringify(await p.evaluate(() => { const a = document.querySelector(".redditp__auto"); return { label: a.getAttribute("aria-label"), pressed: a.getAttribute("aria-pressed"), svg: a.innerHTML.includes("svg") }; })));
  await b.close();
}});
