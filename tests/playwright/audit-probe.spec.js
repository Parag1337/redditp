const path = require("path");
const { test, expect } = require("@playwright/test");

// TEMPORARY audit probe file - used to verify suspected preload defects
// against the unmodified source. Removed/merged after the audit.

const extensionScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title, videoUrl) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="${videoUrl}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const imagePage = (ids) => ids.map((id, i) => imagePost(id, `Image ${i + 1}: ${id}`)).join("");

const feedUrl = "https://www.reddit.com/r/pics/?redditp=1";

async function openFeed(page, body, setup) {
  await page.route(feedUrl, (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  await page.goto(feedUrl);
  if (setup) await setup(page);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  const pressed = await page
    .locator(".redditp__auto")
    .getAttribute("aria-pressed");
  if (pressed !== "false") {
    await page.locator(".redditp__auto").click();
  }
}

const stats = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());

function trackImages(page, delay = 0) {
  const tracker = { requested: [] };
  page.route("https://i.redd.it/**", async (route) => {
    tracker.requested.push(route.request().url());
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({
      status: 200,
      headers: { "cache-control": "public, max-age=31536000" },
      contentType: "image/svg+xml",
      body: svgImage,
    });
  });
  return tracker;
}

// Starts an in-page sampler of debug.stats().inFlight.
async function startInFlightSampler(page, intervalMs = 20) {
  return page.evaluate((interval) => {
    window.__maxInFlight = 0;
    window.__samples = [];
    return new Promise((resolve) => {
      window.__sampler = setInterval(() => {
        const s = window.__redditpPresentation.debug.stats();
        window.__maxInFlight = Math.max(window.__maxInFlight, s.inFlight);
        window.__samples.push(s.inFlight);
        if (window.__stopSampler) {
          clearInterval(window.__sampler);
          window.__stopSampler = false;
          resolve(window.__maxInFlight);
        }
      }, interval);
    });
  }, intervalMs);
}

async function stopInFlightSampler(page) {
  return page.evaluate(() => {
    window.__stopSampler = true;
    return new Promise((resolve) => {
      const check = () => {
        if (window.__stopSampler === false) resolve(window.__maxInFlight);
        else setTimeout(check, 20);
      };
      check();
    });
  });
}

test.describe("audit probes: concurrency", () => {
  test.setTimeout(45000);

  test("probe 1: refresh hammering while saturated", async ({ page }) => {
    trackImages(page, 300);
    await page.route(feedUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: imagePage(["cz1", "cz2", "cz3", "cz4", "cz5", "cz6", "cz7", "cz8"]),
      }),
    );
    await page.goto(feedUrl);
    // Attach the sampler after navigation but before the extension loads so
    // the whole preload lifecycle is observed in one execution context.
    const samplerDone = startInFlightSampler(page);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    const pressed = await page
      .locator(".redditp__auto")
      .getAttribute("aria-pressed");
    if (pressed !== "false") await page.locator(".redditp__auto").click();
    await expect(page.locator(".redditp__count")).toHaveText("1 / 8");

    // Hammer the scheduler like debug.refresh() during a slow network.
    for (let pass = 0; pass < 8; pass += 1) {
      await page.evaluate(() =>
        window.__redditpPresentation.debug.refresh(),
      );
      await page.waitForTimeout(40);
    }
    const max = await stopInFlightSampler(page);
    // eslint-disable-next-line no-console
    console.log("PROBE1 maxInFlight after refresh hammering:", max);
    expect(max).toBeLessThanOrEqual(3);
    await samplerDone;
  });

  test("probe 2: rapid navigation while saturated", async ({ page }) => {
    trackImages(page, 700);
    await openFeed(page, imagePage(["rz1", "rz2", "rz3", "rz4", "rz5", "rz6", "rz7", "rz8"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 8");

    const samplerDone = startInFlightSampler(page);
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(50);
    }
    const max = await stopInFlightSampler(page);
    // eslint-disable-next-line no-console
    console.log("PROBE2 maxInFlight during rapid navigation:", max);
    expect(max).toBeLessThanOrEqual(3);
    await samplerDone;
  });
});

test.describe("audit probes: visibility", () => {
  test.setTimeout(45000);

  test("probe 3: hidden tab defers, visible tab resumes", async ({ page }) => {
    const media = trackImages(page, 200);
    await page.route(feedUrl, (route) =>
      route.fulfill({ contentType: "text/html", body: imagePage(["hz1", "hz2", "hz3", "hz4", "hz5", "hz6", "hz7", "hz8"]) }),
    );
    await page.goto(feedUrl);
    // Force hidden BEFORE the extension loads so the whole initial queue is
    // pending work the scheduler must defer.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => window.__forceHidden === true,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (window.__forceHidden === true ? "hidden" : "visible"),
      });
      window.__forceHidden = true;
    });
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    const pressed = await page
      .locator(".redditp__auto")
      .getAttribute("aria-pressed");
    if (pressed !== "false") await page.locator(".redditp__auto").click();
    await expect(page.locator(".redditp__count")).toHaveText("1 / 8");

    // While hidden: only the on-screen slide fetched itself; the scheduler
    // must not start speculative work.
    await page.waitForTimeout(900);
    const hiddenStats = await stats(page);
    const queueWhileHidden = await page.evaluate(
      () => window.__redditpPresentation.debug.queue().length,
    );
    // eslint-disable-next-line no-console
    console.log(
      "PROBE3 while hidden: started",
      hiddenStats.started,
      "inFlight",
      hiddenStats.inFlight,
      "queue",
      queueWhileHidden,
      "requests",
      media.requested.length,
    );

    // Return to visible with only the visibilitychange signal a real browser
    // would deliver. Does the pending queue resume on its own?
    await page.evaluate(() => {
      window.__forceHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(1500);
    const visibleStats = await stats(page);
    const queueAfterVisible = await page.evaluate(
      () => window.__redditpPresentation.debug.queue().length,
    );
    // eslint-disable-next-line no-console
    console.log(
      "PROBE3 after visible: started",
      visibleStats.started,
      "queue",
      queueAfterVisible,
      "requests",
      media.requested.length,
    );
    expect(queueAfterVisible).toBe(0);
    expect(visibleStats.started).toBeGreaterThan(hiddenStats.started);
  });
});

test.describe("audit probes: video handoff", () => {
  test.setTimeout(45000);
  const webm = require("fs").readFileSync(
    path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
  );

  function trackVideos(page, delay = 0) {
    const tracker = { requested: [], at: [] };
    page.route("https://v.redd.it/**", async (route) => {
      tracker.requested.push(route.request().url());
      tracker.at.push(Date.now());
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm,
      });
    });
    return tracker;
  }

  test("probe 4: navigating onto an in-flight video", async ({ page }) => {
    // Count element-level src assignments: one assignment per element fetch
    // initiation, independent of how many range requests the browser issues.
    await page.addInitScript(() => {
      window.__videoSrcSets = [];
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        "src",
      );
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          window.__videoSrcSets.push(String(value));
          descriptor.set.call(this, value);
        },
      });
    });
    const videos = trackVideos(page, 600);
    await openFeed(
      page,
      `${imagePost("iv1", "Image 1: iv1")}${videoPost(
        "iv2",
        "Clip A",
        "https://v.redd.it/va/DASH_480.mp4",
      )}${imagePost("iv3", "Image 3: iv3")}`,
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Navigate onto the video while its metadata preload is still running.
    await page.waitForTimeout(120); // let preload start (600ms delay => still in flight)
    const inflight = await page.evaluate(
      () => window.__redditpPresentation.debug.stats().inFlight,
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip A");
    await page.waitForTimeout(1500);
    const count = videos.requested.filter((u) => u.includes("/va/")).length;
    const srcSets = await page.evaluate(
      () => window.__videoSrcSets.filter((u) => u.includes("/va/")).length,
    );
    // eslint-disable-next-line no-console
    console.log(
      "PROBE4 inFlight at nav:",
      inflight,
      "requests for video:",
      count,
      "src assignments:",
      srcSets,
    );
    expect(srcSets).toBe(1);
  });
});
