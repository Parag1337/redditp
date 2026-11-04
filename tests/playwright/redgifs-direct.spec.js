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

const feedUrl = "https://www.reddit.com/r/nsfw/?redditp=redgifs";
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/nsfw/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const redgifsPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://www.redgifs.com/watch/${id}" data-permalink="/r/nsfw/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// A RedGIFs post whose resolved media id is named independently of the post
// id, so fixtures can key the API by the media id (the watch path segment)
// while posts stay distinct.
const redgifsPostNamed = (postId, mediaId, title) =>
  `<div class="thing link" data-fullname="t3_${postId}" data-url="https://www.redgifs.com/watch/${mediaId}" data-permalink="/r/nsfw/comments/${postId}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// Intercepts the RedGIFs API, media host, and embed pages. `media[id]` maps
// a media id to { duration } or null (unknown -> 404); the trackers prove
// exactly what was requested.
function installRedgifsFixtures(page, media) {
  const tracker = { api: [], mediaBytes: [], embeds: [] };
  page.route("https://i.redd.it/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svgImage,
    });
  });
  page.route("https://api.redgifs.com/v2/auth/temporary", async (route) => {
    const url = route.request().url();
    tracker.api.push(url);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "fixture-token-without-meaning",
        addr: "127.0.0.1",
        agent: "fixture",
        session: "fixture",
      }),
    });
  });
  page.route("https://api.redgifs.com/v2/gifs/**", async (route) => {
    const url = route.request().url();
    tracker.api.push(url);
    const id = url.split("/").pop();
    const gif = media[id] !== null ? media[id] : null;
    if (!gif) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "GifNotFound", description: "Gif not found." },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        gif: {
          id,
          duration: gif.duration,
          hasAudio: Boolean(gif.hasAudio),
          type: 1,
          urls: {
            html: `https://www.redgifs.com/ifr/${id}`,
            hd: `https://media.redgifs.com/${id}-hd.mp4`,
            sd: `https://media.redgifs.com/${id}-sd.mp4`,
            silent: `https://media.redgifs.com/${id}-silent.mp4`,
            poster: `https://media.redgifs.com/${id}-poster.jpg`,
          },
        },
      }),
    });
  });
  page.route("https://media.redgifs.com/**", async (route) => {
    const url = route.request().url();
    tracker.mediaBytes.push(url);
    if (/poster\.jpg$/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: svgImage,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "video/webm", body: webm });
  });
  page.route("https://www.redgifs.com/**", async (route) => {
    const url = route.request().url();
    tracker.embeds.push(url);
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>fixture player</body></html>",
    });
  });
  return tracker;
}

const apiCountFor = (tracker, needle) =>
  tracker.api.filter((url) => url.includes(needle)).length;

const statsOf = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());

const navRecordOf = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());

const waitSettled = (page, timeout = 20000) =>
  expect
    .poll(() => statsOf(page), { timeout })
    .toEqual(expect.objectContaining({ inFlight: 0 }));

const debugEvents = (page) =>
  page.evaluate(() =>
    window.__redditpPresentation.debug
      .log()
      .map(({ event, detail }) => ({ event, detail })),
  );

async function pinAutoAdvance(page, enabled) {
  const autoButton = page.locator(".redditp__auto");
  const pressed = await autoButton.getAttribute("aria-pressed");
  if (pressed !== String(enabled)) await autoButton.click();
  await expect(autoButton).toHaveAttribute("aria-pressed", String(enabled));
}

async function openFeed(page, body, setup) {
  await page.route(feedUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body>${body}</body></html>`,
    }),
  );
  await page.goto(feedUrl);
  await page.evaluate(() => {
    localStorage.setItem("redditpDebug", "1");
    localStorage.removeItem("redditpPresentationSettings");
  });
  if (setup) await setup(page);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await pinAutoAdvance(page, false);
}

test.describe("redgifs direct media", () => {
  test.setTimeout(90000);

  test("resolves metadata early, prepares the direct video, and reuses it on navigation", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      firstgif: { duration: 12.5 },
    });
    await openFeed(
      page,
      `${imagePost("g1", "Image 1")}${redgifsPostNamed(
        "g2",
        "firstgif",
        "RedGIFs clip",
      )}${imagePost("g3", "Image 3")}`,
    );
    await waitSettled(page);

    // One auth token, one metadata resolution for the upcoming post.
    expect(tracker.api.filter((url) => url.endsWith("temporary")).length).toBe(
      1,
    );
    expect(apiCountFor(tracker, "firstgif")).toBe(1);
    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsPrepared: 1 }));

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    await expect(page.locator(".redditp__video")).toHaveAttribute(
      "src",
      "https://media.redgifs.com/firstgif-hd.mp4",
    );
    const nav = await navRecordOf(page);
    expect(nav.reuse).toBe("prepared");
    expect(nav.ready).toBe(true);
    // Prepared means no new metadata request on navigation and no second
    // download of the media.
    expect(apiCountFor(tracker, "firstgif")).toBe(1);
    expect(
      tracker.mediaBytes.filter((url) => url.includes("firstgif-hd")).length,
    ).toBe(1);
    expect(await page.locator(".redditp__embed").count()).toBe(0);

    // Revisiting does not re-resolve or re-request anything.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    expect(apiCountFor(tracker, "firstgif")).toBe(1);
    expect(
      tracker.mediaBytes.filter((url) => url.includes("firstgif-hd")).length,
    ).toBe(1);
  });

  test("posts sharing one media id share one in-flight resolution", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      dupegif: { duration: 8 },
    });
    await openFeed(
      page,
      `${redgifsPostNamed("dup1", "dupegif", "First dupe")}${redgifsPostNamed(
        "dup2",
        "dupegif",
        "Second dupe",
      )}`,
    );
    await waitSettled(page);

    expect(apiCountFor(tracker, "dupegif")).toBe(1);
    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsPrepared: 2 }));
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    // Both posts display the same resolved media from one resolution.
    expect(apiCountFor(tracker, "dupegif")).toBe(1);
  });

  test("known-long RedGIFs media keeps the duration policy and stays on the embed player", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      longgif: { duration: 90 },
    });
    await openFeed(
      page,
      `${imagePost("l1", "Image 1")}${redgifsPostNamed(
        "l2",
        "longgif",
        "Long clip",
      )}${imagePost("l3", "Image 3")}`,
    );
    await waitSettled(page);

    // Resolved once (diagnosable), never upgraded, and skipped as a whole
    // post by the same duration rule the Reddit videos obey.
    expect(apiCountFor(tracker, "longgif")).toBe(1);
    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsPrepared: 0 }));
    const events = await debugEvents(page);
    expect(
      events.some(
        ({ event }) =>
          event === "redgifs-long-video" || event === "navigation-skipped-long",
      ),
    ).toBe(true);
    // Numbering is feed-based (5A): the long post keeps its number, so the
    // three posts carry three buttons while navigation still skips the long
    // one as a whole post.
    await expect(page.locator(".redditp__number")).toHaveCount(3);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    expect(await page.locator(".redditp__video").count()).toBe(0);
  });

  test("a failed resolution keeps the embed fallback and stops retrying after the bound", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, { deadgif: null });
    await openFeed(
      page,
      `${redgifsPostNamed("d1", "deadgif", "Dead gif")}${imagePost(
        "d2",
        "Image 2",
      )}`,
    );
    await waitSettled(page);

    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsFailed: 1 }));
    await expect(page.locator(".redditp__embed")).toHaveCount(1);
    await expect(page.locator(".redditp__embed")).toHaveAttribute(
      "src",
      expect.stringContaining("https://www.redgifs.com/ifr/deadgif"),
    );
    // The bound: at most two metadata attempts for the id, even across
    // more navigation and renders.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => window.__redditpPresentation.debug.refresh());
    await page.waitForTimeout(500);
    expect(apiCountFor(tracker, "deadgif")).toBeLessThanOrEqual(2);
    await expect(page.locator(".redditp__embed")).toHaveCount(1);
  });

  test("an unresolvable auth token fails over to the embed and stays bounded", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      authtfail: { duration: 9 },
    });
    await page.unroute("https://api.redgifs.com/v2/auth/temporary");
    const authHits = [];
    await page.route(
      "https://api.redgifs.com/v2/auth/temporary",
      async (route) => {
        authHits.push(route.request().url());
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "Nope" } }),
        });
      },
    );
    await openFeed(
      page,
      `${redgifsPostNamed("at1", "authtfail", "Gated gif")}`,
    );
    await waitSettled(page);

    await expect(page.locator(".redditp__embed")).toHaveCount(1);
    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsPrepared: 0 }));
    // The resolution attempts remain bounded (one per scheduling pass).
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => statsOf(page))
      .toEqual(expect.objectContaining({ redgifsFailed: 2 }));
    // Two bounded failures then nothing further without user revisit.
    expect(authHits.length).toBeLessThanOrEqual(2);
  });

  test("a dead direct URL recovers through one bounded refresh, then the embed", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      rottengif: { duration: 10 },
    });
    // Fail HTTP-level so the video element fires its error event.
    await page.unroute("https://media.redgifs.com/**");
    await page.route("https://media.redgifs.com/**", async (route) => {
      if (/poster\.jpg$/.test(route.request().url())) {
        await route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: svgImage,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "gone" });
    });
    await openFeed(
      page,
      `${redgifsPostNamed("rg1", "rottengif", "Rotten gif")}`,
    );
    await waitSettled(page);

    // The embed player is the last resort standing.
    await expect(page.locator(".redditp__embed")).toHaveCount(1);
    await expect(page.locator(".redditp__embed")).toHaveAttribute(
      "src",
      expect.stringContaining("https://www.redgifs.com/ifr/rottengif"),
    );
    // Exactly one refresh metadata attempt on top of the initial one.
    expect(apiCountFor(tracker, "rottengif")).toBe(2);
    // Falling back is sticky: revisiting does not restart the loop.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__embed")).toHaveCount(1);
    expect(apiCountFor(tracker, "rottengif")).toBe(2);
  });

  test("rapid navigation never leaves stale media or duplicate players", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      rapid1: { duration: 10 },
      rapid2: { duration: 10 },
    });
    await openFeed(
      page,
      `${redgifsPostNamed("r1", "rapid1", "Rapid 1")}${imagePost(
        "r2",
        "Image 2",
      )}${redgifsPostNamed("r3", "rapid2", "Rapid 3")}${imagePost(
        "r4",
        "Image 4",
      )}`,
    );
    await waitSettled(page);
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("ArrowRight");
    }
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("ArrowLeft");
    }
    await waitSettled(page);
    const state = await page.evaluate(() => ({
      videos: document.querySelectorAll(".redditp__video").length,
      embeds: document.querySelectorAll(".redditp__embed").length,
      images: document.querySelectorAll(".redditp__image").length,
      totalMedia: document.querySelectorAll(".redditp__media > *").length,
    }));
    expect(state.totalMedia).toBeLessThanOrEqual(1);
    expect(state.videos).toBeLessThanOrEqual(1);
    expect(apiCountFor(tracker, "rapid1")).toBeLessThanOrEqual(2);
    expect(apiCountFor(tracker, "rapid2")).toBeLessThanOrEqual(2);
  });

  test("media mode gating keeps the resolver out of images-only runs", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      modegif: { duration: 10 },
    });
    await openFeed(
      page,
      `${redgifsPostNamed("md1", "modegif", "Mode gif")}${imagePost(
        "md2",
        "Image 2",
      )}`,
    );
    await waitSettled(page);
    const metadataInBoth = apiCountFor(tracker, "modegif");
    expect(metadataInBoth).toBeGreaterThanOrEqual(1);

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "images",
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 2");
    await page.evaluate(() => window.__redditpPresentation.debug.refresh());
    await page.waitForTimeout(400);
    // No additional resolution attempt, and no embed player for excluded media.
    expect(apiCountFor(tracker, "modegif")).toBe(metadataInBoth);

    await page.locator(".redditp__media-mode").click();
    await expect(page.locator(".redditp__media-mode")).toHaveAttribute(
      "data-media-mode",
      "videos",
    );
    // Back to a video-friendly mode, the resolved media is reused.
    await expect(page.locator(".redditp__video")).toHaveCount(1);
  });

  test("a hidden tab suspends speculative resolution until it returns", async ({
    page,
  }) => {
    const tracker = installRedgifsFixtures(page, {
      hiddengif: { duration: 9 },
    });
    await openFeed(
      page,
      `${imagePost("h1", "Image 1")}${redgifsPostNamed(
        "h2",
        "hiddengif",
        "Hidden gif",
      )}`,
    );

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
    });
    await expect
      .poll(() => statsOf(page), { timeout: 5000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));
    const metadataWhileHidden = apiCountFor(tracker, "hiddengif");
    await page.waitForTimeout(300);
    expect(apiCountFor(tracker, "hiddengif")).toBe(metadataWhileHidden);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    expect(apiCountFor(tracker, "hiddengif")).toBeGreaterThanOrEqual(1);
  });
});
