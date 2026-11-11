// Phase 6 — resource-aware video preparation. These tests pin the network
// fairness contract added around the existing preload engine:
//
//   1. speculative video element fetches wait for a free pool slot while
//      image jobs are still waiting (a reserved slot for images),
//   2. on a congested network (recent image loads consistently slow) video
//      fetches pause entirely and resume when image latency recovers,
//   3. the immediate-next short video reaches initial media data (first
//      frame) BEFORE navigation, so display does not start from zero,
//   4. prepared videos survive forward-and-back navigation without a
//      refetch, and closing the viewer cancels in-flight preparation.
//
// Everything runs against the injected content script with routed responses;
// "slow network" is simulated with route delays, not measured on real radio
// conditions. Debug assertions read the production localStorage.redditpDebug
// event ring, not test-only hooks.
const path = require("path");
const fs = require("fs");
const { test, expect } = require("@playwright/test");

const extensionScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);

const listingUrl = "https://www.reddit.com/r/pics/?redditp=phase6";
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://preview.redd.it/${id}.mp4?format=mp4&amp;s=sig" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// Request log for one host: every request's URL and start time, so tests can
// assert ordering ("images completed before the video started") without
// guessing at internals.
function trackHost(page, host, delayMs = 0) {
  const tracker = { requests: [] };
  page.route(`https://${host}/**`, async (route) => {
    const url = route.request().url();
    const startedAt = Date.now();
    // The request is recorded at its START: tests assert about work that was
    // initiated, not about work that finished.
    const entry = { url, startedAt, fulfilledAt: startedAt };
    tracker.requests.push(entry);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    entry.fulfilledAt = Date.now();
    if (/\.(?:jpe?g|png|gif|svg)(?:\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: svgImage,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "video/webm",
      body: webm,
    });
  });
  return tracker;
}

const countOf = (tracker, needle) =>
  tracker.requests.filter(({ url }) => url.includes(needle)).length;

const stats = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());

const debugEvents = (page) =>
  page.evaluate(() =>
    window.__redditpPresentation.debug
      .log()
      .map(({ event, detail }) => ({ event, detail })),
  );

const navRecord = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());

// Opens the viewer with auto-advance pinned off and per-test preload
// settings. Duration overrides stub HTMLMediaElement.duration so eligibility
// is deterministic on any engine.
async function openFeed(
  page,
  body,
  { settings = {}, durations = {} } = {},
) {
  await page.route(listingUrl, (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  await page.goto(listingUrl);
  await page.evaluate(
    ([stored, overrides]) => {
      localStorage.setItem("redditpDebug", "1");
      localStorage.setItem(
        "redditpPresentationSettings",
        JSON.stringify({ autoAdvance: false, ...stored }),
      );
      if (Object.keys(overrides).length) {
        const cache = {};
        for (const [needle, seconds] of Object.entries(overrides)) {
          cache[needle] = seconds;
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "duration",
        );
        const original = descriptor ? descriptor.get : null;
        Object.defineProperty(HTMLMediaElement.prototype, "duration", {
          configurable: true,
          get() {
            const url = String(this.currentSrc || this.src || "");
            for (const [needle, seconds] of Object.entries(cache)) {
              if (url.indexOf(needle) !== -1) return seconds;
            }
            return original ? original.call(this) : NaN;
          },
        });
      }
    },
    [settings, durations],
  );
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
  await expect(page.locator(".redditp__auto")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
}

test.describe("phase 6 resource-aware video preparation", () => {
  test.setTimeout(70000);

  test("a queued video waits for a free slot while image jobs are still waiting", async ({
    page,
  }) => {
    // Concurrency 2 and the video at +2: the +1 image takes the first slot,
    // the +3 image waits behind the video, so the video may only start once
    // no image job is queued anymore.
    const images = trackHost(page, "i.redd.it", 600);
    const videos = trackHost(page, "preview.redd.it", 0);
    await openFeed(
      page,
      `${imagePost("w1", "Post 1")}${imagePost("w2", "Post 2")}${videoPost(
        "w3",
        "Clip 3",
      )}${imagePost("w4", "Post 4")}`,
      { settings: { preloadConcurrency: 2, preloadPosts: 3 } },
    );

    // Both images finish before the video element fetch starts.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));
    expect(countOf(videos, "w3.mp4")).toBeGreaterThanOrEqual(1);
    const videoStart = videos.requests[0].startedAt;
    const imageLoads = images.requests
      .filter(({ url }) => url.includes("w2") || url.includes("w4"))
      .map(({ fulfilledAt }) => fulfilledAt);
    expect(imageLoads.length).toBeGreaterThanOrEqual(2);
    for (const loadAt of imageLoads) {
      expect(loadAt, "images complete before the video fetch").toBeLessThanOrEqual(
        videoStart,
      );
    }
    // The deferral was an explicit, logged scheduler decision.
    const deferred = (await debugEvents(page)).filter(
      ({ event, detail }) =>
        event === "preload-video-deferred" &&
        detail?.reason === "image-priority",
    );
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    // And the deferred video still ends up prepared for navigation.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 3");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.readyState,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    expect(["prepared", "inflight"]).toContain((await navRecord(page)).reuse);
  });

  test("congested image latency pauses speculative video fetches until recovery", async ({
    page,
  }) => {
    // The slow phase walks a feed of 3500ms images so the rolling latency
    // window fills with congestion evidence. preloadPosts 3 keeps the fast
    // recovery images (s8, s9) out of the horizon until after the video has
    // entered its own 2-post window, so the deferral actually gets observed.
    let imageDelay = 3500;
    const imageRequests = [];
    await page.route("https://i.redd.it/**", async (route) => {
      const url = route.request().url();
      const startedAt = Date.now();
      if (imageDelay) {
        await new Promise((resolve) => setTimeout(resolve, imageDelay));
      }
      imageRequests.push({
        url,
        startedAt,
        fulfilledAt: Date.now(),
      });
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        // no-store: headerless fulfilled 200s can be heuristically cached at
        // the HTTP layer (Firefox in particular), which would let a
        // re-preload of an already displayed post skip the route. Cached
        // completions carry no network evidence either way — the production
        // side only counts loads that record a new resource timing entry —
        // but the fixture must not rely on HTTP caching either:
        // every image fetch under test should traverse the route and its
        // latency throttle.
        headers: { "cache-control": "no-store" },
        body: svgImage,
      });
    });
    const videos = trackHost(page, "preview.redd.it", 0);

    await openFeed(
      page,
      `${imagePost("s1", "Post 1")}${imagePost("s2", "Post 2")}${imagePost(
        "s3",
        "Post 3",
      )}${imagePost("s4", "Post 4")}${imagePost("s5", "Post 5")}${imagePost(
        "s6",
        "Post 6",
      )}${videoPost("s7", "Clip 7")}${imagePost("s8", "Post 8")}${imagePost(
        "s9",
        "Post 9",
      )}`,
      { settings: { preloadConcurrency: 5, preloadPosts: 3 } },
    );

    const drain = () =>
      expect
        .poll(() => stats(page), { timeout: 20000 })
        .toEqual(expect.objectContaining({ inFlight: 0 }));

    // Slow phase: walk forward one post at a time so s2..s6 all preload at
    // 3500ms. The video stays outside the video window (+2) until index 4.
    for (const title of ["Post 2", "Post 3", "Post 4"]) {
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".redditp__title")).toHaveText(title);
      await drain();
    }
    expect(countOf(videos, "s7.mp4")).toBe(0);

    // Still congested: the video now sits at +2 and must defer, with no
    // recovery possible yet (the only queued job is the video itself).
    imageDelay = 0;
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 5");
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).some(
            ({ event, detail }) =>
              event === "preload-video-deferred" &&
              detail?.reason === "slow-network",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.waitForTimeout(300);
    expect(countOf(videos, "s7.mp4")).toBe(0);

    // Recovery: the fast image at +3 (s8) completed at index 4, washing one
    // slow sample out of the window; the next fast image (s9) tips the
    // average back under the threshold and the video starts on its own.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 6");
    await expect
      .poll(() => countOf(videos, "s7.mp4"), { timeout: 20000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ videoFirstFrames: 1 }));
    // The video fetch began only after the recovery images completed: the
    // pause lifted because image latency recovered, not on a timer.
    const videoStart = videos.requests[0].startedAt;
    const recoveryImages = imageRequests.filter(
      ({ url }) => url.includes("s8") || url.includes("s9"),
    );
    expect(recoveryImages.length).toBeGreaterThanOrEqual(2);
    for (const image of recoveryImages) {
      expect(image.fulfilledAt).toBeLessThanOrEqual(videoStart);
    }
    // Reaching the post joins the prepared, first-frame-ready element.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 7");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.readyState,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(2);
    expect((await navRecord(page)).reuse).toBe("prepared");
  });

  test("the immediate next short video reaches first-frame data before navigation", async ({
    page,
  }) => {
    trackHost(page, "i.redd.it", 0);
    const videos = trackHost(page, "preview.redd.it", 0);
    await openFeed(
      page,
      `${imagePost("f1", "Post 1")}${videoPost("f2", "Clip 2")}${imagePost(
        "f3",
        "Post 3",
      )}`,
      { durations: { "f2.mp4": 6 } },
    );

    // Preparation goes past metadata: the first frame is buffered while the
    // user is still on the image post.
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ videoFirstFrames: 1 }));
    const firstFrames = (await debugEvents(page)).filter(
      ({ event }) => event === "preload-firstframe",
    );
    expect(firstFrames.length).toBeGreaterThanOrEqual(1);

    // Navigation joins it: data is already on the element, so the loading
    // indicator never appears and playback readiness is immediate.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 2");
    expect(
      await page.evaluate(() => ({
        readyState: document.querySelector(".redditp__video")?.readyState,
        preloaded:
          document.querySelector(".redditp__video")?.redditpPreloaded === true,
        loading: document
          .querySelector(".redditp__media")
          ?.classList.contains("redditp__loading"),
      })),
    ).toEqual(
      expect.objectContaining({ preloaded: true, loading: false }),
    );
    expect(countOf(videos, "f2.mp4")).toBeLessThanOrEqual(1);
  });

  test("a prepared video survives forward-and-back navigation without a refetch", async ({
    page,
  }) => {
    trackHost(page, "i.redd.it", 0);
    const videos = trackHost(page, "preview.redd.it", 0);
    await openFeed(
      page,
      `${imagePost("b1", "Post 1")}${videoPost("b2", "Clip 2")}${imagePost(
        "b3",
        "Post 3",
      )}${imagePost("b4", "Post 4")}`,
      { durations: { "b2.mp4": 6 } },
    );
    await expect
      .poll(() => countOf(videos, "b2.mp4"), { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 3");
    const requestsAtLeave = countOf(videos, "b2.mp4");

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 2");
    const nav = await navRecord(page);
    expect(nav.reuse).toBe("prepared");
    expect(nav.ready).toBe(true);
    // No network work for the step back: the cache entry is still inside the
    // horizon and its element is reused in place.
    expect(countOf(videos, "b2.mp4")).toBe(requestsAtLeave);
  });

  test("closing the viewer cancels in-flight video preparation", async ({
    page,
  }) => {
    trackHost(page, "i.redd.it", 0);
    const videos = trackHost(page, "preview.redd.it", 2500);
    await openFeed(
      page,
      `${imagePost("c1", "Post 1")}${videoPost("c2", "Clip 2")}`,
    );
    await expect
      .poll(() => countOf(videos, "c2.mp4"), { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(page.locator("#redditp-presentation")).toBeHidden();
    // The in-flight job was canceled and released, not left to finish into
    // the cache of a closed viewer.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ canceled: 1 }));
    // No second attempt sneaks in behind the closed viewer.
    await page.waitForTimeout(500);
    expect(countOf(videos, "c2.mp4")).toBeLessThanOrEqual(1);
  });

  test("image loading stays responsive while video preparation is active", async ({
    page,
  }) => {
    // Concurrency 2: the video holds one slot for ~2s while images flow at
    // 500ms each. Images must keep completing on schedule — video
    // preparation may not serialize the image pipeline behind it.
    const images = trackHost(page, "i.redd.it", 500);
    const videos = trackHost(page, "preview.redd.it", 2000);
    await openFeed(
      page,
      `${imagePost("r1", "Post 1")}${videoPost("r2", "Clip 2")}${imagePost(
        "r3",
        "Post 3",
      )}${imagePost("r4", "Post 4")}`,
      { settings: { preloadConcurrency: 2, preloadPosts: 3 } },
    );
    const openedAt = Date.now();
    // The speculative image loads (r3, r4) both complete within ~1.5s of
    // open, even though the video fetch only finishes at ~2s: images ran
    // concurrently with, and finished before, the video preparation.
    await expect
      .poll(
        () =>
          images.requests.filter(
            ({ url, fulfilledAt }) =>
              (url.includes("r3") || url.includes("r4")) &&
              fulfilledAt <= openedAt + 1500,
          ).length,
        { timeout: 10000 },
      )
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => countOf(videos, "r2.mp4"), { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
    // The video finished late (its 2s route delay): wait until its response
    // actually completed before comparing against the image completions.
    await expect
      .poll(
        () =>
          videos.requests[0].fulfilledAt - videos.requests[0].startedAt >=
          1500,
        { timeout: 15000 },
      )
      .toBe(true);
    const videoDone = videos.requests[0].fulfilledAt;
    for (const image of images.requests) {
      if (image.url.includes("r3") || image.url.includes("r4")) {
        expect(image.fulfilledAt, `${image.url} beats the video`).toBeLessThan(
          videoDone,
        );
      }
    }
  });
});
