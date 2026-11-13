// Phase 8 — gallery correctness + scheduler fairness. These tests pin:
//
//   1. a lazy gallery card (one rendered figure, unknown total) resolves
//      its complete item list through the JSON endpoint first, keeps the
//      gallery order, never duplicates items or requests, and never reads
//      as a false "(1/1)"; an inconclusive HTML answer settles honestly as
//      "(1/?)" without a refetch loop,
//   2. gallery videos (direct MP4 renditions of animated posts, hosted
//      clips, RedGIFs upgrades) are preloaded inside a rolling gallery
//      window that scales with spare capacity and stays bounded for large
//      galleries, with the following post's media still queued behind,
//   3. DASH preparation is accounted after attach: bridge stage events
//      (manifest / segments / ready) are tracked, the job stays in flight
//      until real stream data (or a bounded wait), and release clears the
//      activity on teardown,
//   4. the video budget cannot block a queued video forever (stall
//      override), and
//   5. media displayed cold joins the cache, so a step back (and a close +
//      reopen) reuses it instead of refetching.
//
// Everything runs against the injected content script with routed
// responses; debug assertions read the production localStorage.redditpDebug
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
const pageBridgeScript = path.resolve(
  __dirname,
  "../../browser-extension/page-bridge.js",
);
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);

const listingUrl = "https://www.reddit.com/r/pics/?redditp=phase8";
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<shreddit-post id="t3_${id}" post-title="${title}" content-href="https://i.redd.it/${id}.jpg" permalink="/r/pics/comments/${id}/post/"><img src="https://i.redd.it/${id}.jpg"></shreddit-post>`;

// A lazy modern gallery card: the post is marked as a gallery but the
// carousel rendered only its first figure — the situation the enrichment
// path exists for.
const lazyGalleryPost = (id, title, firstImage) =>
  `<shreddit-post id="t3_${id}" post-title="${title}" gallery content-href="https://i.redd.it/${firstImage}" permalink="/r/pics/comments/${id}/post/"><gallery-carousel><figure><img src="https://i.redd.it/${firstImage}"></figure></gallery-carousel></shreddit-post>`;

// A fully rendered modern gallery carousel: every figure is in the DOM, so
// the scan yields the complete item list immediately — no enrichment race.
// A shreddit-player figure is the gallery's video item.
const renderedGalleryPost = (id, title, figures) =>
  `<shreddit-post id="t3_${id}" post-title="${title}" gallery content-href="https://i.redd.it/${figures[0].file}.jpg" permalink="/r/pics/comments/${id}/post/"><gallery-carousel>${figures
    .map((figure) =>
      figure.type === "video"
        ? `<figure><shreddit-player src="https://i.redd.it/${figure.file}.mp4"></shreddit-player></figure>`
        : `<figure><img src="https://i.redd.it/${figure.file}.jpg"></figure>`,
    )
    .join("")}</gallery-carousel></shreddit-post>`;

const oldRedditDashPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}" data-permalink="/r/videos/comments/${id}/clip/" data-author="fan" data-subreddit="videos"><a class="title">${title}</a><div class="portrait" data-hls-url="https://v.redd.it/${id}/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/${id}/DASHPlaylist.mpd?a=1" data-seek-preview-url="https://v.redd.it/${id}/DASH_96.mp4"></div></div>`;

// Reddit post JSON: one gallery with the given media ids, resolved through
// media_metadata in gallery_data order.
function galleryJson(mediaEntries) {
  const mediaIds = mediaEntries.map((entry) => entry.id);
  const metadata = {};
  for (const entry of mediaEntries) {
    metadata[entry.id] =
      entry.type === "video"
        ? {
            status: "valid",
            e: "AnimatedImage",
            s: { mp4: `https://i.redd.it/${entry.file}.mp4` },
          }
        : {
            status: "valid",
            e: "Image",
            s: { u: `https://i.redd.it/${entry.file}.jpg` },
          };
  }
  return [
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              title: "Gallery",
              url: "https://www.reddit.com/gallery/gal",
              gallery_data: {
                items: mediaIds.map((media_id) => ({ media_id })),
              },
              media_metadata: metadata,
            },
          },
        ],
      },
    },
  ];
}

function trackMediaHost(page, host, delayMs = 0) {
  const requests = [];
  page.route(`https://${host}/**`, async (route) => {
    const url = route.request().url();
    requests.push({ url, startedAt: Date.now() });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (/\.mp4(?:$|\?)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: { "cache-control": "no-store" },
        body: webm,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "cache-control": "no-store" },
      body: svgImage,
    });
  });
  return requests;
}

const countOf = (requests, needle) =>
  requests.filter(({ url }) => url.includes(needle)).length;

const stats = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());

const debugEvents = (page) =>
  page.evaluate(() =>
    window.__redditpPresentation.debug
      .log()
      .map(({ event, detail }) => ({ event, detail })),
  );

const cacheKeys = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.cache());

const navRecord = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());

async function openFeed(
  page,
  body,
  { settings = {}, durations = {}, before } = {},
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
  // Page-world installs (dash.js stub + bridge) must happen on THIS document
  // and before content.js opens the viewer, so the first scheduler pass sees
  // the same bridge the display path will.
  if (before) await before();
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
}

// dash.js stub that answers the bridge handshake through the REAL
// page-bridge.js: player.on() registers the bridge's stage listeners and
// initialize() fires MANIFEST_LOADED / STREAM_INITIALIZED / CAN_PLAY at
// controlled delays, then fakes the element's metadata/data events so the
// preparation can settle.
async function installStageDashStub(page, delays) {
  await page.evaluate((t) => {
    window.__dashCalls = [];
    window.__dashResets = 0;
    const MediaPlayer = () => ({
      create() {
        const handlers = {};
        return {
          on(type, handler) {
            handlers[type] = handler;
          },
          initialize(video, url) {
            window.__dashCalls.push({ url });
            setTimeout(() => handlers.manifestLoaded?.(), t.manifest);
            setTimeout(() => handlers.streamInitialized?.(), t.segments);
            setTimeout(() => {
              handlers.canPlay?.();
              video.dispatchEvent(new Event("loadedmetadata"));
            }, t.ready);
            setTimeout(
              () => video.dispatchEvent(new Event("loadeddata")),
              t.data,
            );
          },
          reset() {
            window.__dashResets += 1;
          },
        };
      },
    });
    MediaPlayer.events = {
      ERROR: "error",
      MANIFEST_LOADED: "manifestLoaded",
      STREAM_INITIALIZED: "streamInitialized",
      CAN_PLAY: "canPlay",
    };
    window.dashjs = { MediaPlayer };
  }, delays);
  await page.addScriptTag({ path: pageBridgeScript });
}

test.describe("phase 8 gallery correctness and scheduler fairness", () => {
  test.setTimeout(90000);

  test("a lazy gallery resolves its full item list through JSON, in order, without duplicate fetches", async ({
    page,
  }) => {
    trackMediaHost(page, "i.redd.it");
    const jsonFetches = [];
    const htmlFetches = [];
    // Registered first, so the specific .json route below (registered last
    // wins in Playwright) keeps the JSON endpoint from being answered by
    // the HTML detail handler.
    await page.route(
      "https://www.reddit.com/r/pics/comments/lazyg/post/*",
      async (route) => {
        if (route.request().url().endsWith(".json")) return route.fallback();
        htmlFetches.push(route.request().url());
        await route.fulfill({ contentType: "text/html", body: "<html></html>" });
      },
    );
    await page.route(
      "https://www.reddit.com/r/pics/comments/lazyg/post/.json*",
      async (route) => {
        jsonFetches.push(route.request().url());
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            galleryJson([
              { id: "m1", file: "ga1" },
              { id: "m2", file: "ga2", type: "video" },
              { id: "m3", file: "ga3" },
            ]),
          ),
        });
      },
    );

    await openFeed(
      page,
      `${lazyGalleryPost("lazyg", "Lazy gallery", "ga1.jpg")}${imagePost(
        "na1",
        "Next post",
      )}`,
    );

    // The unknown count never reads as a complete gallery, and the JSON
    // answer (authoritative at any count) replaces the card with all three
    // items in gallery_data order.
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/3) Lazy gallery",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText(
      "(2/3) Lazy gallery",
    );
    await expect(page.locator(".redditp__video")).toHaveAttribute(
      "src",
      "https://i.redd.it/ga2.mp4",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText(
      "(3/3) Lazy gallery",
    );
    await expect(page.locator(".redditp__image")).toHaveAttribute(
      "src",
      "https://i.redd.it/ga3.jpg",
    );

    // One JSON fetch resolved everything; the HTML detail was never spent.
    expect(jsonFetches.length).toBe(1);
    expect(htmlFetches.length).toBe(0);
  });

  test("repeated media ids in gallery_data collapse into one slide", async ({
    page,
  }) => {
    trackMediaHost(page, "i.redd.it");
    const media = trackMediaHost(page, "i.redd.it");
    await page.route(
      "https://www.reddit.com/r/pics/comments/dupg/post/.json*",
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            galleryJson([
              { id: "m1", file: "dupe1" },
              { id: "m2", file: "dupe2" },
              // Same media id as m1: one item must stay one slide.
              { id: "m1", file: "dupe1" },
            ]),
          ),
        }),
    );
    await openFeed(
      page,
      lazyGalleryPost("dupg", "Dup gallery", "dupe1.jpg"),
    );
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/2) Dup gallery",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText(
      "(2/2) Dup gallery",
    );
    // The repeated id must not create a third slide or a third fetch: at
    // most the card's own cold thumb plus the resolved first item (which
    // can be two loads of the same URL when the thumb is replaced
    // mid-flight), and exactly one load of the second item.
    expect(countOf(media, "dupe1.jpg")).toBeLessThanOrEqual(2);
    expect(countOf(media, "dupe2.jpg")).toBeLessThanOrEqual(1);
  });

  test("an inconclusive HTML detail settles as an unknown count instead of looping", async ({
    page,
  }) => {
    trackMediaHost(page, "i.redd.it");
    let jsonFetches = 0;
    let htmlFetches = 0;
    await page.route(
      "https://www.reddit.com/r/pics/comments/stuckg/post/*",
      async (route) => {
        if (route.request().url().endsWith(".json")) return route.fallback();
        htmlFetches += 1;
        // The detail page is exactly as lazy as the card was: one figure.
        await route.fulfill({
          contentType: "text/html",
          body: `<shreddit-post id="t3_stuckg" post-title="Stuck gallery" gallery permalink="/r/pics/comments/stuckg/post/"><gallery-carousel><figure><img src="https://i.redd.it/stuck1.jpg"></figure></gallery-carousel></shreddit-post>`,
        });
      },
    );
    await page.route(
      "https://www.reddit.com/r/pics/comments/stuckg/post/.json*",
      async (route) => {
        jsonFetches += 1;
        await route.fulfill({ status: 403, contentType: "text/html", body: "" });
      },
    );

    await openFeed(page, lazyGalleryPost("stuckg", "Stuck gallery", "stuck1.jpg"));

    // The count stays honestly unknown, the single rendered item displays,
    // and the bounded attempt never turns into a refetch loop.
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/?) Stuck gallery",
    );
    await expect(page.locator(".redditp__image")).toHaveAttribute(
      "src",
      "https://i.redd.it/stuck1.jpg",
    );
    await page.waitForTimeout(1200);
    expect(jsonFetches).toBe(2);
    expect(htmlFetches).toBe(1);
  });

  test("gallery videos are preloaded in window order and stay at metadata depth until display", async ({
    page,
  }) => {
    const media = trackMediaHost(page, "i.redd.it");
    // Fully rendered carousel: the scheduler's first pass sees the complete
    // gallery, so gallery items and the following post compete in one pass
    // with deterministic priorities.
    await openFeed(
      page,
      `${renderedGalleryPost("mixg", "Mixed gallery", [
        { file: "mg1" },
        { file: "mg2" },
        { file: "mg3", type: "video" },
      ])}${imagePost("mb1", "Next post")}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/3) Mixed gallery",
    );

    // Preload starts in priority order: the remaining gallery images first,
    // then the gallery's video, then the following post's media — the
    // gallery window keeps its items ahead of the next post at equal
    // closeness.
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).filter(
            ({ event, detail }) =>
              event === "preload-start" &&
              String(detail).includes("mb1.jpg"),
          ).length,
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    const started = (await debugEvents(page))
      .filter(({ event }) => event === "preload-start")
      .map(({ detail }) => String(detail));
    const mg2 = started.findIndex((key) => key.includes("mg2.jpg"));
    const mg3 = started.findIndex((key) => key.includes("mg3.mp4"));
    const mb1 = started.findIndex((key) => key.includes("mb1.jpg"));
    expect(mg2).toBeGreaterThanOrEqual(0);
    expect(mg3).toBeGreaterThan(mg2);
    expect(mb1).toBeGreaterThan(mg3);

    // The gallery video reached metadata depth before navigation.
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).some(
            ({ event, detail }) =>
              event === "preload-loaded" &&
              detail?.media === "metadata" &&
              String(detail.key).includes("mg3.mp4"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);

    // Displaying it joins the prepared element: no second request, and the
    // near gallery video even reached first-frame depth (gallery priorities
    // sit under the immediate-first-frame ceiling).
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveAttribute(
      "src",
      "https://i.redd.it/mg3.mp4",
    );
    expect(countOf(media, "mg3.mp4")).toBeLessThanOrEqual(1);
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).some(
            ({ event, detail }) =>
              event === "preload-firstframe" &&
              String(detail.key).includes("mg3.mp4"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  });

  test("a further direct video stays at metadata depth and stops its network work", async ({
    page,
  }) => {
    const videoBody = (id, title) =>
      `<shreddit-post id="t3_${id}" post-title="${title}" post-type="video" content-href="https://i.redd.it/${id}.mp4" permalink="/r/pics/comments/${id}/post/"><video src="https://i.redd.it/${id}.mp4"></video></shreddit-post>`;
    trackMediaHost(page, "i.redd.it");
    await openFeed(
      page,
      `${imagePost("md1", "First")}${imagePost("md2", "Second")}${videoBody(
        "md3",
        "Far clip",
      )}`,
      { durations: { "md3.mp4": 6 } },
    );

    // Offset 2 puts the video inside the video window but past the
    // immediate-first-frame priority ceiling: metadata only, and the
    // engine hands the element preload="none" so the browser stops
    // reading past the metadata boxes.
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).some(
            ({ event, detail }) =>
              event === "preload-loaded" &&
              detail?.media === "metadata" &&
              String(detail.key).includes("md3.mp4"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    // Snapshot before display: a later firstframe event can legitimately
    // fire when the prepared element is played (its loadeddata listener
    // survives into display), so the depth claim is about the preload
    // period only. With a tiny fixture the browser may buffer the whole
    // file during the metadata phase, so the engine's decision marker —
    // logged only when first-frame depth is actually scheduled — is the
    // reliable signal, not the data-arrival event.
    const eventsAtPreload = await debugEvents(page);
    expect(
      eventsAtPreload.some(
        ({ event, detail }) =>
          event === "preload-firstframe-scheduled" &&
          String(detail.key).includes("md3.mp4"),
      ),
    ).toBe(false);

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveAttribute(
      "preload",
      "none",
    );
  });

  test("the gallery window scales with spare capacity and stays bounded for large galleries", async ({
    page,
  }) => {
    trackMediaHost(page, "i.redd.it");
    const figures = [];
    for (let i = 1; i <= 20; i += 1) {
      figures.push({ file: `big${i}` });
    }
    // Fully rendered: no enrichment, so the window math is deterministic
    // from the very first scheduler pass.
    await openFeed(
      page,
      `${renderedGalleryPost(
        "bigG",
        "Big gallery",
        figures,
      )}${imagePost("far1", "After the gallery")}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/20) Big gallery",
    );

    // Drain the speculative window.
    await expect
      .poll(() => stats(page), { timeout: 30000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));

    const cached = (await cacheKeys(page)).join("\n");
    // Default settings: base window max(8, 5*2)=10 widened by spare pool
    // capacity (3 slots idle → +6) to 16 — so 16 of the 19 remaining items
    // are preloaded, and the distant tail is not parked in the cache.
    for (let i = 2; i <= 17; i += 1) {
      expect(cached, `big${i} preloaded`).toContain(`big${i}.jpg`);
    }
    expect(cached, "big18 stays outside the window").not.toContain("big18.jpg");
    expect(cached, "big19 stays outside the window").not.toContain("big19.jpg");
    expect(cached, "big20 stays outside the window").not.toContain("big20.jpg");
    expect(cached, "the following post stays outside the gallery").not.toContain(
      "far1.jpg",
    );

    // The window rolls: advancing re-centers it on the slides that are now
    // near, so the tail becomes reachable by walking, not by one giant
    // prefetch.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText(
      "(3/20) Big gallery",
    );
    await expect
      .poll(() => stats(page), { timeout: 30000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));
    const cachedAfter = (await cacheKeys(page)).join("\n");
    expect(cachedAfter, "big18 enters the rolled window").toContain(
      "big18.jpg",
    );
  });

  test("DASH preparation is tracked through bridge stages and released on teardown", async ({
    page,
  }) => {
    trackMediaHost(page, "i.redd.it");
    trackMediaHost(page, "v.redd.it");
    await openFeed(
      page,
      `${imagePost("di1", "Image first")}${oldRedditDashPost(
        "dv1",
        "Dash clip",
      )}${imagePost("di2", "Image after")}`,
      {
        before: () =>
          installStageDashStub(page, {
            manifest: 60,
            segments: 120,
            ready: 180,
            data: 240,
          }),
      },
    );

    // The prepared player walks every bridge stage, and the activity entry
    // stays live while the stream is held.
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(
        expect.objectContaining({
          dashPrepared: 1,
          dashManifest: 1,
          dashFirstSegment: 1,
          dashReady: 1,
        }),
      );
    await expect
      .poll(
        async () => {
          const current = await stats(page);
          return current.dashActivity[0]?.stage;
        },
        { timeout: 15000 },
      )
      .toBe("ready");
    // The job stayed in flight until real stream data arrived, then ended
    // its in-flight period with an explicit settle.
    const settled = (await debugEvents(page)).filter(
      ({ event, detail }) =>
        event === "preload-dash-settled" && detail?.why === "ready",
    );
    expect(settled.length).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));

    // Displaying the clip reuses the attached player; leaving it releases
    // the stream and the activity entry with it.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__video")).toHaveAttribute(
      "data-redditp-dash",
      "attached",
    );
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ dashActive: 0, dashReleased: 1 }));
    const resets = await page.evaluate(() => window.__dashResets);
    expect(resets).toBeGreaterThanOrEqual(1);
  });

  test("a queued video blocked by the budget starts through the stall override", async ({
    page,
  }) => {
    const videoBody = (id, title) =>
      `<shreddit-post id="t3_${id}" post-title="${title}" post-type="video" content-href="https://i.redd.it/${id}.mp4" permalink="/r/pics/comments/${id}/post/"><video src="https://i.redd.it/${id}.mp4"></video></shreddit-post>`;
    trackMediaHost(page, "i.redd.it");
    await openFeed(
      page,
      `${imagePost("si1", "First")}${videoBody("sv1", "Clip 1")}${videoBody(
        "sv2",
        "Clip 2",
      )}${videoBody("sv3", "Clip 3")}`,
      {
        settings: { preloadPosts: 4 },
        // Known-short durations make sv1/sv2 fetch first frames, so both
        // budget slots are held in an expensive state.
        durations: { "sv1.mp4": 6, "sv2.mp4": 6 },
      },
    );

    // sv1 and sv2 fill the two-slot budget; sv3 waits outside the video
    // window until the user moves, then faces a full budget.
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ videoFirstFrames: 2 }));
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 1");

    // No image job competes, so after the bounded stall the budget yields
    // and sv3 starts anyway — it must never block indefinitely.
    await expect
      .poll(
        async () =>
          (await debugEvents(page)).some(
            ({ event, detail }) =>
              event === "preload-video-stall" &&
              String(detail.key).includes("sv3.mp4"),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));
  });

  test("a cold-displayed image is reused on the step back instead of refetched", async ({
    page,
  }) => {
    const media = trackMediaHost(page, "i.redd.it");
    await openFeed(
      page,
      `${imagePost("cd1", "One")}${imagePost("cd2", "Two")}${imagePost(
        "cd3",
        "Three",
      )}`,
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Two");
    // The numbered track renders its own thumbnails of every slide, so
    // request counting must start after the open settled.
    await page.waitForTimeout(400);
    const requestsBefore = media.length;
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("One");

    // cd1 was displayed cold at open; its displayed element joined the
    // cache, so the step back is a cache hit with no second request.
    const nav = await navRecord(page);
    expect(nav.ready).toBe(true);
    expect(
      media
        .slice(requestsBefore)
        .some(({ url }) => url.includes("cd1.jpg")),
    ).toBe(false);
    const hits = (await debugEvents(page)).filter(
      ({ event, detail }) =>
        event === "cache-hit" && String(detail).includes("cd1.jpg"),
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("a cold-displayed video is reused on the step back instead of refetched", async ({
    page,
  }) => {
    const media = trackMediaHost(page, "i.redd.it");
    const directVideo = (id, title) =>
      `<shreddit-post id="t3_${id}" post-title="${title}" post-type="video" content-href="https://i.redd.it/${id}.mp4" permalink="/r/pics/comments/${id}/post/"><video src="https://i.redd.it/${id}.mp4"></video></shreddit-post>`;
    await openFeed(
      page,
      `${directVideo("cv2", "Long clip")}${imagePost("cv3", "Image after")}`,
    );

    // The open display is cold by definition (current slides are never
    // preloaded), so this exercises exactly the display-cache path: the
    // freshly displayed element joins the preload cache at metadata.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.readyState >= 1,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.waitForTimeout(400);
    const requestsBefore = media.length;
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image after");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Long clip");

    // The step back reuses the cold-displayed element (prepared reuse,
    // because its cache entry still holds metadata and buffers).
    const nav = await navRecord(page);
    expect(nav.reuse).toBe("prepared");
    expect(
      media
        .slice(requestsBefore)
        .some(({ url }) => url.includes("cv2.mp4")),
    ).toBe(false);
  });

  test("closing and reopening reuses the displayed media without a refetch", async ({
    page,
  }) => {
    const media = trackMediaHost(page, "i.redd.it");
    await openFeed(
      page,
      `${imagePost("ro1", "Keep")}${imagePost("ro2", "Next")}`,
    );
    await expect(page.locator(".redditp__image")).toHaveAttribute(
      "src",
      "https://i.redd.it/ro1.jpg",
    );
    await page.evaluate(() => window.__redditpPresentation.toggle());
    await expect(page.locator("#redditp-presentation")).toBeHidden();
    const before = countOf(media, "ro1.jpg");
    await page.evaluate(() => window.__redditpPresentation.toggle());
    await expect(page.locator("#redditp-presentation")).toBeVisible();
    await expect(page.locator(".redditp__image")).toHaveAttribute(
      "src",
      "https://i.redd.it/ro1.jpg",
    );
    expect(countOf(media, "ro1.jpg")).toBe(before);
  });
});
