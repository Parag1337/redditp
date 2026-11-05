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
const pageBridgeScript = path.resolve(
  __dirname,
  "../../browser-extension/page-bridge.js",
);

const feedUrl = "https://www.reddit.com/r/pics/?redditp=mediamode";
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

// Old-Reddit style cards: data-url drives media extraction, data-fullname or
// the permalink pair gives each post a stable identity that the mode filter
// must preserve while filtering.
const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}/DASH_480.mp4" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const redgifsPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://www.redgifs.com/watch/${id}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// Gallery cards resolve through the post JSON endpoint, which supports four
// images and two videos laid out in one interleaved gallery.
const galleryCard = `
  <shreddit-post id="t3_${"mix"}" post-title="Mixed gallery post" post-type="gallery" content-href="https://www.reddit.com/gallery/mix" permalink="https://www.reddit.com/r/pics/comments/mix/post/" subreddit-prefixed-name="r/pics"></shreddit-post>`;

const galleryJson = {
  title: "Mixed gallery post",
  post_hint: "gallery",
  is_gallery: true,
  url: "https://www.reddit.com/gallery/mix",
  gallery_data: {
    items: [
      { media_id: "img1" },
      { media_id: "vid1" },
      { media_id: "img2" },
      { media_id: "vid2" },
      { media_id: "img3" },
      { media_id: "img4" },
    ],
  },
  media_metadata: {
    img1: {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: "https://preview.redd.it/mix-img1.jpg?width=1080" },
      p: [],
    },
    vid1: {
      status: "valid",
      e: "AnimatedImage",
      m: "image/gif",
      s: {
        gif: "https://preview.redd.it/mix-vid1.gif",
        mp4: "https://preview.redd.it/mix-vid1.mp4?format=mp4",
      },
      p: [],
    },
    img2: {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: "https://preview.redd.it/mix-img2.jpg?width=1080" },
      p: [],
    },
    vid2: {
      status: "valid",
      e: "AnimatedImage",
      m: "image/gif",
      s: {
        gif: "https://preview.redd.it/mix-vid2.gif",
        mp4: "https://preview.redd.it/mix-vid2.mp4?format=mp4",
      },
      p: [],
    },
    img3: {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: "https://preview.redd.it/mix-img3.jpg?width=1080" },
      p: [],
    },
    img4: {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: "https://preview.redd.it/mix-img4.jpg?width=1080" },
      p: [],
    },
  },
};

const fulfillPage = (route, body) =>
  route.fulfill({ contentType: "text/html", body });

function fulfillJsonListing(route, post) {
  const listing = JSON.stringify([
    { data: { children: post ? [{ kind: "t3", data: post }] : [] } },
  ]);
  return route.fulfill({ contentType: "application/json", body: listing });
}

// Deterministic video duration knowledge, the same way the Phase 5A suite
// models it: a per-URL override of HTMLMediaElement.duration; null means
// "explicitly unknown" (NaN), which stays provisionally eligible.
async function installDurationOverrides(page, map) {
  await page.evaluate(
    (entries) => {
      const store = {};
      entries.forEach(([needle, seconds]) => {
        store[needle] = seconds;
      });
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        "duration",
      );
      const original = descriptor ? descriptor.get : null;
      Object.defineProperty(HTMLMediaElement.prototype, "duration", {
        configurable: true,
        get() {
          const url = String(this.currentSrc || this.src || "");
          for (const [needle, seconds] of Object.entries(store)) {
            if (url.indexOf(needle) !== -1) {
              if (seconds === null) return NaN;
              return seconds;
            }
          }
          return original ? original.call(this) : NaN;
        },
      });
      window.__setVideoDurations = function (needle, seconds) {
        store[needle] = seconds;
      };
    },
    Object.entries(map || {}),
  );
}

// Serves every i.redd.it / v.redd.it / preview.redd.it asset the fixtures
// reference and records what was requested, so tests can prove that media
// excluded by the active mode is never fetched.
function trackMediaHosts(page, { hostDelay = 0 } = {}) {
  const tracker = { requested: [] };
  page.route("https://i.redd.it/**", asMock);
  page.route("https://v.redd.it/**", asMock);
  page.route("https://preview.redd.it/**", asMock);
  async function asMock(route) {
    const url = route.request().url();
    tracker.requested.push(url);
    if (hostDelay)
      await new Promise((resolve) => setTimeout(resolve, hostDelay));
    if (/\.jpe?g(?:\?|$)|\.png(?:\?|$)/.test(url) && !/format=mp4/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: svgImage,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "video/webm", body: webm });
  }
  return tracker;
}

const countOf = (tracker, needle) =>
  tracker.requested.filter((url) => url.includes(needle)).length;

const statsOf = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());

const navRecordOf = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());

const waitSettled = (page, timeout = 20000) =>
  expect
    .poll(() => statsOf(page), { timeout })
    .toEqual(expect.objectContaining({ inFlight: 0 }));

async function pinAutoAdvance(page, enabled) {
  const autoButton = page.locator(".redditp__auto");
  const pressed = await autoButton.getAttribute("aria-pressed");
  if (pressed !== String(enabled)) await autoButton.click();
  await expect(autoButton).toHaveAttribute("aria-pressed", String(enabled));
}

async function openFeed(page, body, setup, seed) {
  await page.route(feedUrl, (route) =>
    fulfillPage(route, `<html><body>${body}</body></html>`),
  );
  await page.goto(feedUrl);
  await page.evaluate(() => localStorage.setItem("redditpDebug", "1"));
  // Starts every test from the shipped default unless a seed is given (for
  // persisted timed slideshows); also proves no old settings leak in.
  await page.evaluate((seedValue) => {
    localStorage.removeItem("redditpPresentationSettings");
    if (seedValue) {
      localStorage.setItem(
        "redditpPresentationSettings",
        JSON.stringify(seedValue),
      );
    }
  }, seed || null);
  if (setup) await setup(page);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await pinAutoAdvance(page, false);
}

// Simulates a new extension instance the way the shipped extension is
// exercised in the main suite: content.js runs again in the same page, the
// second instance retires the first overlay, and storage is read again.
// Reopens the viewer the way a fresh extension activation does: a new page
// load clears the window marker, storage is read again by a fresh instance.
// extraSetup (e.g. storage corruption) runs while the page is closed.
async function reopenViewer(page, extraSetup) {
  if (extraSetup) await extraSetup(page);
  await page.goto(feedUrl);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
  await pinAutoAdvance(page, false);
}

const modeOf = (page) =>
  page.getAttribute(".redditp__media-mode", "data-media-mode");

async function cycleTo(page, wanted) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await modeOf(page)) === wanted) return;
    await page.locator(".redditp__media-mode").click();
  }
  throw new Error(`could not reach media mode ${wanted}`);
}

test.describe("media mode control", () => {
  test.setTimeout(90000);

  test("defaults to both and cycles both → images → videos → both", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("m1", "Image 1")}${videoPost("m2", "Short clip")}${imagePost(
        "m3",
        "Image 3",
      )}`,
      (feedPage) => installDurationOverrides(feedPage, { "/m2/": 30 }),
    );
    await waitSettled(page);

    expect(await modeOf(page)).toBe("both");
    await expect(page.locator(".redditp__number")).toHaveCount(3);
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "aria-label",
      "Show images and videos",
    );

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "images",
    );
    // The video post loses its number; the image numbering stays in order.
    await expect(page.locator(".redditp__number")).toHaveCount(2);
    // Navigating skips the video-only post entirely.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 2");

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "videos",
    );
    // Image 3 is now ineligible: the viewer lands deterministically on the
    // next eligible slide (only the video remains).
    await expect(page.locator(".redditp__title")).toHaveText("Short clip");
    await expect(page.locator(".redditp__number")).toHaveCount(1);

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "both",
    );
    // The current slide (the video) stays valid in both mode and was not
    // restarted or re-fetched: the count reflects the restored feed.
    await expect(page.locator(".redditp__count")).toHaveText("2 / 3");
  });

  test("the selected mode persists after reopening and invalid values fall back to both", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("p1", "Image 1")}${videoPost("p2", "Clip")}`,
    );
    await waitSettled(page);

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "images",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(
            localStorage.getItem("redditpPresentationSettings") || "{}",
          ),
        ),
      )
      .toEqual(expect.objectContaining({ mediaMode: "images" }));

    await reopenViewer(page);
    await waitSettled(page);
    expect(await modeOf(page)).toBe("images");

    // An outdated/corrupt stored value must not strand the viewer.
    await reopenViewer(page, (setupPage) =>
      setupPage.evaluate(() => {
        const stored = JSON.parse(
          localStorage.getItem("redditpPresentationSettings") || "{}",
        );
        stored.mediaMode = "audio-only";
        localStorage.setItem(
          "redditpPresentationSettings",
          JSON.stringify(stored),
        );
      }),
    );
    await waitSettled(page);
    expect(await modeOf(page)).toBe("both");
  });

  test("videos mode skips image-only posts and numbered navigation follows the filter", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("n1", "Image 1")}${videoPost("n2", "Clip A")}${imagePost(
        "n3",
        "Image 3",
      )}${videoPost("n4", "Clip B")}`,
    );
    await waitSettled(page);
    await cycleTo(page, "videos");

    await expect(page.locator(".redditp__title")).toHaveText("Clip A");
    await expect(page.locator(".redditp__number")).toHaveCount(2);
    await page.locator(".redditp__number").nth(1).click();
    await expect(page.locator(".redditp__title")).toHaveText("Clip B");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 2");

    // Going back lands on the first video, not the images before it.
    await page.locator(".redditp__number").nth(0).click();
    await expect(page.locator(".redditp__title")).toHaveText("Clip A");

    // Previous navigation from the first video stays within the mode.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Clip A");
  });

  test("mixed gallery exposes filtered slides in order with visible-slide counters", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const postUrl = "https://www.reddit.com/r/pics/comments/mix/post/";
    await page.route(postUrl, (route) =>
      fulfillPage(route, `<html><body class="shell"></body></html>`),
    );
    await page.route(`${postUrl}.json`, (route) =>
      fulfillJsonListing(route, galleryJson),
    );
    await openFeed(page, galleryCard);
    await waitSettled(page);

    // Both mode: all six slides, original order, the gallery's own numbering.
    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
    for (let step = 0; step < 6; step += 1) {
      const expected = [
        ["mix-img1.jpg", "(1/6)"],
        ["mix-vid1", "(2/6)"],
        ["mix-img2", "(3/6)"],
        ["mix-vid2", "(4/6)"],
        ["mix-img3", "(5/6)"],
        ["mix-img4", "(6/6)"],
      ][step];
      await expect(page.locator(".redditp__title")).toContainText(expected[1]);
      if (step < 5) {
        await page.keyboard.press("ArrowRight");
      }
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector(
              "#redditp-presentation .redditp__media img, #redditp-presentation .redditp__media video",
            )?.currentSrc || document.querySelector("#redditp-presentation .redditp__media img, #redditp-presentation .redditp__media video")?.src || "",
        ),
      )
      .toContain("mix-img4");

    await cycleTo(page, "images");
    // The current slide (image 4) is still eligible; only its counter now
    // describes the four visible image slides.
    await expect(page.locator(".redditp__title")).toContainText("(4/4)");
    // Videos of the gallery can no longer be reached.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toContainText("(3/4");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toContainText("(2/4");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toContainText("(1/4");
    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");

    await cycleTo(page, "videos");
    // The re-land targets the gallery's first visible video, which is
    // position 1 of the two videos the mode keeps.
    await expect(page.locator(".redditp__title")).toContainText("(1/2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toContainText("(2/2");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toContainText("(1/2");
  });

  test("the 60-second duration boundary stays intact in every mode", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${videoPost("s60", "Clip 60")}${videoPost("s75", "Clip 75")}${imagePost(
        "s80",
        "Image 80",
      )}`,
      (feedPage) =>
        installDurationOverrides(feedPage, {
          "/s60/": 60,
          "/s75/": 75,
        }),
    );
    await waitSettled(page);

    await cycleTo(page, "videos");
    // 60s is eligible and stays the landing slide; 75s is excluded by the
    // duration policy, and Image 80 is excluded by the mode itself, so
    // navigation from the last video is bounded and stays put (never hangs).
    await expect(page.locator(".redditp__title")).toHaveText("Clip 60");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 60");
    await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
    await expect(page.locator(".redditp__number")).toHaveCount(2);

    await cycleTo(page, "images");
    // Forward-first re-landing: the next eligible image is Image 80.
    await expect(page.locator(".redditp__title")).toHaveText("Image 80");
    await expect(page.locator(".redditp__number")).toHaveCount(1);

    await cycleTo(page, "both");
    // Numbering keeps feed semantics: the 75s clip has its number back.
    await expect(page.locator(".redditp__number")).toHaveCount(3);
    await page.locator(".redditp__number").nth(0).click();
    await expect(page.locator(".redditp__title")).toHaveText("Clip 60");
    // The 75s post is skipped as a whole in either mode.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 80");
    // Whether or not the mode filter explains them, long known videos are
    // still excluded by the duration policy in every mode.
    await page.locator(".redditp__number").nth(0).click();
    await expect(page.locator(".redditp__title")).toHaveText("Clip 60");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 80");
  });

  test("an unknown video duration does not hang navigation in any mode", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("u1", "Image 1")}${videoPost("u2", "Unknown clip")}${imagePost(
        "u3",
        "Image 3",
      )}`,
      (feedPage) => installDurationOverrides(feedPage, { "/u2/": null }),
    );
    await waitSettled(page);
    await cycleTo(page, "videos");
    // Only the unknown clip is mode-eligible here; the unknown duration
    // remains provisionally eligible... the other two posts are images,
    // excluded by the mode, so their count is not shown as reachable.
    await expect(page.locator(".redditp__title")).toHaveText("Unknown clip");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Unknown clip");
    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
    await page.keyboard.press("ArrowLeft");
    // The unknown-duration clip remains provisionally eligible, so going
    // back re-enters it instead of skipping over all videos forever.
    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
    const title = page.locator(".redditp__title");
    await expect(title).toHaveText("Unknown clip");
    // ...and the images remain reachable as soon as the mode allows.
    await cycleTo(page, "both");
    await expect(title).toHaveText("Unknown clip");
    await page.keyboard.press("ArrowRight");
    await expect(title).toHaveText("Image 3");
  });

  test("slideshow advances only through slides the mode allows", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("a1", "Image 1")}${videoPost("a2", "Clip A")}${imagePost(
        "a3",
        "Image 3",
      )}${videoPost("a4", "Clip B")}${imagePost("a5", "Image 5")}`,
      (feedPage) => installDurationOverrides(feedPage, { "/a[24]/": 30 }),
      { slideDurationSeconds: 1, autoAdvance: false },
    );
    await waitSettled(page);
    await cycleTo(page, "images");
    await pinAutoAdvance(page, true);
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");

    // Sample the titles the slideshow shows: only image titles may appear.
    const seen = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const titles = new Set();
          const stop = setInterval(() => {
            titles.add(document.querySelector(".redditp__title").textContent);
            if (titles.size >= 3) {
              clearInterval(stop);
              resolve(Array.from(titles));
            }
          }, 250);
          // A hard stop so a broken filter cannot spin the test for minutes.
          setTimeout(() => {
            clearInterval(stop);
            resolve(Array.from(titles));
          }, 12500);
        }),
    );
    expect(seen).toEqual(["Image 1", "Image 3", "Image 5"]);
  });

  test("no eligible media shows the explicit no-match state and stops navigation", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("e1", "Image 1")}${imagePost("e2", "Image 2")}`,
    );
    await waitSettled(page);
    await cycleTo(page, "videos");

    await expect(page.locator(".redditp__empty")).toBeVisible();
    await expect(page.locator(".redditp__empty h2")).toHaveText(
      "No videos match the media filter",
    );
    // The row survives with only the mode chip: it is the way back.
    await expect(page.locator(".redditp__controls")).toBeVisible();
    await expect(page.locator(".redditp__count")).toBeHidden();
    await expect(page.locator(".redditp__auto")).toBeHidden();
    await expect(page.locator(".redditp__media video")).toHaveCount(0);
    await expect(page.locator(".redditp__media img")).toHaveCount(0);
    // Navigation keys change nothing while nothing is eligible.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__empty")).toBeVisible();

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__empty")).toBeHidden();
    await expect(page.locator(".redditp__controls")).toBeVisible();
  });

  test("mode changes while the slideshow runs keep a single advancement timer", async ({
    page,
  }) => {
    trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("t1", "Image 1")}${videoPost("t2", "Clip 3")}${imagePost(
        "t3",
        "Image 3",
      )}${imagePost("t4", "Image 4")}`,
      (feedPage) => installDurationOverrides(feedPage, { "/t2/": 30 }),
      { slideDurationSeconds: 1, autoAdvance: false },
    );
    await waitSettled(page);
    // Slideshow starts on the first (eligible) slide, and the mode change
    // happens while its timer is live.
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await pinAutoAdvance(page, true);
    // Start the in-page sampler first; it records the click and the
    // subsequent advances. Resolved below after the sampler window closes.
    const samplesPromise = page.evaluate(
      () =>
        new Promise((resolve) => {
          const changes = [];
          let last = document.querySelector(".redditp__title").textContent;
          const started = performance.now();
          const timer = setInterval(() => {
            const current =
              document.querySelector(".redditp__title").textContent;
            if (current !== last) {
              changes.push({ text: current, at: performance.now() - started });
              last = current;
            }
          }, 50);
          document.querySelector(".redditp__media-mode").addEventListener(
            "click",
            () => {
              changes.push({
                text: "MODE-CLICK",
                at: performance.now() - started,
              });
            },
            { once: true },
          );
          setTimeout(() => {
            clearInterval(timer);
            resolve({ changes });
          }, 4500);
        }),
    );
    await cycleTo(page, "images");
    const samples = await samplesPromise;
    const clickIndex = samples.changes.findIndex(
      ({ text }) => text === "MODE-CLICK",
    );
    expect(clickIndex).toBeGreaterThanOrEqual(0);
    const after = samples.changes.slice(clickIndex + 1);
    // The slideshow keeps advancing behind the mode change...
    expect(after.length).toBeGreaterThanOrEqual(2);
    // ...with each advance on the one-second cadence; a duplicated timer
    // would fire an immediate second change inside the period.
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i].at - after[i - 1].at).toBeGreaterThan(700);
    }
  });

  test("mobile-sized viewport keeps the mode control reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    trackMediaHosts(page);
    await openFeed(page, `${imagePost("z1", "Image 1")}`);
    await waitSettled(page);
    const box = await page.locator(".redditp__media-mode").boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
  });
});

test.describe("media mode — preloading and cache behavior", () => {
  test.setTimeout(90000);

  test("excluded media is not preloaded, eligible media keeps its preparation", async ({
    page,
  }) => {
    const tracker = trackMediaHosts(page);
    await openFeed(
      page,
      `${imagePost("y1", "Image 1")}${videoPost("y2", "Clip 2")}${imagePost(
        "y3",
        "Image 3",
      )}`,
      (feedPage) => installDurationOverrides(feedPage, { "/y2/": 30 }),
    );
    await waitSettled(page);
    // In both mode the upcoming video is prepared like any other.
    await cycleTo(page, "videos");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 2");
    expect(countOf(tracker, "/y2/")).toBeGreaterThanOrEqual(1);
    const requestedInVideos = countOf(tracker, "/y2/");

    await cycleTo(page, "images");
    // The re-land after a mode change is deterministic (forward first):
    // from Clip 2 the next eligible slide in an images run is Image 3.
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    await page.evaluate(() => window.__redditpPresentation.debug.refresh());
    await page.waitForTimeout(600);
    // Videos-mode-eligible media is not fetched for an images pass.
    expect(countOf(tracker, "/y2/")).toBe(requestedInVideos);

    await cycleTo(page, "videos");
    // The cache survived the mode change: the prepared video is reused
    // instead of requested again.
    expect(countOf(tracker, "/y2/")).toBe(requestedInVideos);
  });
});
