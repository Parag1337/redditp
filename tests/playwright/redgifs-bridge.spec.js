const path = require("path");
const fs = require("fs");
const { test, expect } = require("@playwright/test");

const bridgeScript = path.resolve(
  __dirname,
  "../../browser-extension/redgifs-bridge.js",
);
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

const MEDIA_ID = "bridgeclip";

// ---------------------------------------------------------------------------
// Bridge frame tests. These load the real bridge into a real embedded frame
// and drive a fake HTMLVideoElement through the same media events a player
// emits. The parent page is the Reddit origin, exactly like production.
// ---------------------------------------------------------------------------
async function openBridgeFrame(
  page,
  {
    parentOrigin = "https://www.reddit.com",
    mediaId = MEDIA_ID,
    injectBridge = true,
  } = {},
) {
  const parentUrl = `${parentOrigin}/r/redditpbridge/?redditp=bridge`;
  const playerUrl = `https://www.redgifs.com/ifr/${mediaId}`;
  await page.route(parentUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><iframe id="player" src="${playerUrl}"></iframe></body></html>`,
    }),
  );
  await page.route("https://www.redgifs.com/ifr/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body>fixture player</body></html>",
    }),
  );
  await page.goto(parentUrl);
  await page.evaluate(() => {
    window.__bridgeMessages = [];
    window.addEventListener("message", (event) => {
      window.__bridgeMessages.push({
        origin: event.origin,
        data: event.data,
      });
    });
  });
  const iframe = page.locator("#player");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.waitForLoadState();
  if (injectBridge) {
    await frame.addScriptTag({ path: bridgeScript });
    await createBridgeVideo(frame);
  }
  return { frame, playerUrl };
}

async function createBridgeVideo(frame) {
  await frame.evaluate(() => {
    const media = (window.__redgifsMedia = {
      currentTime: 0,
      duration: 10,
      paused: false,
      seeking: false,
      ended: false,
    });
    const video = document.createElement("video");
    video.id = "redgifs-player-video";
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => media.currentTime,
        set: (value) => {
          media.currentTime = value;
        },
      },
      duration: { configurable: true, get: () => media.duration },
      paused: { configurable: true, get: () => media.paused },
      seeking: { configurable: true, get: () => media.seeking },
      ended: { configurable: true, get: () => media.ended },
    });
    document.body.append(video);
  });
}

async function emitMedia(frame, changes, type = "timeupdate") {
  await frame.evaluate(
    ({ changes: next, type: eventType }) => {
      Object.assign(window.__redgifsMedia, next);
      const video = document.querySelector("#redgifs-player-video");
      video.dispatchEvent(new Event(eventType));
    },
    { changes, type },
  );
}

const bridgeMessages = (page) => page.evaluate(() => window.__bridgeMessages);

async function expectNoBridgeMessages(page, waitMs = 150) {
  await page.waitForTimeout(waitMs);
  expect(await bridgeMessages(page)).toEqual([]);
}

test.describe("redgifs bridge frame", () => {
  test("natural loop boundary reports exactly one completion", async ({
    page,
  }) => {
    const { frame } = await openBridgeFrame(page);
    // Ordinary playback to the end is not a wrap.
    await emitMedia(frame, { currentTime: 5 });
    await emitMedia(frame, { currentTime: 9.6 });
    await expectNoBridgeMessages(page, 100);
    // The native player wraps from the end back to the start.
    await emitMedia(frame, { currentTime: 0.1 });
    // Re-delivered events at the same boundary must not duplicate it.
    await emitMedia(frame, { currentTime: 0.1 });
    await emitMedia(frame, { currentTime: 0.1 }, "seeked");
    await emitMedia(frame, { currentTime: 10, ended: true }, "ended");

    const messages = await bridgeMessages(page);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      origin: "https://www.redgifs.com",
      data: {
        channel: "redditp-redgifs",
        version: 1,
        type: "completion",
        mediaId: MEDIA_ID,
      },
    });
  });

  test("ordinary playback does not report a completion", async ({ page }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { currentTime: 1 });
    await emitMedia(frame, { currentTime: 5 });
    await emitMedia(frame, { currentTime: 9 });
    await emitMedia(frame, { currentTime: 9.6 });
    await emitMedia(frame, { currentTime: 0.6 });
    await expectNoBridgeMessages(page);
  });

  test("invalid durations are rejected", async ({ page }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { duration: NaN, currentTime: 9.6 });
    await emitMedia(frame, { currentTime: 0.1 });
    await emitMedia(frame, { duration: 1, currentTime: 0.9 });
    await emitMedia(frame, { currentTime: 0.1 });
    await emitMedia(frame, { duration: 0.5, currentTime: 0.45 });
    await emitMedia(frame, { currentTime: 0.1 });
    await expectNoBridgeMessages(page);
  });

  test("pausing near the end holds, and resuming near the end completes", async ({
    page,
  }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { currentTime: 9.6 });
    await emitMedia(frame, { paused: true }, "pause");
    await emitMedia(frame, { currentTime: 9.6 });
    await expectNoBridgeMessages(page, 100);
    // Resume: the media is still near the end, so its wrap is genuine.
    await emitMedia(frame, { paused: false }, "play");
    await emitMedia(frame, { currentTime: 0.1 });
    expect(await bridgeMessages(page)).toHaveLength(1);
  });

  test("buffering near the end does not report a completion", async ({
    page,
  }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { currentTime: 9.6 });
    await emitMedia(frame, { currentTime: 9.6 }, "waiting");
    await emitMedia(frame, { currentTime: 9.7 });
    await emitMedia(frame, { currentTime: 9.7 }, "stalled");
    await expectNoBridgeMessages(page);
  });

  test("duration changes reset the boundary safely", async ({ page }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { duration: 10, currentTime: 9.6 });
    // The media got longer: the old near-end position is not the new end.
    await emitMedia(frame, { duration: 20 }, "durationchange");
    await emitMedia(frame, { currentTime: 0.1 });
    await expectNoBridgeMessages(page, 100);
    // The new end is the real boundary and reports once.
    await emitMedia(frame, { currentTime: 19.6 });
    await emitMedia(frame, { currentTime: 0.1 });
    expect(await bridgeMessages(page)).toHaveLength(1);
  });

  test("a shorter duration cannot reuse a stale near-end position", async ({
    page,
  }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { duration: 20, currentTime: 19.6 });
    await emitMedia(frame, { duration: 10, currentTime: 5 }, "durationchange");
    await emitMedia(frame, { currentTime: 0.1 });
    await expectNoBridgeMessages(page);
  });

  test("native ended is a fallback and reports once", async ({ page }) => {
    const { frame } = await openBridgeFrame(page);
    await emitMedia(frame, { currentTime: 10, ended: true }, "ended");
    await emitMedia(frame, { currentTime: 10, ended: true }, "ended");
    expect(await bridgeMessages(page)).toHaveLength(1);
  });

  test("a Reddit subdomain activates the bridge", async ({ page }) => {
    const { frame } = await openBridgeFrame(page, {
      parentOrigin: "https://old.reddit.com",
    });
    await emitMedia(frame, { currentTime: 9.6 });
    await emitMedia(frame, { currentTime: 0.1 });
    const messages = await bridgeMessages(page);
    expect(messages).toHaveLength(1);
    expect(messages[0].origin).toBe("https://www.redgifs.com");
  });

  test("the same player URL stays inactive at the top level", async ({
    page,
  }) => {
    const playerUrl = `https://www.redgifs.com/ifr/${MEDIA_ID}`;
    await page.route("https://www.redgifs.com/ifr/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body>fixture player</body></html>",
      }),
    );
    // A genuine Reddit referrer would satisfy every other bridge check; only
    // the embedded-frame guard keeps the top-level page silent.
    await page.goto(playerUrl, {
      referer: "https://www.reddit.com/r/test/",
    });
    expect(await page.evaluate(() => document.referrer)).toContain(
      "reddit.com",
    );
    await page.evaluate(() => {
      window.__bridgeMessages = [];
      window.addEventListener("message", (event) => {
        window.__bridgeMessages.push({ origin: event.origin, data: event.data });
      });
    });
    await page.addScriptTag({ path: bridgeScript });
    await createBridgeVideo(page);
    await emitMedia(page, { currentTime: 9.6 });
    await emitMedia(page, { currentTime: 0.1 });
    await expectNoBridgeMessages(page);
  });

  for (const parentOrigin of [
    "https://example.com",
    "https://notreddit.com",
    "https://reddit.com.evil.example",
  ]) {
    test(`the bridge stays inactive on ${parentOrigin}`, async ({ page }) => {
      const { frame } = await openBridgeFrame(page, { parentOrigin });
      await emitMedia(frame, { currentTime: 9.6 });
      await emitMedia(frame, { currentTime: 0.1 });
      await expectNoBridgeMessages(page);
    });
  }
});

// ---------------------------------------------------------------------------
// Parent integration. content.js runs on a routed Reddit feed with a real
// iframe whose document is RedGIFs. The API is failed on purpose so the slide
// stays on the host player, except for the direct-upgrade race test.
// ---------------------------------------------------------------------------

const feedUrl = "https://www.reddit.com/r/redgifsbridge/?redditp=bridge";
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/redgifsbridge/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const redgifsPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://www.redgifs.com/watch/${id}" data-permalink="/r/redgifsbridge/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

async function openIntegrationFeed(
  page,
  body,
  { settings = {}, resolveMedia = false, gifsGate = null } = {},
) {
  await page.route(feedUrl, (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svgImage,
    }),
  );
  await page.route("https://api.redgifs.com/v2/auth/temporary", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "bridge-fixture-token" }),
    }),
  );
  await page.route("https://api.redgifs.com/v2/gifs/**", async (route) => {
    if (gifsGate) await gifsGate;
    if (!resolveMedia) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "GifNotFound" } }),
      });
    }
    const id = route.request().url().split("/").pop();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        gif: {
          id,
          duration: 10,
          urls: {
            hd: `https://media.redgifs.com/${id}-hd.mp4`,
            html: `https://www.redgifs.com/ifr/${id}`,
          },
        },
      }),
    });
  });
  await page.route("https://media.redgifs.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/webm",
      body: webm,
    }),
  );
  await page.route("https://www.redgifs.com/ifr/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body>fixture player</body></html>",
    }),
  );

  await page.goto(feedUrl);
  await page.evaluate((stored) => {
    localStorage.setItem("redditpDebug", "1");
    localStorage.setItem(
      "redditpPresentationSettings",
      JSON.stringify({
        autoAdvance: true,
        slideDurationSeconds: 1,
        ...stored,
      }),
    );
  }, settings);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
}

async function activeEmbedFrame(page) {
  const iframe = page.locator("iframe.redditp__embed");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.waitForLoadState();
  return frame;
}

async function installBridgeInActiveFrame(page) {
  const frame = await activeEmbedFrame(page);
  await frame.addScriptTag({ path: bridgeScript });
  await createBridgeVideo(frame);
  return frame;
}

async function loopBridgeVideo(frame) {
  await emitMedia(frame, { currentTime: 9.6 });
  await emitMedia(frame, { currentTime: 0.1 });
}

async function dispatchParentMessage(page, data, options = {}) {
  await page.evaluate(
    ({ payload, origin, sourceMode }) => {
      const iframe = document.querySelector("iframe.redditp__embed");
      const source =
        sourceMode === "parent"
          ? window
          : sourceMode === "old" && window.__oldRedgifsWindow
            ? window.__oldRedgifsWindow
            : iframe && iframe.contentWindow;
      // Firefox rejects a cross-origin WindowProxy in MessageEventInit, so
      // install the source as an own property after construction. Production
      // receives a real cross-origin event; this only makes the validation
      // test portable.
      const event = new MessageEvent("message", {
        data: payload,
        origin,
      });
      Object.defineProperty(event, "source", {
        configurable: true,
        value: source,
      });
      window.dispatchEvent(event);
    },
    {
      payload: data,
      origin: options.origin || "https://www.redgifs.com",
      sourceMode: options.sourceMode || "active",
    },
  );
}

const validCompletion = (mediaId = MEDIA_ID) => ({
  channel: "redditp-redgifs",
  version: 1,
  type: "completion",
  mediaId,
});

test.describe("redgifs parent integration", () => {
  test.setTimeout(60000);

  test("an active slide advances immediately on a valid completion", async ({
    page,
  }) => {
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
      { settings: { slideDurationSeconds: 30 } },
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    const frame = await installBridgeInActiveFrame(page);
    await loopBridgeVideo(frame);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3", {
      timeout: 3000,
    });
    // One completion must produce exactly one advancement.
    await page.waitForTimeout(300);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
  });

  test("a paused completion is recorded and advances after resume", async ({
    page,
  }) => {
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    await page.keyboard.press("a");
    await expect(page.locator(".redditp__auto")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const frame = await installBridgeInActiveFrame(page);
    await loopBridgeVideo(frame);
    await page.waitForTimeout(500);
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    const snapshot = await page.evaluate(() =>
      window.__redditpPresentation.debug.snapshot(),
    );
    expect(snapshot.slides[1].redgifsCompleted).toBe(true);
    await page.keyboard.press("a");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3", {
      timeout: 4000,
    });
  });

  test("an unresolved embed is held safely and manual navigation still works", async ({
    page,
  }) => {
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    // No bridge, no completion: the ordinary image interval must not count as
    // one complete RedGIFs playback cycle.
    await page.waitForTimeout(1600);
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
  });

  test("invalid origin, protocol, source, and media identity are rejected", async ({
    page,
  }) => {
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
      { settings: { slideDurationSeconds: 30 } },
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");

    await dispatchParentMessage(page, validCompletion(), {
      origin: "https://evil.example",
    });
    await dispatchParentMessage(page, { ...validCompletion(), channel: "other" });
    await dispatchParentMessage(page, { ...validCompletion(), version: 2 });
    await dispatchParentMessage(page, { ...validCompletion(), version: "1" });
    await dispatchParentMessage(page, { ...validCompletion(), type: "started" });
    await dispatchParentMessage(page, validCompletion("some-other-clip"));
    await dispatchParentMessage(page, validCompletion(), {
      sourceMode: "parent",
    });
    await page.waitForTimeout(300);
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");

    // The same shape from the active frame and media is accepted.
    await dispatchParentMessage(page, validCompletion());
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
  });

  test("stale and replaced iframe messages cannot advance the viewer", async ({
    page,
  }) => {
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
      { settings: { slideDurationSeconds: 30 } },
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    await page.evaluate(() => {
      window.__oldRedgifsWindow =
        document.querySelector("iframe.redditp__embed").contentWindow;
    });

    // Navigate away; a message attributed to the old frame is stale.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    await dispatchParentMessage(page, validCompletion(), {
      sourceMode: "old",
    });
    await page.waitForTimeout(200);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");

    // Return to the embed. Its frame is replaced, so the old window is still
    // not the active source even though the slide identity matches again.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    await dispatchParentMessage(page, validCompletion(), {
      sourceMode: "old",
    });
    await page.waitForTimeout(200);
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
  });

  test("a direct-video upgrade owns advancement and ignores late bridge messages", async ({
    page,
  }) => {
    let releaseGifs;
    const gifsGate = new Promise((resolve) => {
      releaseGifs = resolve;
    });
    await openIntegrationFeed(
      page,
      `${imagePost("i1", "Image 1")}${redgifsPost(MEDIA_ID, "RedGIFs clip")}${imagePost("i2", "Image 3")}`,
      {
        settings: { slideDurationSeconds: 30, loopShortMedia: false },
        resolveMedia: true,
        gifsGate,
      },
    );

    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");
    const frame = await activeEmbedFrame(page);
    await frame.addScriptTag({ path: bridgeScript });
    await createBridgeVideo(frame);
    await page.evaluate(() => {
      window.__oldRedgifsWindow =
        document.querySelector("iframe.redditp__embed").contentWindow;
    });
    releaseGifs();
    await expect(page.locator(".redditp__video")).toHaveCount(1, {
      timeout: 10000,
    });
    await page.evaluate(() => {
      document.querySelector(".redditp__video").pause();
    });

    // The old iframe's completion is late: the direct element owns playback.
    await dispatchParentMessage(page, validCompletion(), {
      sourceMode: "old",
    });
    await page.waitForTimeout(300);
    await expect(page.locator(".redditp__title")).toHaveText("RedGIFs clip");

    await page.evaluate(() => {
      document
        .querySelector(".redditp__video")
        .dispatchEvent(new Event("ended"));
    });
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    // A second late iframe report cannot advance again.
    await dispatchParentMessage(page, validCompletion(), {
      sourceMode: "old",
    });
    await page.waitForTimeout(200);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
  });
});
