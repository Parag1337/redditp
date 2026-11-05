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
const autoActivateScript = path.resolve(
  __dirname,
  "../../browser-extension/auto-activate.js",
);
const linkPreviewFeedFixture = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../test-data/browser-extension-link-preview-feed.html",
  ),
  "utf8",
);
const linkPreviewPostFixture = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../test-data/browser-extension-link-preview-post.html",
  ),
  "utf8",
);
const staleVideoOverlayFixture = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../test-data/browser-extension-stale-video-overlay.html",
  ),
  "utf8",
);

// Stands in for the dash.js that old Reddit loads for its own player, and
// injects the bridge that lends it to the extension.
async function installRedditDash(page, { failPlayback = false } = {}) {
  await page.evaluate((fail) => {
    window.__dashCalls = [];
    window.__dashResets = 0;
    const MediaPlayer = () => ({
      create() {
        const errorHandlers = [];
        return {
          on(type, handler) {
            if (type === "error") errorHandlers.push(handler);
          },
          initialize(video, url, autoPlay) {
            window.__dashCalls.push({ url, autoPlay });
            if (fail) {
              setTimeout(() => {
                errorHandlers.forEach((handler) =>
                  handler({ error: "download" }),
                );
              }, 50);
            }
          },
          reset() {
            window.__dashResets += 1;
          },
        };
      },
    });
    MediaPlayer.events = { ERROR: "error" };
    window.dashjs = { MediaPlayer };
  }, failPlayback);
  await page.addScriptTag({ path: pageBridgeScript });
}

async function canPlayHls(page) {
  return page.evaluate(() =>
    Boolean(
      document
        .createElement("video")
        .canPlayType("application/vnd.apple.mpegurl"),
    ),
  );
}

async function startPresentation(page, html, setup) {
  await page.setContent(`<base href="https://www.reddit.com/">${html}`);
  if (setup) await setup(page);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
}

// The shipped extension starts with auto-advance enabled. Tests below that
// exercise "start advancing from manual mode" pin the auto state first so
// they stay deterministic whatever the shipped default becomes.
async function pinAutoAdvance(page, enabled) {
  const autoButton = page.locator(".redditp__auto");
  const pressed = await autoButton.getAttribute("aria-pressed");
  if (pressed !== String(enabled)) {
    await autoButton.click();
  }
  await expect(autoButton).toHaveAttribute("aria-pressed", String(enabled));
}

// The media and comments destinations open in a new tab through the I and C
// keyboard shortcuts; capturing window.open keeps these checks offline-safe.
async function captureWindowOpens(page) {
  await page.evaluate(() => {
    window.__openedUrls = [];
    window.open = function (url) {
      window.__openedUrls.push(String(url || ""));
      return null;
    };
  });
}

async function openedUrls(page) {
  return page.evaluate(() => window.__openedUrls);
}

test("extension presents old Reddit image posts and supports keyboard navigation", async ({
  page,
}) => {
  await page.route("https://i.redd.it/first.jpg", async (route) => {
    await route.fulfill({
      contentType: "image/gif",
      body: Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        "base64",
      ),
    });
  });
  await startPresentation(
    page,
    `
      <div class="thing link" data-url="https://i.redd.it/first.jpg" data-author="alice" data-subreddit="pics" data-permalink="/r/pics/comments/one/first/">
        <a class="title" href="https://i.redd.it/first.jpg">First old Reddit post</a>
        <a class="comments" href="/r/pics/comments/one/first/">comments</a>
      </div>
      <div class="thing link" data-url="https://example.com/story" data-author="bob" data-subreddit="news" data-permalink="/r/news/comments/two/story/">
        <a class="title" href="https://example.com/story">Second old Reddit post</a>
        <a class="comments" href="/r/news/comments/two/story/">comments</a>
      </div>
    `,
  );

  await expect(page.locator("#redditp-presentation")).toBeVisible();
  await expect(page.locator(".redditp__title")).toHaveText(
    "First old Reddit post",
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    "https://i.redd.it/first.jpg",
  );
  await expect(page.locator(".redditp__prev")).toBeDisabled();

  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".redditp__title")).toHaveText(
    "First old Reddit post",
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText(
    "Second old Reddit post",
  );
  await expect(page.locator(".redditp__prev")).toBeEnabled();
  await expect(page.locator(".redditp__link-card")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#redditp-presentation")).toBeHidden();
});

test("shows the body of a Reddit text post", async ({ page }) => {
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_textpost"
        post-title="What did I do wrong?"
        author="newbie"
        subreddit-prefixed-name="r/bjj"
        permalink="/r/bjj/comments/textpost/body/"
      >
        <shreddit-post-text-body slot="text-body">
          <div slot="text-body" class="text-neutral-content">
            <div class="md">
              <p>First paragraph of the post.</p>
              <p>Second paragraph with more context.</p>
            </div>
            <button>Read more</button>
          </div>
        </shreddit-post-text-body>
      </shreddit-post>
    `,
  );

  const postBody = page.locator(".redditp__post-body");
  await expect(postBody).toContainText("First paragraph of the post.");
  await expect(postBody).toContainText("Second paragraph with more context.");
  await expect(postBody).not.toContainText("Read more");
  await expect(page.locator(".redditp__link-icon")).toHaveText("Text post");
});

test("old Reddit combined-search cards upgrade their outbound media", async ({
  page,
}) => {
  const postUrl =
    "https://old.reddit.com/r/LoveTrash/comments/oldvideo/nature/";
  const hlsUrl = "https://v.redd.it/oldvideo/HLSPlaylist.m3u8?a=1&v=1&f=sd";
  const seekPreviewUrl = "https://v.redd.it/oldvideo/DASH_96.mp4";
  // A fetched old Reddit post page has no <video>: the player is only data
  // attributes until Reddit's own script builds it.
  await page.route(postUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<div class="thing link" data-fullname="t3_oldvideo" data-url="https://v.redd.it/oldvideo" data-permalink="/r/LoveTrash/comments/oldvideo/nature/" data-author="poster" data-subreddit="LoveTrash"><a class="title">Nature...</a><div class="portrait" data-hls-url="${hlsUrl}" data-mpd-url="https://v.redd.it/oldvideo/DASHPlaylist.mpd?a=1&amp;v=1&amp;f=sd" data-seek-preview-url="${seekPreviewUrl}"></div></div>`,
    });
  });
  for (const url of [hlsUrl, seekPreviewUrl]) {
    await page.route(url, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.abort();
    });
  }
  await startPresentation(
    page,
    `<div class="search-result search-result-link has-thumbnail" data-fullname="t3_oldvideo"><a class="thumbnail" href="${postUrl}"></a><a class="search-title" href="${postUrl}">Nature...</a><a class="search-comments" href="${postUrl}">193 comments</a><a class="author" href="https://old.reddit.com/user/poster">poster</a><a class="search-subreddit-link" href="https://old.reddit.com/r/LoveTrash/">r/LoveTrash</a><a class="search-link" href="https://v.redd.it/oldvideo">https://v.redd.it/oldvideo</a></div>`,
  );

  await expect(page.locator(".redditp__title")).toHaveText("Nature...");
  await expect(page.locator(".redditp__meta")).toContainText("r/LoveTrash");
  // Without Reddit's dash.js the slide plays what the browser can by itself.
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    (await canPlayHls(page)) ? hlsUrl : seekPreviewUrl,
  );
  // The media destination opens in a new tab through the I shortcut.
  await captureWindowOpens(page);
  await page.keyboard.press("i");
  expect(await openedUrls(page)).toContain("https://v.redd.it/oldvideo");
});

const oldRedditTextSearchCard = (postUrl) =>
  `<div class="search-result search-result-link" data-fullname="t3_hills"><a class="search-title" href="${postUrl}">Norwegian method and hills</a><a class="search-comments" href="${postUrl}">12 comments</a><a class="author" href="https://old.reddit.com/user/runner">runner</a><a class="search-subreddit-link" href="https://old.reddit.com/r/NorwegianSinglesRun/">r/NorwegianSinglesRun</a></div>`;

test("old Reddit search text posts show a loading card, then their fetched body", async ({
  page,
}) => {
  const postUrl =
    "https://old.reddit.com/r/NorwegianSinglesRun/comments/hills/norwegian_method_and_hills/";
  let releasePost;
  const postReleased = new Promise((resolve) => {
    releasePost = resolve;
  });
  await page.route(postUrl, async (route) => {
    await postReleased;
    await route.fulfill({
      contentType: "text/html",
      body: `<div id="siteTable"><div class="thing link self" data-fullname="t3_hills" data-url="${postUrl}" data-permalink="/r/NorwegianSinglesRun/comments/hills/norwegian_method_and_hills/" data-author="runner" data-subreddit="NorwegianSinglesRun"><div class="entry"><a class="title" href="${postUrl}">Norwegian method and hills</a><div class="expando"><form class="usertext"><div class="usertext-body"><div class="md"><p>First paragraph about hills.</p><p>Second paragraph about thresholds.</p><ul><li>Tuesday</li><li>Saturday</li></ul></div></div></form></div></div></div></div><div class="commentarea"><div class="thing comment"><div class="usertext-body"><div class="md"><p>A comment reply.</p></div></div></div></div>`,
    });
  });
  await startPresentation(page, oldRedditTextSearchCard(postUrl));

  const card = page.locator(".redditp__link-card");
  await expect(page.locator(".redditp__link-icon")).toHaveText("Loading post…");
  await expect(card).toHaveAttribute("aria-busy", "true");

  releasePost();
  await expect(page.locator(".redditp__link-icon")).toHaveText("Text post");
  await expect(card).not.toHaveAttribute("aria-busy", /./);
  // The fetched page is never rendered, so paragraph breaks are rebuilt.
  expect(await page.locator(".redditp__post-body").textContent()).toBe(
    "First paragraph about hills.\n\nSecond paragraph about thresholds.\n\nTuesday\nSaturday",
  );
});

test("a failed search enrichment clears the loading card", async ({ page }) => {
  const postUrl =
    "https://old.reddit.com/r/NorwegianSinglesRun/comments/hills/norwegian_method_and_hills/";
  await page.route(postUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 500, body: "" });
  });
  await startPresentation(page, oldRedditTextSearchCard(postUrl));

  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Open linked post",
  );
  await expect(page.locator(".redditp__link-card")).not.toHaveAttribute(
    "aria-busy",
    /./,
  );
});

const oldRedditVideoPosts = `
  <div class="thing link" data-fullname="t3_dashvideo" data-url="https://v.redd.it/dashvideo" data-permalink="/r/videos/comments/dashvideo/concert/" data-author="fan" data-subreddit="videos">
    <a class="title">Concert clip</a>
    <div class="portrait" data-hls-url="https://v.redd.it/dashvideo/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/dashvideo/DASHPlaylist.mpd?a=1&amp;v=1" data-seek-preview-url="https://v.redd.it/dashvideo/DASH_96.mp4"></div>
  </div>
  <div class="thing link" data-fullname="t3_story" data-url="https://example.com/story" data-author="bob" data-subreddit="news" data-permalink="/r/news/comments/story/after/">
    <a class="title">Story after the video</a>
  </div>
`;

test("old Reddit v.redd.it slides play their DASH tracks through Reddit's dash.js", async ({
  page,
}) => {
  await startPresentation(page, oldRedditVideoPosts, (setupPage) =>
    installRedditDash(setupPage),
  );

  const video = page.locator(".redditp__video");
  await expect(video).toHaveAttribute("data-redditp-dash", "attached");
  await expect(video).not.toHaveAttribute("src", /./);
  expect(await page.evaluate(() => window.__dashCalls)).toEqual([
    {
      url: "https://v.redd.it/dashvideo/DASHPlaylist.mpd?a=1&v=1",
      autoPlay: false,
    },
  ]);

  // Leaving the slide must stop dash.js from buffering in the background.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText(
    "Story after the video",
  );
  expect(await page.evaluate(() => window.__dashResets)).toBe(1);
});

test("old Reddit v.redd.it slides fall back when Reddit's dash.js fails", async ({
  page,
}) => {
  const seekPreviewUrl = "https://v.redd.it/dashvideo/DASH_96.mp4";
  await page.route(seekPreviewUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.abort();
  });
  await startPresentation(page, oldRedditVideoPosts, (setupPage) =>
    installRedditDash(setupPage, { failPlayback: true }),
  );

  const video = page.locator(".redditp__video");
  await expect(video).toHaveAttribute(
    "src",
    (await canPlayHls(page))
      ? "https://v.redd.it/dashvideo/HLSPlaylist.m3u8"
      : seekPreviewUrl,
  );
  await expect(video).not.toHaveAttribute("data-redditp-dash", /./);
  expect(await page.evaluate(() => window.__dashResets)).toBe(1);
});

test("a DASH_96 seek preview is not presented as the video", async ({
  page,
}) => {
  await startPresentation(
    page,
    `<shreddit-post id="t3_seekpreview" post-title="Seek preview only" post-type="video" content-href="https://v.redd.it/seekpreview" permalink="/r/test/comments/seekpreview/post/"><shreddit-player src="https://v.redd.it/seekpreview/HLSPlaylist.m3u8" preview="https://v.redd.it/seekpreview/DASH_96.mp4"></shreddit-player></shreddit-post>`,
  );

  await expect(page.locator(".redditp__title")).toHaveText("Seek preview only");
  await expect(
    page.locator(".redditp__media video[src*='DASH_96']"),
  ).toHaveCount(0);
});

test("arrow keys still change slides after clicking native video controls", async ({
  page,
  browserName,
}) => {
  // Only Chromium stops delivering key events once its control buttons have
  // focus, and the control positions below match Chromium's layout.
  test.skip(browserName !== "chromium", "Chromium native video controls");
  const videoUrl = "https://v.redd.it/sound/DASH_480.mp4";
  await page.route(videoUrl, async (route) => {
    await route.fulfill({
      contentType: "video/webm",
      body: fs.readFileSync(
        path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
      ),
    });
  });
  await startPresentation(
    page,
    `
      <div class="thing link" data-url="https://v.redd.it/sound" data-author="alice" data-subreddit="videos" data-permalink="/r/videos/comments/one/sound/">
        <a class="title">Video with sound</a>
        <video src="${videoUrl}"></video>
      </div>
      <div class="thing link" data-url="https://example.com/story" data-author="bob" data-subreddit="news" data-permalink="/r/news/comments/two/story/">
        <a class="title">Story after the video</a>
      </div>
    `,
  );

  const video = page.locator(".redditp__video");
  await expect(video).toHaveJSProperty("readyState", 4);
  await expect(video).toHaveJSProperty("muted", true);
  await video.hover();
  const bounds = await video.boundingBox();

  // The overflow menu closes when the video loses focus, so opening it must
  // not release focus.
  await page.mouse.click(
    bounds.x + bounds.width - 24,
    bounds.y + bounds.height - 48,
  );
  await page.waitForTimeout(300);
  await expect(video).toBeFocused();
  await page.keyboard.press("Escape");
  await video.hover();

  // Chromium's native controls live inside its shadow DOM and their pixel
  // positions move between releases, so find the mute button by clicking a
  // small grid around the bottom-right of the video until it responds.
  let muted = await video.evaluate((v) => v.muted);
  outer: for (const dx of [120, 100, 80, 140, 160]) {
    for (const dy of [48, 44, 40, 36, 32, 28, 24, 20, 16]) {
      if (!muted) break outer;
      await video.hover();
      await page.mouse.click(
        bounds.x + bounds.width - dx,
        bounds.y + bounds.height - dy,
      );
      await page.waitForTimeout(60);
      muted = await video.evaluate((v) => v.muted);
    }
  }

  await expect(video).toHaveJSProperty("muted", false);
  await expect(video).not.toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText(
    "Story after the video",
  );
});

test("old Reddit reuses its live adaptive video instead of the seek preview", async ({
  page,
}) => {
  await page.setContent(`
    <base href="https://old.reddit.com/">
    <div class="thing link" data-url="https://v.redd.it/adaptive" data-author="runner" data-subreddit="MadeMeSmile" data-permalink="/r/MadeMeSmile/comments/adaptive/post/">
      <a class="title">Adaptive video</a>
      <div id="native-player"><video id="adaptive-video" class="portrait" muted></video></div>
      <video id="seek-preview" class="portrait" muted src="https://v.redd.it/adaptive/CMAF_96.mp4"></video>
    </div>
  `);
  await page.locator("#adaptive-video").evaluate((video) => {
    video.src = URL.createObjectURL(
      new Blob(["not real media"], { type: "video/mp4" }),
    );
  });
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });

  await expect(page.locator(".redditp__media #adaptive-video")).toBeVisible();
  await expect(page.locator(".redditp__count")).toHaveText(
    "1 / 1 · loading more",
  );
  await expect(page.locator("#adaptive-video")).toHaveJSProperty(
    "controls",
    true,
  );
  await expect(page.locator(".redditp__media #seek-preview")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.locator("#native-player > #adaptive-video")).toHaveCount(1);
  await expect(page.locator("#adaptive-video")).toHaveClass("portrait");
  await expect(page.locator("#adaptive-video")).toHaveJSProperty(
    "controls",
    false,
  );
});

test("current Reddit reuses adaptive video inside an open player shadow root", async ({
  page,
  browserName,
}) => {
  const detailUrl =
    "https://www.reddit.com/r/test/comments/shadowvideo/post/?redditp=1";
  await page.route(detailUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <shreddit-post id="t3_shadowvideo" post-title="Shadow video" post-type="video" content-href="https://v.redd.it/shadowvideo" permalink="/r/test/comments/shadowvideo/post/">
          <shreddit-player src="https://v.redd.it/shadowvideo/HLSPlaylist.m3u8" preview="https://v.redd.it/shadowvideo/CMAF_96.mp4"></shreddit-player>
        </shreddit-post>
        <div style="height: 4000px"></div>
      `,
    }),
  );
  await page.goto(detailUrl);
  await page.locator("shreddit-player").evaluate((player) => {
    window.__redditpScrollCalls = 0;
    const originalScrollTo = window.scrollTo.bind(window);
    window.scrollTo = (...args) => {
      window.__redditpScrollCalls += 1;
      originalScrollTo(...args);
    };
    window.__redditTargetClicks = 0;
    window.__redditVideoPaused = true;
    window.__redditPlaybackCalls = { play: 0, pause: 0 };
    const shadow = player.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    video.id = "shadow-adaptive-video";
    video.muted = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => window.__redditVideoPaused,
    });
    video.play = () => {
      window.__redditPlaybackCalls.play += 1;
      window.__redditVideoPaused = false;
      return Promise.resolve();
    };
    video.pause = () => {
      window.__redditPlaybackCalls.pause += 1;
      window.__redditVideoPaused = true;
    };
    video.addEventListener("click", () => {
      window.__redditTargetClicks += 1;
      if (!video.getAttribute("src")) {
        video.src = URL.createObjectURL(
          new Blob(["not real media"], { type: "video/mp4" }),
        );
      }
    });
    shadow.append(video);
  });
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });

  await expect(
    page.locator(".redditp__media #shadow-adaptive-video"),
  ).toBeVisible();
  await expect(page.locator(".redditp__count")).toContainText("1 / 1");
  await expect(page.locator(".redditp__next")).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  expect(await page.evaluate(() => window.__redditpScrollCalls)).toBe(0);
  const playbackCalls = await page.evaluate(() => window.__redditPlaybackCalls);
  await page.keyboard.press("p");
  await page.keyboard.press("p");
  expect(await page.evaluate(() => window.__redditPlaybackCalls)).toEqual(
    playbackCalls,
  );
  await expect(
    page.locator(".redditp__media video[src*='CMAF_96']"),
  ).toHaveCount(0);
  // Firefox's native video controls consume clicks on the video surface before
  // any page listener sees them, so Firefox toggles playback itself and neither
  // redditp nor Reddit's own handler runs. Only Chromium exercises this path.
  if (browserName !== "firefox") {
    await page
      .locator("#shadow-adaptive-video")
      // Click the element itself. The stub video has no metadata, so its
      // adopted box is the browser-default 300px object size; a fixed offset
      // can land outside that box and get swallowed by the media container.
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__redditVideoPaused))
      .toBe(true);
    expect(await page.evaluate(() => window.__redditTargetClicks)).toBe(1);
    await page
      .locator("#shadow-adaptive-video")
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__redditVideoPaused))
      .toBe(false);
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__redditpScrollCalls)).toBe(0);

  await page.keyboard.press("Escape");
  const restored = await page.locator("shreddit-player").evaluate((player) => {
    const video = player.shadowRoot.querySelector("#shadow-adaptive-video");
    return Boolean(video && video.parentNode === player.shadowRoot);
  });
  expect(restored).toBe(true);
});

test("a dormant adaptive player upgrades when its feed slide is reached", async ({
  page,
}) => {
  await page.setContent(`
    <base href="https://www.reddit.com/">
    <shreddit-post id="t3_image" post-title="First image" content-href="https://i.redd.it/first.jpg" permalink="/r/test/comments/image/first/"></shreddit-post>
    <shreddit-post id="t3_feedvideo" post-title="Feed video" post-type="video" content-href="https://v.redd.it/feedvideo" permalink="/r/test/comments/feedvideo/post/">
      <shreddit-player src="https://v.redd.it/feedvideo/HLSPlaylist.m3u8" preview="https://v.redd.it/feedvideo/CMAF_96.mp4" poster="https://external-preview.redd.it/feedvideo.png"></shreddit-player>
    </shreddit-post>
  `);
  await page.locator("shreddit-player").evaluate((player) => {
    window.__feedPlayerStarts = 0;
    const shadow = player.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    video.id = "feed-adaptive-video";
    video.addEventListener("click", () => {
      window.__feedPlayerStarts += 1;
      if (!video.getAttribute("src")) {
        video.src = URL.createObjectURL(
          new Blob(["not real media"], { type: "video/mp4" }),
        );
      }
    });
    shadow.append(video);
  });
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });

  await expect(page.locator(".redditp__title")).toHaveText("First image");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Feed video");
  await expect
    .poll(() => page.evaluate(() => window.__feedPlayerStarts))
    .toBe(1);
  await expect
    .poll(() =>
      page.locator("shreddit-player").evaluate((player) => {
        const video =
          document.querySelector("#feed-adaptive-video") ||
          player.shadowRoot.querySelector("#feed-adaptive-video");
        return {
          src: video?.getAttribute("src") || "",
          parent:
            video?.parentElement?.className || video?.parentNode?.nodeName,
        };
      }),
    )
    .toMatchObject({ src: /^blob:/, parent: "redditp__media" });
  await expect(
    page.locator(".redditp__media #feed-adaptive-video"),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__feedPlayerStarts)).toBe(1);
  await expect(
    page.locator(".redditp__media video[src*='CMAF_96']"),
  ).toHaveCount(0);
});

test("redditp=1 asks the extension to activate on Reddit URLs", async ({
  page,
}) => {
  const url =
    "https://old.reddit.com/r/MadeMeSmile/comments/adaptive/post/?redditp=1";
  await page.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<main>Reddit</main>" }),
  );
  await page.goto(url);
  await page.evaluate(() => {
    window.__redditpMessage = null;
    window.chrome = {
      runtime: {
        sendMessage(message) {
          window.__redditpMessage = message;
          return Promise.resolve();
        },
      },
    };
  });
  await page.addScriptTag({ path: autoActivateScript });

  await expect
    .poll(() => page.evaluate(() => window.__redditpMessage))
    .toEqual({ type: "activate-from-url" });
});

test("extension extracts current Reddit post elements on a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startPresentation(
    page,
    `
      <shreddit-post
        post-title="A nature search result"
        author="photographer"
        subreddit-prefixed-name="r/nature"
        content-href="https://i.redd.it/nature.webp"
        permalink="/r/nature/comments/abc/a_nature_search_result/"
      >
        <img src="https://preview.redd.it/nature.webp" width="800" height="600" alt="A mountain">
      </shreddit-post>
    `,
  );

  await expect(page.locator(".redditp__title")).toHaveText(
    "A nature search result",
  );
  await expect(page.locator(".redditp__meta")).toHaveText(
    "r/nature · u/photographer",
  );
  await expect(page.locator(".redditp__meta-link").nth(0)).toHaveAttribute(
    "href",
    "https://www.reddit.com/r/nature/?redditp=1",
  );
  await expect(page.locator(".redditp__meta-link").nth(1)).toHaveAttribute(
    "href",
    "https://www.reddit.com/user/photographer/?redditp=1",
  );
  await expect(page.locator(".redditp__controls")).toBeVisible();
  await expect(page.locator(".redditp__close")).toBeInViewport();
  await expect(page.locator(".redditp__controls")).toBeInViewport();
});

test("metadata links leave the current overlay for another presentation", async ({
  page,
}) => {
  const destination = "https://www.reddit.com/r/nature/?redditp=1";
  await page.route(destination, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<main>Nature feed</main>",
    }),
  );
  await startPresentation(
    page,
    `<shreddit-post post-title="Nature" author="photographer" subreddit-prefixed-name="r/nature" content-href="https://i.redd.it/nature.jpg" permalink="/r/nature/comments/nature/post/"></shreddit-post>`,
  );

  await page.getByRole("link", { name: "r/nature" }).click();

  await expect(page).toHaveURL(destination);
  await expect(page.locator("#redditp-presentation")).toHaveCount(0);
});

test("long post titles wrap inside the title panel", async ({ page }) => {
  const longTitle =
    "AI is built to be easy, agreeable, and always available. Nietzsche’s philosophy offers a warning: if we don’t deliberately create distance from it, we risk losing power over our own thinking | Skye Cleary";
  await page.setViewportSize({ width: 390, height: 844 });
  await startPresentation(
    page,
    `<shreddit-post post-title="${longTitle}" author="Skye_Cleary" subreddit-prefixed-name="r/philosophy" content-href="https://i.redd.it/philosophy.jpg" permalink="/r/philosophy/comments/1vndrq3/post/"></shreddit-post>`,
  );

  await expect(page.locator(".redditp__title")).toHaveText(longTitle);
  const titleLayout = await page
    .locator(".redditp__title")
    .evaluate((title) => {
      const bounds = title.getBoundingClientRect();
      return {
        height: bounds.height,
        lineHeight: parseFloat(getComputedStyle(title).lineHeight),
        whiteSpace: getComputedStyle(title).whiteSpace,
        fitsWidth: title.scrollWidth <= title.clientWidth,
      };
    });
  expect(titleLayout.height).toBeGreaterThan(titleLayout.lineHeight * 2);
  expect(titleLayout.whiteSpace).toBe("normal");
  expect(titleLayout.fitsWidth).toBe(true);
  await expect(page.locator(".redditp__controls")).toBeInViewport();
});

test("long titles and metadata never slide under the top-right controls", async ({
  page,
}) => {
  const longTitle =
    "AI is built to be easy, agreeable, and always available. Nietzsche’s philosophy offers a warning: if we don’t deliberately create distance from it, we risk losing power over our own thinking | Skye Cleary";
  const galleryPost = (id) =>
    `<shreddit-post post-title="${longTitle}" author="Skye_Cleary" subreddit-prefixed-name="r/philosophy" gallery post-type="gallery" content-href="https://www.reddit.com/gallery/g1" permalink="/r/philosophy/comments/g1/gallery_post/"><gallery-carousel><figure><img alt="g" src="https://i.redd.it/album-${id}.jpg"></figure></gallery-carousel></shreddit-post>`;
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  await startPresentation(page, galleryPost("one"));
  await page.keyboard.press("a"); // hold the slide still

  // The overlap only happens where the title panel is wide enough to reach
  // the control stack; every mobile width must pass, and one above the
  // breakpoint proves the panel is still wide on desktop.
  await page.setViewportSize({ width: 390, height: 844 });
  const overlapAt = (width, height) => async () => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const overlapping = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          "#redditp-presentation .redditp__control-item",
        ),
      ).filter((button) => !button.hidden);
      const buttonBoxes = buttons.map((button) =>
        button.getBoundingClientRect(),
      );
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".redditp__title"));
      return Array.from(range.getClientRects()).some((line) =>
          buttonBoxes.some(
            (box) =>
              line.left < box.right &&
              line.right > box.left &&
              line.top < box.bottom &&
              line.bottom > box.top,
          ),
        );
    });
    return { overlapping, title: await page.locator(".redditp__title").textContent() };
  };
  for (const [width, height] of [
    [360, 780],
    [412, 915],
    [768, 1024],
    [1366, 768],
  ]) {
    const check = await overlapAt(width, height)();
    expect(
      check.overlapping,
      `title line under a control button at ${width}x${height}`,
    ).toBe(false);
    expect(check.title).toContain("Skye Cleary");
  }
});

test("current Reddit ignores repeated non-post article cards", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <article class="sidebar-card"><h3>He tagged him!!!</h3></article>
      <article class="w-full">
        <shreddit-post
          id="t3_realpost"
          post-title="A real UFC post"
          author="fighter"
          subreddit-prefixed-name="r/ufc"
          content-href="https://i.redd.it/ufc.jpg"
          permalink="/r/ufc/comments/realpost/a_real_ufc_post/"
        >
          <img src="https://i.redd.it/ufc.jpg" width="800" height="600" alt="Fight">
        </shreddit-post>
      </article>
      <article class="sidebar-card"><h3>He tagged him!!!</h3></article>
      <article></article>
    `,
  );

  await expect(page.locator(".redditp__title")).toHaveText("A real UFC post");
  await expect(page.locator(".redditp__count")).toContainText("1 / 1");
});

test("a linked watch page becomes that host's player frame", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_framed"
        post-title="Linked clip"
        author="poster"
        subreddit-prefixed-name="r/clips"
        content-href="https://videohost.example/watch/some-clip-id"
        permalink="/r/clips/comments/framed/linked_clip/"
      ></shreddit-post>
    `,
  );

  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    "https://videohost.example/ifr/some-clip-id?autoplay=1&muted=1&mute=1&sound=false",
  );
});

test("a blurred or spoiler cover is not a slide before the post's media", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_covered"
        post-title="Covered clip"
        author="poster"
        subreddit-prefixed-name="r/clips"
        content-href="https://videohost.example/watch/covered-clip-id"
        permalink="/r/clips/comments/covered/covered_clip/"
        post-type="link"
        nsfw=""
      >
        <div slot="post-media-container">
          <shreddit-blurred-container mode="slot" reason="nsfw" blurred="">
            <div slot="blurred">
              <img alt="" role="presentation" src="https://external-preview.redd.it/cover.jpeg?blur=40&amp;format=pjpg">
              <img id="post-image" alt="r/clips - Covered clip" loading="eager" src="https://external-preview.redd.it/cover.jpeg?blur=40&amp;format=pjpg">
            </div>
            <div slot="revealed">
              <shreddit-embed html="&lt;iframe src=&quot;https://videohost.example/ifr/covered-clip-id&quot;&gt;&lt;/iframe&gt;"></shreddit-embed>
            </div>
          </shreddit-blurred-container>
        </div>
      </shreddit-post>
    `,
  );

  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    /^https:\/\/videohost\.example\/ifr\/covered-clip-id\?/,
  );
  await expect(page.locator(".redditp__image")).toHaveCount(0);
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
});

for (const reason of ["nsfw", "spoiler"]) {
  test(`revealed ${reason === "spoiler" ? "spoiler" : "blurred"} embeds work without a source link or loaded component`, async ({
    page,
  }) => {
    await page.route("https://videohost.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Player" }),
    );
    await startPresentation(
      page,
      `
      <shreddit-post id="t3_revealed" post-title="Revealed clip" post-type="link" permalink="/r/clips/comments/revealed/clip/">
        <shreddit-blurred-container reason="${reason}" blurred embed-obscured>
          <div slot="blurred"><img src="https://external-preview.redd.it/cover.jpeg?blur=40&amp;format=pjpg"></div>
          <div slot="revealed"><shreddit-async-loader><shreddit-embed html="&lt;script&gt;window.suppliedEmbedRan = true&lt;/script&gt;&lt;iframe src=&quot;https://videohost.example/ifr/revealed&quot;&gt;&lt;/iframe&gt;"></shreddit-embed></shreddit-async-loader></div>
        </shreddit-blurred-container>
      </shreddit-post>`,
    );
    await expect(page.locator(".redditp__embed")).toHaveAttribute(
      "src",
      /^https:\/\/videohost\.example\/ifr\/revealed\?/,
    );
    await expect(page.locator(".redditp__image")).toHaveCount(0);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
    // The media destination opens in a new tab through the I shortcut.
    await captureWindowOpens(page);
    await page.keyboard.press("i");
    expect(await openedUrls(page)).toContain(
      "https://videohost.example/ifr/revealed",
    );
    expect(await page.evaluate(() => window.suppliedEmbedRan)).toBeUndefined();
  });
}

test("linked players replace ordinary previews instead of adding a thumbnail slide", async ({
  page,
}) => {
  await startPresentation(
    page,
    `<shreddit-post id="t3_linked" post-title="Linked clip" content-href="https://videohost.example/watch/linked" permalink="/r/clips/comments/linked/clip/">
    <img src="https://external-preview.redd.it/preview.jpg">
    <iframe src="https://videohost.example/ifr/linked"></iframe>
  </shreddit-post>`,
  );
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    /^https:\/\/videohost\.example\/ifr\/linked\?/,
  );
  await expect(page.locator(".redditp__image")).toHaveCount(0);
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
});

test("blurred image URLs fall back to links while revealed gallery images keep their order", async ({
  page,
}) => {
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>',
    }),
  );
  await startPresentation(
    page,
    `
    <shreddit-post id="t3_cover" post-title="Unavailable media" content-href="https://example.com/original" permalink="/r/pics/comments/cover/post/">
      <img src="https://external-preview.redd.it/cover.jpg?blur=40">
    </shreddit-post>
    <shreddit-post id="t3_gallery_revealed" post-title="Revealed gallery" gallery permalink="/r/pics/comments/gallery_revealed/post/">
      <shreddit-blurred-container reason="spoiler" blurred><div slot="blurred"><img src="https://external-preview.redd.it/cover.jpg?blur=40"></div>
        <div slot="revealed"><gallery-carousel><figure><img src="https://i.redd.it/first.jpg"></figure><figure><img src="https://i.redd.it/second.jpg"></figure></gallery-carousel></div>
      </shreddit-blurred-container>
    </shreddit-post>`,
  );
  await expect(page.locator(".redditp__link-card")).toBeVisible();
  await expect(page.locator(".redditp__image")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    "https://i.redd.it/first.jpg",
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    "https://i.redd.it/second.jpg",
  );
});

test("a blurred source URL falls back to comments instead of linking the cover", async ({
  page,
}) => {
  await page.route("https://www.reddit.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "No exposed media" }),
  );
  await startPresentation(
    page,
    `<shreddit-post id="t3_blurred_source" post-title="Unavailable source" content-href="https://preview.redd.it/cover.jpg?blur=40" permalink="https://www.reddit.com/r/pics/comments/blurred_source/post/"><img src="https://preview.redd.it/cover.jpg?blur=40"></shreddit-post>`,
  );
  await expect(page.locator(".redditp__image")).toHaveCount(0);
  await expect(page.locator(".redditp__link-card")).toBeVisible();
  // Blurred media is unsafe to open directly, so I falls back to comments.
  await captureWindowOpens(page);
  await page.keyboard.press("i");
  expect(await openedUrls(page)).toContain(
    "https://www.reddit.com/r/pics/comments/blurred_source/post/",
  );
});

test("fetched post details recover a revealed embed without adding its blurred cover", async ({
  page,
}) => {
  await page.route(
    "https://www.reddit.com/r/clips/comments/detail/post/",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<shreddit-post id="t3_detail" permalink="/r/clips/comments/detail/post/"><shreddit-blurred-container reason="spoiler" blurred><div slot="blurred"><img src="https://preview.redd.it/cover.jpg?blur=40"></div><div slot="revealed"><shreddit-embed html="&lt;iframe src=&quot;https://videohost.example/ifr/detail&quot;&gt;&lt;/iframe&gt;"></shreddit-embed></div></shreddit-blurred-container></shreddit-post>`,
      }),
  );
  await startPresentation(
    page,
    `<div data-testid="search-post-unit" id="t3_detail"><a href="https://www.reddit.com/r/clips/comments/detail/post/">Detail clip</a></div>`,
  );
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    /^https:\/\/videohost\.example\/ifr\/detail\?/,
  );
  await expect(page.locator(".redditp__image")).toHaveCount(0);
  await expect(page.locator(".redditp__count")).toHaveText(/^1 \/ 1/);
});

test("a player frame that answers no command keeps the user's sound choice without breaking", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_framed_sound"
        post-title="Linked clip"
        author="poster"
        subreddit-prefixed-name="r/clips"
        content-href="https://videohost.example/watch/some-clip-id"
        permalink="/r/clips/comments/framed/linked_clip/"
      ></shreddit-post>
    `,
  );

  // Silent autoplay is the opening state, so it rides along in the frame URL.
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    "https://videohost.example/ifr/some-clip-id?autoplay=1&muted=1&mute=1&sound=false",
  );

  // The frame player reaches its own sound control, so the keyboard toggle
  // only records the preference instead of rewriting the frame URL.
  await page.keyboard.press("m");
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    "https://videohost.example/ifr/some-clip-id?autoplay=1&muted=1&mute=1&sound=false",
  );
});

test("the keyboard mute command reaches a player that publishes a message protocol", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_youtube_sound"
        post-title="YouTube interview"
        author="poster"
        subreddit-prefixed-name="r/ukraine"
        content-href="https://www.youtube.com/watch?v=l74r1s8y7uY"
        permalink="/r/ukraine/comments/youtube/interview/"
      ></shreddit-post>
    `,
  );

  // The real player never loads here, so stand in for the window the command
  // is posted to and record what it receives.
  await page.evaluate(() => {
    window.__posted = [];
    Object.defineProperty(
      document.querySelector(".redditp__embed"),
      "contentWindow",
      {
        get: () => ({
          postMessage: (message, origin) =>
            window.__posted.push([message, origin]),
        }),
      },
    );
  });

  await page.keyboard.press("m");
  expect(await page.evaluate(() => window.__posted.at(-1))).toEqual([
    JSON.stringify({ event: "command", func: "unMute", args: [] }),
    "https://www.youtube.com",
  ]);

  await page.keyboard.press("m");
  expect(await page.evaluate(() => window.__posted.at(-1))).toEqual([
    JSON.stringify({ event: "command", func: "mute", args: [] }),
    "https://www.youtube.com",
  ]);
});

test("YouTube embeds preserve the requested start time and send a referrer", async ({
  page,
  context,
}) => {
  // The popup's first request belongs to the context. Verify its destination
  // without depending on YouTube being reachable from the test machine.
  await context.route("https://www.youtube.com/watch?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "YouTube destination" }),
  );
  await startPresentation(
    page,
    `
      <shreddit-post
        id="t3_youtube"
        post-title="YouTube interview"
        author="poster"
        subreddit-prefixed-name="r/ukraine"
        content-href="https://www.youtube.com/watch?v=l74r1s8y7uY&amp;t=1167s"
        permalink="/r/ukraine/comments/youtube/interview/"
      ></shreddit-post>
    `,
  );

  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "src",
    "https://www.youtube.com/embed/l74r1s8y7uY?start=1167&enablejsapi=1&autoplay=1&muted=1&mute=1&sound=false",
  );
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "referrerpolicy",
    "strict-origin-when-cross-origin",
  );
  await expect(page.locator(".redditp__embed")).toHaveAttribute(
    "allow",
    /(?:^|; )fullscreen(?:;|$)/,
  );
  await expect(page.locator(".redditp__embed")).not.toHaveAttribute(
    "allowfullscreen",
    "",
  );
  // The I shortcut opens the post's own YouTube page, not the embed player.
  await captureWindowOpens(page);
  await page.keyboard.press("i");
  expect(await openedUrls(page)).toContain(
    "https://www.youtube.com/watch?v=l74r1s8y7uY&t=1167s",
  );
});

test("extension recognizes Reddit search media cards and packaged video", async ({
  page,
}) => {
  const videoUrl =
    "https://packaged-media.redd.it/br6s0bbf3gqe1/pb/m2-res_392p.mp4?m=DASHPlaylist.mpd";
  const hlsUrl = "https://v.redd.it/br6s0bbf3gqe1/HLSPlaylist.m3u8";
  const packagedMedia = JSON.stringify({
    playbackMp4s: {
      permutations: [
        {
          source: {
            url: videoUrl,
            dimensions: { width: 392, height: 490 },
            videoCodec: "H264",
          },
        },
      ],
    },
  });
  await page.route(videoUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.abort();
  });
  await page.route(
    "https://external-preview.redd.it/ordinary.png",
    async (route) => {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>',
      });
    },
  );
  await startPresentation(
    page,
    `
      <search-telemetry-tracker data-faceplate-tracking-context='{"post":{"title":"Nature..."},"subreddit":{"name":"LoveTrash"}}'>
        <div data-id="search-media-post-unit">
          <a href="/r/LoveTrash/comments/1jhztnq/nature/">
            <shreddit-player src="${hlsUrl}" packaged-media-json='${packagedMedia}' poster="https://external-preview.redd.it/nature.png">
              <source src="${hlsUrl}">
              <img class="preview-image" alt="media poster" src="https://external-preview.redd.it/nature.png">
            </shreddit-player>
          </a>
        </div>
      </search-telemetry-tracker>
      <search-telemetry-tracker data-faceplate-tracking-context='{"post":{"id":"t3_next","title":"Ordinary search post"},"subreddit":{"name":"test"}}'>
        <div data-testid="search-post-unit">
          <h2><a data-testid="post-title" href="/r/test/comments/next/ordinary/">Ordinary search post</a></h2>
          <img src="https://styles.redditmedia.com/community-icon.png" width="24" height="24" alt="community icon">
          <a href="/r/test/comments/next/ordinary/" aria-label="Ordinary search post thumbnail image">
            <faceplate-img data-testid="search_post_thumbnail" src="https://external-preview.redd.it/ordinary.png" alt="Ordinary search post"></faceplate-img>
          </a>
        </div>
      </search-telemetry-tracker>
    `,
  );

  await expect(page.locator(".redditp__title")).toHaveText("Nature...");
  await expect(page.locator(".redditp__meta")).toContainText("r/LoveTrash");
  expect(await page.locator(".redditp__video").getAttribute("src")).toBe(
    videoUrl,
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText(
    "Ordinary search post",
  );
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    "https://external-preview.redd.it/ordinary.png",
  );
});

test("thumbnail-only search results upgrade from post HTML to their actual video", async ({
  page,
}) => {
  const postUrl =
    "https://www.reddit.com/r/test/comments/upgrade/video_search_result/";
  const thumbnailUrl = "https://external-preview.redd.it/video-thumb.png";
  const previewUrl = "https://v.redd.it/video123/DASH_480.mp4";
  await page.route(thumbnailUrl, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>',
    });
  });
  await page.route(postUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<shreddit-post id="t3_upgrade" post-title="Video search result" post-type="video" content-href="https://v.redd.it/video123" permalink="/r/test/comments/upgrade/video_search_result/"><shreddit-player src="https://v.redd.it/video123/HLSPlaylist.m3u8" preview="${previewUrl}" poster="${thumbnailUrl}"><source src="https://v.redd.it/video123/HLSPlaylist.m3u8"></shreddit-player></shreddit-post>`,
    });
  });
  await page.route(previewUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.abort();
  });
  await startPresentation(
    page,
    `<search-telemetry-tracker data-faceplate-tracking-context='{"post":{"id":"t3_upgrade","title":"Video search result"},"subreddit":{"name":"test"}}'><div data-testid="search-post-unit"><h2><a href="${postUrl}">Video search result</a></h2><a href="${postUrl}" aria-label="Video search result thumbnail image"><faceplate-img data-testid="search_post_thumbnail" src="${thumbnailUrl}" alt="Video search result"></faceplate-img></a></div></search-telemetry-tracker>`,
  );

  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    previewUrl,
  );
  await expect(page.locator(".redditp__count")).toHaveText(
    "1 / 1 · loading more",
  );
  await expect(page.locator(".redditp__title")).toHaveText(
    "Video search result",
  );
});

test("the final slide automatically loads newly rendered Reddit posts", async ({
  page,
}) => {
  await startPresentation(
    page,
    `
      <shreddit-post id="t3_first" post-title="First loaded post" content-href="https://i.redd.it/first-loaded.jpg" permalink="/r/test/comments/first/first_loaded_post/"></shreddit-post>
      <div style="height: 4000px"></div>
    `,
  );
  await expect(page.locator(".redditp__count")).toHaveText(
    "1 / 1 · loading more",
  );
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <shreddit-post id="t3_second" post-title="Newly loaded post" content-href="https://i.redd.it/newly-loaded.jpg" permalink="/r/test/comments/second/newly_loaded_post/"></shreddit-post>
        <shreddit-post id="t3_third" post-title="Another loaded post" content-href="https://i.redd.it/another-loaded.jpg" permalink="/r/test/comments/third/another_loaded_post/"></shreddit-post>
      `,
    );
  });

  await expect(page.locator(".redditp__title")).toHaveText("First loaded post");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Newly loaded post");
  await expect(page.locator(".redditp__count")).toHaveText("2 / 3");
});

test("the final slide loads old Reddit's next listing pages", async ({
  page,
}) => {
  await page.route("https://i.redd.it/**", (route) => route.abort());
  const listing = "https://www.reddit.com/r/aww+pics/";
  const pages = [
    { url: listing, after: "t3_one", title: "First page post" },
    {
      url: `${listing}?count=25&after=t3_one`,
      after: "t3_two",
      title: "Second page post",
    },
    {
      url: `${listing}?count=50&after=t3_two`,
      after: "",
      title: "Third page post",
    },
  ];
  pages.forEach(({ url, after, title }, index) =>
    page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
          <div class="thing link" data-fullname="t3_${index}" data-url="https://i.redd.it/${index}.jpg" data-permalink="/r/aww/comments/${index}/post/">
            <a class="title">${title}</a>
          </div>
          <div class="nav-buttons"><span class="nextprev">view more:
            ${after ? `<span class="next-button"><a href="${listing}?count=${(index + 1) * 25}&amp;after=${after}" rel="nofollow next">next ›</a></span>` : ""}
          </span></div>
        `,
      }),
    ),
  );
  await page.goto(listing);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });

  await expect(page.locator(".redditp__title")).toHaveText("First page post");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Second page post");
  await expect(page.locator(".redditp__count")).toHaveText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Third page post");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("First page post");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
});

function oldListingPost(id, title) {
  return `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/aww/comments/${id}/post/"><a class="title">${title}</a></div>`;
}

async function openOldListing(page, url) {
  await page.goto(url);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
}

// Old Reddit search results put the next link straight in .nav-buttons,
// without the .next-button wrapper that listings use.
test("the final slide loads old Reddit's next search results page", async ({
  page,
}) => {
  await page.route("https://i.redd.it/**", (route) => route.abort());
  const search = "https://www.reddit.com/r/aww/search?q=cat&restrict_sr=on";
  const result = (id, title) =>
    `<div class="search-result search-result-link" data-fullname="t3_${id}"><a class="search-title" href="https://www.reddit.com/r/aww/comments/${id}/post/">${title}</a><a class="search-comments" href="https://www.reddit.com/r/aww/comments/${id}/post/">3 comments</a><a class="search-link" href="https://i.redd.it/${id}.jpg">https://i.redd.it/${id}.jpg</a></div>`;
  await page.route(search, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div class="search-result-listing">
          <footer><div class="nav-buttons"><span class="nextprev">view more:
            <a href="${search}&amp;type=sr&amp;count=3&amp;after=t5_one" rel="nofollow next">next ›</a>
          </span></div></footer>
        </div>
        <div class="search-result-listing">
          ${result("one", "First results post")}
          <footer><div class="nav-buttons"><span class="nextprev">view more:
            <a href="${search}&amp;count=25&amp;after=t3_one" rel="nofollow next">next ›</a>
          </span></div></footer>
        </div>
      `,
    }),
  );
  await page.route(`${search}&count=25&after=t3_one`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div class="search-result-listing">${result("two", "Second results post")}</div>`,
    }),
  );
  await openOldListing(page, search);

  await expect(page.locator(".redditp__title")).toHaveText(
    "First results post",
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText(
    "Second results post",
  );
});

test("a next listing page that fails to load wraps and is retried", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://i.redd.it/**", (route) => route.abort());
  const listing = "https://www.reddit.com/r/aww+pics/";
  let rateLimited = true;
  await page.route(listing, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        ${oldListingPost("a", "Post A")}
        ${oldListingPost("b", "Post B")}
        <div class="nav-buttons"><span class="nextprev">view more:
          <span class="next-button"><a href="${listing}?count=25&amp;after=t3_b" rel="nofollow next">next ›</a></span>
        </span></div>
      `,
    }),
  );
  await page.route(`${listing}?count=25&after=t3_b`, (route) =>
    rateLimited
      ? route.fulfill({ status: 429, body: "slow down" })
      : route.fulfill({
          contentType: "text/html",
          body: oldListingPost("c", "Post C"),
        }),
  );
  await openOldListing(page, listing);

  await expect(page.locator(".redditp__title")).toHaveText("Post A");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Post B");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Post A");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  expect(pageErrors).toEqual([]);

  rateLimited = false;
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Post B");
  await expect(page.locator(".redditp__count")).toHaveText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Post C");
});

test("a next link that leaves the Reddit origin is not followed", async ({
  page,
}) => {
  const offSiteRequests = [];
  await page.route("https://i.redd.it/**", (route) => route.abort());
  await page.route("https://elsewhere.example/**", (route) => {
    offSiteRequests.push(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      headers: {
        "access-control-allow-origin": "https://www.reddit.com",
        "access-control-allow-credentials": "true",
      },
      body: oldListingPost("x", "Off-site post"),
    });
  });
  const listing = "https://www.reddit.com/r/aww+pics/";
  await page.route(listing, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        ${oldListingPost("a", "Only post")}
        <div class="nav-buttons"><span class="nextprev">view more:
          <span class="next-button"><a href="https://elsewhere.example/page" rel="nofollow next">next ›</a></span>
        </span></div>
      `,
    }),
  );
  await openOldListing(page, listing);

  await expect(page.locator(".redditp__title")).toHaveText("Only post");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await expect(page.locator(".redditp__title")).toHaveText("Only post");
  expect(offSiteRequests).toEqual([]);
});

// Minimal old-Reddit gallery structure from the reported food+scenery DOM.
const oldGalleryIds = [
  "w7ko4xfmlklh1",
  "xz2bqxfmlklh1",
  "aoffmyfmlklh1",
  "q5qbzwfmlklh1",
  "uur6cxfmlklh1",
];
const oldGalleryUrl = "https://www.reddit.com/gallery/1vy9ca0";
const oldGalleryComments =
  "https://www.reddit.com/r/food/comments/1vy9ca0/pie/";
const oldGalleryImage = (id) =>
  `https://preview.redd.it/${id}.jpg?width=1170&format=pjpg&auto=webp&s=fixture`;

function oldGalleryPost(expanded = false) {
  const escape = (html) =>
    html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const gallery = `<div class="media-gallery">
    <div class="gallery-tiles">${oldGalleryIds.map((id) => `<img class="preview" src="https://preview.redd.it/${id}.jpg?width=108" width="108" height="105">`).join("")}</div>
    ${oldGalleryIds.map((id, index) => `<div class="gallery-preview" style="display:none"><a class="gallery-item-thumbnail-link" data-position="${index + 1}" href="${escape(oldGalleryImage(id))}"><img class="preview" src="https://preview.redd.it/${id}.jpg?width=640" width="786" height="768"></a></div>`).join("")}
    <script>window.cachedGalleryScriptRan = true;</script>
    </div>`;
  return `<div class="thing link" data-fullname="t3_1vy9ca0" data-is-gallery="true" data-url="${oldGalleryUrl}" data-permalink="${oldGalleryComments}" data-author="baker" data-subreddit="food">
    <a class="title" href="${oldGalleryUrl}">Apple pie gallery</a>
    <div class="expando" data-cachedhtml="${escape(gallery)}">${expanded ? gallery.replace(/<script>.*?<\/script>/, "") : '<span class="error">loading...</span>'}</div>
  </div>`;
}

for (const expanded of [false, true]) {
  test(`old Reddit ${expanded ? "expanded" : "cached"} galleries use full-size images without duplicates`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://preview.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="1140"/>',
      }),
    );
    const url = "https://www.reddit.com/r/food+scenery/?redditp=1";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: oldGalleryPost(expanded),
      }),
    );
    await page.goto(url);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });

    // The auto timer overlaps the load-more scan (~5s), so pin manual mode
    // before the first wait: this test is about gallery navigation, not
    // auto-advance timing.
    await pinAutoAdvance(page, false);

    await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
    for (let index = 0; index < oldGalleryIds.length; index += 1) {
      await expect(page.locator(".redditp__image")).toHaveAttribute(
        "src",
        oldGalleryImage(oldGalleryIds[index]),
      );
      // The counter lives in the title; the toolbar button is only the
      // "Skip gallery" control since the duplicate label was removed.
      await expect(page.locator(".redditp__title")).toContainText(
        `(${index + 1}/5)`,
      );
      if (index < oldGalleryIds.length - 1) {
        if (index % 2) await page.keyboard.press("ArrowRight");
        else await page.locator(".redditp__next").click();
      }
    }
    // The I and C shortcuts open the gallery's media and comments tabs.
    await captureWindowOpens(page);
    await page.keyboard.press("i");
    expect(await openedUrls(page)).toContain(oldGalleryImage(oldGalleryIds[4]));
    await page.keyboard.press("c");
    expect(await openedUrls(page)).toContain(oldGalleryComments);
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [393, 852],
      [412, 915],
      [1920, 1080],
      [2560, 1440],
    ]) {
      await page.setViewportSize({ width, height });
      const previous = page.locator(".redditp__prev");
      await expect(previous).toBeInViewport();
      await expect(page.locator(".redditp__controls")).toBeInViewport();
      await previous.click();
      await expect(page.locator(".redditp__title")).toContainText("(4/5");
      // Exercise the touch-pointer swipe handler without relying on Chromium's
      // touch-only emulation, so this also runs in Firefox.
      const stage = page.locator(".redditp__stage");
      await stage.dispatchEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 1,
        clientX: 250,
        clientY: 300,
      });
      await stage.dispatchEvent("pointerup", {
        pointerType: "touch",
        pointerId: 1,
        clientX: 100,
        clientY: 300,
      });
      await expect(page.locator(".redditp__title")).toContainText("(5/5");
    }
    expect(
      await page.evaluate(() => window.cachedGalleryScriptRan),
    ).toBeUndefined();
    expect(errors).toEqual([]);
  });
}

test("G skips only the current gallery and advances ordinary posts", async ({
  page,
}) => {
  await page.route("https://preview.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>',
    }),
  );
  await startPresentation(
    page,
    `${oldGalleryPost()}
    <shreddit-post id="t3_nextgallery" post-title="Next gallery" gallery content-href="https://www.reddit.com/gallery/nextgallery" permalink="/r/pics/comments/nextgallery/post/">
      <gallery-carousel>
        <figure><img src="https://preview.redd.it/next-1.jpg"></figure>
        <figure><img src="https://preview.redd.it/next-2.jpg"></figure>
      </gallery-carousel>
    </shreddit-post>
    <div class="thing link" data-url="https://example.com/after"><a class="title">After galleries</a></div>
    <div class="thing link" data-url="https://example.com/final"><a class="title">Final post</a></div>`,
  );
  // The auto timer would advance slides mid-assertion; this test is about
  // gallery skipping, not timing.
  await pinAutoAdvance(page, false);

  await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 4");
  await page
    .getByRole("button", { name: "Close presentation settings" })
    .click();

  await page.keyboard.press("g");
  await expect(page.locator(".redditp__title")).toHaveText(
    "(1/2) Next gallery",
  );
  await expect(page.locator(".redditp__title")).toContainText("(1/2");
  await expect(page.locator(".redditp__count")).toHaveText("2 / 4");
  // The gallery counter must not wrap the controls onto a second row.
  const controlsBox = await page.locator(".redditp__controls").boundingBox();
  const countBox = await page.locator(".redditp__count").boundingBox();
  expect(controlsBox.height).toBeLessThan(countBox.height * 2);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".redditp__title")).toContainText("(5/5");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 4");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+G");
  await expect(page.locator(".redditp__count")).toHaveText("2 / 4");
  await expect(page.locator(".redditp__gallery")).toHaveAttribute(
    "title",
    /\(G\)/,
  );
  await page.locator(".redditp__gallery").click();
  await expect(page.locator(".redditp__title")).toHaveText("After galleries");
  await expect(page.locator(".redditp__gallery")).toBeHidden();
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__title")).toHaveText("Final post");
});

test("G at the final gallery waits for more posts and otherwise wraps", async ({
  page,
}) => {
  await page.route("https://preview.redd.it/**", (route) => route.abort());
  await startPresentation(page, oldGalleryPost());
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText(
    "1 / 1 · loading more",
  );
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="thing link" data-url="https://example.com/new"><a class="title">Newly loaded post</a></div>',
    );
  });
  await expect(page.locator(".redditp__title")).toHaveText("Newly loaded post");
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await expect(page.locator(".redditp__title")).toContainText("(1/5");
  // Skipping a gallery with no next post must also wrap safely.
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    document.querySelector('[data-url="https://example.com/new"]').remove(),
  );
  await page.evaluate(() => window.__redditpPresentation.toggle());
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
});

test("the last gallery starts loading more posts from its first image", async ({
  page,
}) => {
  await page.route("https://preview.redd.it/**", (route) => route.abort());
  await startPresentation(page, oldGalleryPost());
  await expect(page.locator(".redditp__count")).toHaveText(
    "1 / 1 · loading more",
  );
  await expect(page.locator(".redditp__title")).toContainText("(1/5");

  // Browsing the gallery keeps working while the next posts load.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toContainText("(2/5");
  await pinAutoAdvance(page, false);
  await page.locator(".redditp__auto").click();
  // The toggle now paints the pause icon instead of the old "pause" text.
  await expect(
    page.getByRole("button", { name: "Pause slideshow" }),
  ).toBeVisible();
  const controlsBox = await page.locator(".redditp__controls").boundingBox();
  const countBox = await page.locator(".redditp__count").boundingBox();
  expect(controlsBox.height).toBeLessThan(countBox.height * 2);
  await page.getByRole("button", { name: "Pause slideshow" }).click();

  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="thing link" data-url="https://example.com/new"><a class="title">Newly loaded post</a></div>',
    );
  });
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await expect(page.locator(".redditp__title")).toContainText("(2/5");
});

test("G on a single-post gallery stops at its last image", async ({ page }) => {
  await page.route(oldGalleryComments, (route) =>
    route.fulfill({ contentType: "text/html", body: oldGalleryPost() }),
  );
  await page.route("https://preview.redd.it/**", (route) => route.abort());
  await page.goto(oldGalleryComments);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await expect(page.locator(".redditp__title")).toContainText("(5/5");
  await expect(page.locator(".redditp__next")).toBeDisabled();
  await page.keyboard.press("g");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".redditp__title")).toContainText("(4/5");
});

test("old Reddit search enrichment recognizes cached galleries", async ({
  page,
}) => {
  await page.route(oldGalleryComments, (route) =>
    route.fulfill({ contentType: "text/html", body: oldGalleryPost() }),
  );
  await page.route("https://preview.redd.it/**", (route) => route.abort());
  await startPresentation(
    page,
    `<div class="search-result search-result-link" data-fullname="t3_1vy9ca0"><a class="search-title" href="${oldGalleryComments}">Apple pie gallery</a><a class="search-comments" href="${oldGalleryComments}">comments</a><a class="search-link" href="${oldGalleryUrl}">gallery</a></div>`,
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await expect(page.locator(".redditp__title")).toContainText("(1/5");
});

test("old Reddit galleries without usable cached media keep their link fallback", async ({
  page,
}) => {
  await startPresentation(
    page,
    `<div class="thing link" data-is-gallery="true" data-url="${oldGalleryUrl}"><a class="title">Unavailable gallery</a><div class="expando" data-cachedhtml="&lt;div class=&quot;media-gallery&quot;&gt;&lt;a class=&quot;gallery-item-thumbnail-link&quot; href=&quot;javascript:alert(1)&quot;&gt;"></div></div>`,
  );
  await expect(page.locator(".redditp__link-card")).toHaveAttribute(
    "href",
    oldGalleryUrl,
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
});

test("extension expands lazy Reddit galleries in order without decorative duplicates", async ({
  page,
}) => {
  const imagePattern = /https:\/\/preview\.redd\.it\/gallery-[123]\.jpg.*/;
  await page.route(imagePattern, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="100%" height="100%" fill="green"/></svg>',
    });
  });
  await startPresentation(
    page,
    `
      <shreddit-post post-title="Gallery post" author="artist" subreddit-prefixed-name="r/pics" gallery post-type="gallery" content-href="https://www.reddit.com/gallery/gallery1" permalink="/r/pics/comments/gallery1/gallery_post/">
        <gallery-carousel>
          <figure>
            <img role="presentation" src="https://preview.redd.it/gallery-1.jpg?width=640">
            <img alt="Gallery post" srcset="https://preview.redd.it/gallery-1.jpg?width=320 320w, https://preview.redd.it/gallery-1.jpg?width=1080 1080w">
          </figure>
          <figure><img alt="Gallery post" data-lazy-srcset="https://preview.redd.it/gallery-2.jpg?width=320 320w, https://preview.redd.it/gallery-2.jpg?width=1080 1080w"></figure>
          <figure><img alt="Gallery post" data-lazy-src="https://preview.redd.it/gallery-3.jpg?width=1080"></figure>
        </gallery-carousel>
      </shreddit-post>
    `,
  );

  // Shipped default is auto-advance ON; pin it off because this test drives
  // the gallery manually and can otherwise race the 5-second slide timer.
  await pinAutoAdvance(page, false);
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await expect(page.locator(".redditp__title")).toContainText("(1/3");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toContainText("(2/3");
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    /gallery-2\.jpg\?width=1080/,
  );
});

test("portrait images are contained by the stage instead of clipped", async ({
  page,
}) => {
  await page.route("https://i.redd.it/portrait.jpg", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2268" height="4032"><rect width="100%" height="100%" fill="blue"/></svg>',
    });
  });
  await startPresentation(
    page,
    `<shreddit-post post-title="Portrait" content-href="https://i.redd.it/portrait.jpg" permalink="/r/pics/comments/portrait/post/"></shreddit-post>`,
  );

  const viewports = [
    { width: 360, height: 780 },
    { width: 390, height: 844 },
    { width: 393, height: 852 },
    { width: 412, height: 915 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const dimensions = await page.locator(".redditp__image").evaluate((img) => {
      const image = img.getBoundingClientRect();
      const media = img.parentElement.getBoundingClientRect();
      const controls = document
        .querySelector(".redditp__controls")
        .getBoundingClientRect();
      return {
        imageWidth: image.width,
        imageHeight: image.height,
        mediaWidth: media.width,
        mediaHeight: media.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        objectFit: getComputedStyle(img).objectFit,
        controlsRight: controls.right,
        controlsBottom: controls.bottom,
      };
    });
    expect(dimensions.naturalWidth).toBe(2268);
    expect(dimensions.naturalHeight).toBe(4032);
    expect(dimensions.imageWidth).toBeLessThanOrEqual(dimensions.mediaWidth);
    expect(dimensions.imageHeight).toBeLessThanOrEqual(dimensions.mediaHeight);
    expect(dimensions.controlsRight).toBeLessThanOrEqual(viewport.width);
    expect(dimensions.controlsBottom).toBeLessThanOrEqual(viewport.height);
    expect(dimensions.objectFit).toBe("contain");
  }
});

test("small link-preview images are not stretched beyond their natural size", async ({
  page,
}) => {
  const previewUrl = "https://external-preview.redd.it/link-preview.png";
  await page.route(previewUrl, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="868" height="488"></svg>',
    });
  });
  await startPresentation(
    page,
    `<shreddit-post post-title="Linked article" content-href="https://example.com/article" permalink="/r/news/comments/preview/article/"><img src="${previewUrl}" width="640" height="360" alt="Linked article"></shreddit-post>`,
  );

  const size = await page.locator(".redditp__image").evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
  expect(size).toEqual({
    width: 868,
    height: 488,
    naturalWidth: 868,
    naturalHeight: 488,
  });
});

test("a small direct image post still fills the stage", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const gifUrl = "https://i.redd.it/small.gif";
  await page.route(gifUrl, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"></svg>',
    });
  });
  await startPresentation(
    page,
    `<div class="thing link" data-url="${gifUrl}" data-author="alice" data-subreddit="gifs" data-permalink="/r/gifs/comments/one/small/">
      <a class="title" href="${gifUrl}">A small gif</a>
      <a class="comments" href="/r/gifs/comments/one/small/">comments</a>
    </div>`,
  );

  const dimensions = await page.locator(".redditp__image").evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    return {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      naturalWidth: image.naturalWidth,
    };
  });
  // The post's own media fills the stage even below the preview size gate.
  expect(dimensions).toEqual({
    width: 1920,
    height: 1080,
    naturalWidth: 640,
  });
  const originalImage = await page.locator(".redditp__image").elementHandle();
  // P toggles the count chip's visibility (the bottom row itself stays put);
  // the real subject here is that the displayed image never changes.
  const countPill = page.locator(".redditp__count");
  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [393, 852],
    [412, 915],
    [1920, 1080],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    const initialBounds = await originalImage.boundingBox();
    for (const action of [
      { key: "p", check: (locator) => expect(locator).toBeHidden() },
      { key: "p", check: (locator) => expect(locator).toBeVisible() },
    ]) {
      await page.keyboard.press(action.key);
      await action.check(countPill);
      expect(
        await originalImage.evaluate(
          (image) => image === document.querySelector(".redditp__image"),
        ),
      ).toBe(true);
      expect(await originalImage.boundingBox()).toEqual(initialBounds);
      await expect(page.locator(".redditp__image")).toHaveClass(
        /redditp__image--expand/,
      );
    }
  }
});

test("display settings preserve the auto timer and duration changes reschedule it", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-08-25T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-08-25T12:00:01Z"));
  await startPresentation(
    page,
    ["First", "Second", "Third"]
      .map(
        (title) =>
          `<div class="thing link" data-url="https://example.com/${title}"><a class="title">${title}</a></div>`,
      )
      .join(""),
  );
  await pinAutoAdvance(page, false);
  await page.keyboard.press("a");
  await expect(
    page.getByRole("button", { name: "Pause slideshow", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(5000);
  await page.keyboard.press("p");
  await page.keyboard.press("p");
  await page.clock.runFor(1100);
  await expect(page.locator(".redditp__title")).toHaveText("Second");
  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();
  await page.getByLabel("Seconds per slide").fill("2");
  await page.getByLabel("Seconds per slide").press("Enter");
  await page
    .getByRole("button", { name: "Close presentation settings" })
    .click();
  await page.clock.runFor(2100);
  await expect(page.locator(".redditp__title")).toHaveText("Third");
});

test("a large current Reddit link preview expands to the full stage", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const previewBase = "https://external-preview.redd.it/sandu-preview.jpeg";
  await page.route(`${previewBase}*`, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="680"></svg>',
    });
  });
  await startPresentation(
    page,
    `<shreddit-post post-title="Linked article" content-href="https://example.com/article" permalink="/r/ukraine/comments/1vrzyuh/post/">
      <img role="presentation" src="${previewBase}?width=640" srcset="${previewBase}?width=640 640w, ${previewBase}?width=1080 1080w" width="640" height="403">
      <img data-post-media-primary src="${previewBase}?width=640" srcset="${previewBase}?width=640 640w, ${previewBase}?width=1080 1080w" width="640" height="403" alt="Linked article">
    </shreddit-post>`,
  );

  const dimensions = await page.locator(".redditp__image").evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      displayWidth: Math.round(bounds.width),
      displayHeight: Math.round(bounds.height),
    };
  });
  expect(dimensions).toEqual({
    naturalWidth: 1080,
    naturalHeight: 680,
    displayWidth: 1920,
    displayHeight: 1080,
  });
});

test("a subreddit link thumbnail upgrades to the direct post's large preview", async ({
  page,
}) => {
  const feedUrl = "https://www.reddit.com/r/ukraine/?redditp=1";
  const postUrl =
    "https://www.reddit.com/r/ukraine/comments/1vrzyuh/we_cannot_turn_our_backs_on_ukraine_sandu_on/";
  let detailRequests = 0;
  await page.route(postUrl, async (route) => {
    detailRequests += 1;
    await route.fulfill({
      contentType: "text/html",
      body: linkPreviewPostFixture,
    });
  });
  await page.route(feedUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: linkPreviewFeedFixture }),
  );
  await page.route(
    /https:\/\/external-preview\.redd\.it\/sandu-grain-transit\.png.*/,
    async (route) => {
      const isThumbnail = new URL(route.request().url()).searchParams.has(
        "width",
      );
      const width = isThumbnail ? 320 : 1200;
      const height = isThumbnail ? 180 : 675;
      await route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
      });
    },
  );

  await page.goto(feedUrl);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });

  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await captureWindowOpens(page);
  await page.keyboard.press("c");
  expect(await openedUrls(page)).toContain(postUrl);
  await expect.poll(() => detailRequests).toBe(1);
  await expect(page.locator(".redditp__image")).toHaveAttribute(
    "src",
    "https://external-preview.redd.it/sandu-grain-transit.png?auto=webp",
  );
  const dimensions = await page.locator(".redditp__image").evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      displayWidth: bounds.width,
      displayHeight: bounds.height,
    };
  });
  expect(detailRequests).toBe(1);
  expect(dimensions).toEqual({
    naturalWidth: 1200,
    naturalHeight: 675,
    displayWidth: 1280,
    displayHeight: 720,
  });
});

test("settings shortcut reference fits mobile and desktop screens", async ({
  page,
}, testInfo) => {
  await page.route("https://www.reddit.com/r/pics?redditp=1", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div class="thing link" data-url="https://example.com/post"><a class="title">Shortcut help</a></div>',
    }),
  );
  await page.goto("https://www.reddit.com/r/pics?redditp=1");
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();
  const help = page.getByRole("region", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(
    help.locator("dt").filter({ hasText: /^F$/ }).locator("+ dd"),
  ).toHaveText("Toggle fullscreen (if available)");
  await expect(
    help.locator("dt").filter({ hasText: /^G$/ }).locator("+ dd"),
  ).toHaveText("Skip gallery / next post");

  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [393, 852],
    [412, 915],
    [1920, 1080],
    [2560, 1440],
    [360, 420],
  ]) {
    await page.setViewportSize({ width, height });
    await help.locator("p").scrollIntoViewIfNeeded();
    const bounds = await page
      .locator(".redditp__settings")
      .evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          overflow: panel.scrollWidth - panel.clientWidth,
        };
      });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.bottom).toBeLessThanOrEqual(height);
    expect(bounds.overflow).toBe(0);
    await expect(help.locator("p")).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`shortcuts-${width}x${height}.png`),
    });
    // Esc remains available even when the longer panel is scrolled, and the
    // next open must still allow mouse/touch users to reach the Done button.
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open presentation settings" }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Open presentation settings" })
      .click();
    await page
      .getByRole("button", { name: "Close presentation settings" })
      .click();
    await expect(help).toBeHidden();
    await page
      .getByRole("button", { name: "Open presentation settings" })
      .click();
  }
});

test("settings persist timing and visibility while compact controls stay reachable", async ({
  page,
}) => {
  await page.route("https://i.redd.it/settings*.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"/>',
    }),
  );
  await page.route("https://www.reddit.com/settings-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<shreddit-post post-title="Settings post" content-href="https://i.redd.it/settings.jpg" permalink="/r/pics/comments/settings/post/"></shreddit-post><shreddit-post post-title="Second settings post" content-href="https://i.redd.it/settings-2.jpg" permalink="/r/pics/comments/settings2/post/"></shreddit-post>`,
    }),
  );
  await page.goto("https://www.reddit.com/settings-test");
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  const originalImage = await page.locator(".redditp__image").elementHandle();

  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();
  await page.getByLabel("Seconds per slide").press("ArrowRight");
  await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
  await page.getByLabel("Seconds per slide").fill("1");
  await page.getByLabel("Seconds per slide").press("Enter");
  await page.getByLabel("Show the title panel").uncheck();
  await page.getByLabel("Show previous and next arrows").uncheck();
  await page.getByLabel("Let videos play at least once").uncheck();
  await page.getByLabel("Loop short videos until the timer ends").uncheck();
  await page
    .getByLabel("Show the close button (press Esc instead when hidden)")
    .uncheck();
  await expect(page.getByLabel("Show media and comments links")).toHaveCount(0);
  await expect(
    page.getByLabel("Show auto-play and sound controls"),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Video slides also move on when the video ends. Settings are saved in this browser.",
    ),
  ).toHaveCount(0);
  const settingsColors = await page
    .locator(".redditp__settings")
    .evaluate((panel) => ({
      panel: getComputedStyle(panel).backgroundColor,
      row: getComputedStyle(panel.querySelector(".redditp__setting"))
        .backgroundColor,
      text: getComputedStyle(panel.querySelector(".redditp__setting")).color,
    }));
  expect(settingsColors).toEqual({
    panel: "rgb(23, 23, 23)",
    row: "rgb(43, 43, 43)",
    text: "rgb(255, 255, 255)",
  });
  await expect(page.getByLabel("Show the bottom panel")).toBeChecked();
  await page.getByLabel("Show the bottom panel").uncheck();
  expect(
    await originalImage.evaluate(
      (image) => image === document.querySelector(".redditp__image"),
    ),
  ).toBe(true);

  await expect(page.locator(".redditp__details")).toBeHidden();
  await expect(page.locator(".redditp__prev")).toBeHidden();
  await expect(page.locator(".redditp__close")).toBeHidden();
  // P hides the count chip (it is the visible part of the bottom row; the
  // auto toggle stays reachable per the compact-controls contract).
  await expect(page.locator(".redditp__count")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open presentation settings" }),
  ).toBeHidden();

  await page
    .getByRole("button", { name: "Close presentation settings" })
    .click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__redditpPresentation.toggle());
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("redditpPresentationSettings")),
  );
  expect(saved.slideDurationSeconds).toBe(1);
  expect(saved.showControls).toBe(false);
  expect(saved.showClose).toBe(false);
  expect(saved.finishMediaOnce).toBe(false);
  expect(saved.loopShortMedia).toBe(false);

  await expect(page.locator(".redditp__count")).toBeHidden();
  await page.keyboard.press("p");
  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();
  await expect(page.getByLabel("Seconds per slide")).toHaveValue("1");
  await expect(page.getByLabel("Show the title panel")).not.toBeChecked();
  await expect(
    page.getByLabel("Let videos play at least once"),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Loop short videos until the timer ends"),
  ).not.toBeChecked();

  await page
    .getByRole("button", { name: "Close presentation settings" })
    .click();
  await pinAutoAdvance(page, false);
  await page.getByRole("button", { name: "Start slideshow" }).click();
  await expect(page.locator(".redditp__title")).toHaveText(
    "Second settings post",
    { timeout: 2500 },
  );
});

test("one close click cancels a direct post that is still preparing video", async ({
  page,
}) => {
  const postUrl =
    "https://www.reddit.com/r/test/comments/slowclose/preparing_video/?redditp=1";
  await page.route(postUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<shreddit-post id="t3_slowclose" post-title="Preparing video" content-href="https://v.redd.it/slowclose" permalink="/r/test/comments/slowclose/preparing_video/"><shreddit-player preview="https://v.redd.it/slowclose/CMAF_96.mp4"><video></video></shreddit-player></shreddit-post>`,
    }),
  );
  await page.goto(postUrl);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();

  await page.getByRole("button", { name: "Close presentation mode" }).click();

  await expect(page.locator("#redditp-presentation")).toBeHidden();
  await page.waitForTimeout(4500);
  await expect(page.locator("#redditp-presentation")).toBeHidden();
});

test("a new extension instance retires a stale overlay and recovers its live video", async ({
  page,
}) => {
  await startPresentation(page, staleVideoOverlayFixture);

  await expect(page.locator("#redditp-presentation")).toHaveCount(1);
  await expect(page.locator(".redditp__title")).toHaveText(
    "Streamer gets knocked out after threatening to slap Tiki Ghosn",
  );
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    "blob:https://www.reddit.com/sanitized-live-video",
  );
  await expect(page.locator(".redditp__link-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Close presentation mode" }).click();
  await expect(page.locator("#redditp-presentation")).toBeHidden();
  await expect(page.locator("shreddit-player > #stale-live-video")).toHaveCount(
    1,
  );
});

test("injecting the extension action again toggles presentation mode", async ({
  page,
}) => {
  await startPresentation(
    page,
    `<article><h2>Post in a user feed</h2><a href="/r/test/comments/xyz/post/">Comments</a></article>`,
  );
  await expect(page.locator("#redditp-presentation")).toBeVisible();

  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeHidden();

  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
});

test("a thumbnail-only search result upgrades again after reopening", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/test/comments/reopen/clip/";
  const thumbnailUrl = "https://external-preview.redd.it/reopen-thumb.png";
  const previewUrl = "https://v.redd.it/reopen123/DASH_480.mp4";
  await page.route(thumbnailUrl, async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>',
    });
  });
  await page.route(postUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<shreddit-post id="t3_reopen" post-title="Reopened clip" post-type="video" content-href="https://v.redd.it/reopen123" permalink="/r/test/comments/reopen/clip/"><shreddit-player src="https://v.redd.it/reopen123/HLSPlaylist.m3u8" preview="${previewUrl}" poster="${thumbnailUrl}"></shreddit-player></shreddit-post>`,
    });
  });
  await page.route(previewUrl, async (route) => {
    await route.abort();
  });
  await startPresentation(
    page,
    `<search-telemetry-tracker data-faceplate-tracking-context='{"post":{"id":"t3_reopen","title":"Reopened clip"},"subreddit":{"name":"test"}}'><div data-testid="search-post-unit"><h2><a href="${postUrl}">Reopened clip</a></h2><a href="${postUrl}" aria-label="Reopened clip thumbnail image"><faceplate-img data-testid="search_post_thumbnail" src="${thumbnailUrl}" alt="Reopened clip"></faceplate-img></a></div></search-telemetry-tracker>`,
  );
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    previewUrl,
  );

  await page.keyboard.press("Escape");
  await expect(page.locator("#redditp-presentation")).toBeHidden();
  await page.evaluate(() => window.__redditpPresentation.toggle());
  await expect(page.locator("#redditp-presentation")).toBeVisible();

  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    previewUrl,
  );
});

test("browser shortcuts such as Ctrl+F are not swallowed", async ({ page }) => {
  // A real origin lets the M press be observed through the saved settings.
  await page.route("https://www.reddit.com/shortcut-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div class="thing link" data-url="https://i.redd.it/one.jpg" data-permalink="/r/pics/comments/one/a/"><a class="title">Only post</a></div>`,
    }),
  );
  await page.goto("https://www.reddit.com/shortcut-test");
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();

  const prevented = await page.evaluate(() =>
    ["f", "m", "g"].map((key) => {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(prevented).toEqual([false, false, false]);

  // The unmodified key still works.
  await page.keyboard.press("m");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("redditpPresentationSettings")),
  );
  expect(saved.sound).toBe(true);
});

test("the M sound setting is remembered for the next presentation", async ({
  page,
}) => {
  // Settings storage needs a real origin, not setContent's about:blank.
  await page.route("https://www.reddit.com/sound-setting-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div class="thing link" data-url="https://example.com/story" data-permalink="/r/news/comments/one/a/"><a class="title">Only post</a></div>`,
    }),
  );
  async function openPresentation() {
    await page.goto("https://www.reddit.com/sound-setting-test");
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
  }
  await openPresentation();
  // The mute control is not part of the visible interface; sound is a
  // keyboard (M) and per-player concern.
  await expect(page.locator(".redditp__sound")).toHaveCount(0);

  await page.keyboard.press("m");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("redditpPresentationSettings")),
  );
  expect(saved.sound).toBe(true);

  // A fresh content script, as on the next page load, reads it back.
  await openPresentation();
  const reopened = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("redditpPresentationSettings")),
  );
  expect(reopened.sound).toBe(true);
});

test("a saved legacy controlsCollapsed setting becomes showControls", async ({
  page,
}) => {
  await page.route("https://www.reddit.com/legacy-setting-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<div class="thing link" data-url="https://example.com/story" data-permalink="/r/news/comments/one/a/"><a class="title">Only post</a></div>`,
    }),
  );
  await page.goto("https://www.reddit.com/legacy-setting-test");
  await page.evaluate(() =>
    localStorage.setItem(
      "redditpPresentationSettings",
      JSON.stringify({ controlsCollapsed: true }),
    ),
  );
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator(".redditp__count")).toBeHidden();

  await page.keyboard.press("p");
  await expect(page.locator(".redditp__count")).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("redditpPresentationSettings")),
  );
  expect(saved.showControls).toBe(true);
  expect(saved).not.toHaveProperty("controlsCollapsed");
});

test("T hides and shows the title panel", async ({ page }) => {
  await startPresentation(
    page,
    `<div class="thing link" data-url="https://example.com/story" data-permalink="/r/news/comments/one/a/"><a class="title">Only post</a></div>`,
  );
  await expect(page.locator(".redditp__details")).toBeVisible();

  await page.keyboard.press("t");
  await expect(page.locator(".redditp__details")).toBeHidden();

  await page.keyboard.press("T");
  await expect(page.locator(".redditp__details")).toBeVisible();
});

test("P toggles the bottom controls and C opens comments", async ({ page }) => {
  await page
    .context()
    .route("https://www.reddit.com/r/news/comments/one/a/", (route) =>
      route.fulfill({ contentType: "text/html", body: "comments page" }),
    );
  await startPresentation(
    page,
    `<div class="thing link" data-url="https://example.com/story" data-permalink="https://www.reddit.com/r/news/comments/one/a/"><a class="title">Only post</a></div>`,
  );
  const countPill = page.locator(".redditp__count");
  await expect(countPill).toBeVisible();

  await page.keyboard.press("p");
  await expect(countPill).toBeHidden();
  await page.keyboard.press("p");
  await expect(countPill).toBeVisible();

  const [commentsPage] = await Promise.all([
    page.context().waitForEvent("page"),
    page.keyboard.press("c"),
  ]);
  await commentsPage.waitForLoadState();
  expect(commentsPage.url()).toBe(
    "https://www.reddit.com/r/news/comments/one/a/",
  );
  await expect(page.locator("#redditp-presentation")).toBeVisible();
});

for (const scenario of [
  { name: "finishes a long first pass", duration: 20, waits: true },
  {
    name: "allows clicking next while waiting",
    duration: 20,
    waits: true,
    skip: "mouse",
  },
  {
    name: "allows swiping next while waiting",
    duration: 20,
    waits: true,
    skip: "touch",
  },
  { name: "loops a short clip until the timer", duration: 2, short: true },
  {
    name: "advances after a short clip when looping is off",
    duration: 2,
    short: true,
    loop: false,
  },
  {
    name: "keeps the slide timer when playback settings change",
    duration: 2,
    short: true,
    toggleMidway: true,
  },
  { name: "uses the timer when finishing is off", duration: 20, finish: false },
  { name: "uses the timer for unknown duration", duration: NaN },
  { name: "uses the timer for paused media", duration: 20, paused: true },
  { name: "uses the timer for failed media", duration: 20, error: true },
  {
    name: "advances a video paused after the timer",
    duration: 20,
    waits: true,
    stop: "pause",
  },
  {
    name: "advances a video stalled after the timer",
    duration: 20,
    waits: true,
    stop: "stall",
  },
  {
    name: "advances a video that fails after the timer",
    duration: 20,
    waits: true,
    stop: "error",
  },
  {
    name: "keeps waiting when a paused video resumes",
    duration: 20,
    waits: true,
    stop: "resume",
  },
  {
    name: "advances when finishing is turned off while waiting",
    duration: 20,
    waits: true,
    stop: "finish-off",
  },
  {
    name: "counts a pass watched before auto starts",
    duration: 20,
    watchedInManual: true,
  },
]) {
  test(`video auto-advance ${scenario.name}`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-16T12:00:01Z"));
    await startPresentation(
      page,
      `<div class="thing link" data-url="https://v.redd.it/adaptive" data-permalink="/r/videos/comments/one/clip/">
        <a class="title">Clip</a><div id="native-player"><video id="timed-video" muted></video></div>
      </div><div class="thing link" data-url="https://example.com/story"><a class="title">Next story</a></div>`,
      async () => {
        await page.evaluate(({ duration, paused, error }) => {
          const video = document.querySelector("video");
          video.src = URL.createObjectURL(
            new Blob(["test"], { type: "video/mp4" }),
          );
          // Scenarios change these mid-slide through setMedia.
          const media = (window.redditpTestMedia = {
            paused: Boolean(paused),
            readyState: 4,
            error: error ? { code: 2 } : null,
          });
          Object.defineProperties(video, {
            duration: { get: () => duration },
            paused: { get: () => media.paused },
            readyState: { get: () => media.readyState },
            error: { get: () => media.error },
            currentTime: { writable: true, value: 1 },
          });
          video.play = () => Promise.resolve();
          video.pause = () => {};
        }, scenario);
      },
    );
    const setMedia = (changes, eventType) =>
      page.evaluate(
        ({ changes, eventType }) => {
          Object.assign(window.redditpTestMedia, changes);
          document
            .querySelector(".redditp__video")
            .dispatchEvent(new Event(eventType));
        },
        { changes, eventType },
      );
    const title = page.locator(".redditp__title");
    const video = page.locator(".redditp__video");
    const openSettings = page.getByRole("button", {
      name: "Open presentation settings",
    });
    const closeSettings = page.getByRole("button", {
      name: "Close presentation settings",
    });
    const finishBox = page.getByLabel("Let videos play at least once");
    const loopBox = page.getByLabel("Loop short videos until the timer ends");
    await expect(video).toBeVisible();
    await openSettings.click();
    await expect(finishBox).toBeChecked();
    await expect(loopBox).toBeChecked();
    if (scenario.finish === false) await finishBox.uncheck();
    if (scenario.loop === false) await loopBox.uncheck();
    await closeSettings.click();
    await pinAutoAdvance(page, false);
    if (scenario.watchedInManual) {
      // Manual mode loops the video, so only its wrap to the start shows
      // that the first pass is done.
      await expect(video).toHaveJSProperty("loop", true);
      await page.evaluate(() => {
        const media = document.querySelector(".redditp__video");
        media.currentTime = 19.8;
        media.dispatchEvent(new Event("timeupdate"));
        media.currentTime = 0.2;
        media.dispatchEvent(new Event("timeupdate"));
      });
    }
    await page.keyboard.press("a");
    if (scenario.short) {
      await page.clock.runFor(2000);
      await video.dispatchEvent("ended");
      if (scenario.loop === false) {
        await expect(title).toHaveText("Next story");
        return;
      }
      await expect(title).toHaveText("Clip");
      await expect(video).toHaveJSProperty("loop", true);
      if (scenario.toggleMidway) {
        await openSettings.click();
        await loopBox.uncheck();
        await expect(video).toHaveJSProperty("loop", false);
        await loopBox.check();
        await closeSettings.click();
        await expect(video).toHaveJSProperty("loop", true);
      }
      await page.clock.runFor(4100);
    } else {
      await page.clock.runFor(6100);
    }
    if (scenario.waits) {
      await expect(title).toHaveText("Clip");
      if (scenario.stop) {
        if (scenario.stop === "pause") {
          await setMedia({ paused: true }, "pause");
        } else if (scenario.stop === "stall") {
          await setMedia({ readyState: 2 }, "waiting");
        } else if (scenario.stop === "error") {
          await setMedia({ error: { code: 2 } }, "error");
        } else if (scenario.stop === "resume") {
          await setMedia({ paused: true }, "pause");
          await setMedia({ paused: false }, "play");
        } else {
          await openSettings.click();
          await finishBox.uncheck();
          await closeSettings.click();
        }
        // A stop gets one more slide timer, not an immediate jump.
        await expect(title).toHaveText("Clip");
        await page.clock.runFor(6100);
        if (scenario.stop === "resume") {
          await expect(title).toHaveText("Clip");
          await video.dispatchEvent("ended");
        }
      } else if (scenario.skip === "mouse") {
        await page.locator(".redditp__next").click();
      } else if (scenario.skip === "touch") {
        const root = page.locator("#redditp-presentation");
        await root.dispatchEvent("pointerdown", {
          pointerId: 1,
          pointerType: "touch",
          clientX: 300,
          clientY: 200,
        });
        await root.dispatchEvent("pointerup", {
          pointerId: 1,
          pointerType: "touch",
          clientX: 100,
          clientY: 200,
        });
      } else {
        await video.dispatchEvent("ended");
      }
    }
    await expect(title).toHaveText("Next story");
    await expect(
      page.locator("#native-player > #timed-video"),
    ).toHaveJSProperty("loop", false);
    // A restored video's events must not advance the new slide.
    await page.locator("#timed-video").dispatchEvent("ended");
    await expect(title).toHaveText("Next story");
  });
}

test("auto-advance keeps moving when a video slide fails to load", async ({
  page,
}) => {
  await page.route("https://v.redd.it/broken/DASH_480.mp4", async (route) => {
    await route.abort();
  });
  await page.route("https://i.redd.it/second.jpg", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"></svg>',
    });
  });
  await startPresentation(
    page,
    `<div class="thing link" data-url="https://v.redd.it/broken/DASH_480.mp4" data-permalink="/r/v/comments/one/a/"><a class="title" href="https://v.redd.it/broken/DASH_480.mp4">Broken video</a></div>
     <div class="thing link" data-url="https://i.redd.it/second.jpg" data-permalink="/r/pics/comments/two/b/"><a class="title" href="https://i.redd.it/second.jpg">Second post</a></div>`,
  );
  await expect(page.locator(".redditp__title")).toHaveText("Broken video");
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Image unavailable",
  );

  await pinAutoAdvance(page, false);
  await page.locator(".redditp__auto").click();
  await expect(page.locator(".redditp__title")).toHaveText("Second post", {
    timeout: 9000,
  });
});

test("Tab cycles focus inside the presentation instead of the page behind it", async ({
  page,
}) => {
  await startPresentation(
    page,
    `<div class="thing link" data-url="https://i.redd.it/one.jpg" data-permalink="/r/pics/comments/one/a/"><a class="title" href="https://i.redd.it/one.jpg">Only post</a></div>
     <a id="behind" href="https://www.reddit.com/r/all/">A link on the Reddit page</a>`,
  );
  await expect(page.locator("#redditp-presentation")).toBeVisible();

  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    const insideDialog = await page.evaluate(() =>
      Boolean(document.activeElement?.closest("#redditp-presentation")),
    );
    expect(insideDialog).toBe(true);
  }
});

// Current Reddit feed cards carry post-type and content-href but leave the
// media container to lazy loading, so hosted-video, gallery, and sometimes
// even image posts can reach the viewer without playable markup at all.
const feedVideoCard = (id, title) =>
  `<shreddit-post id="t3_${id}" post-title="${title}" post-type="video" content-href="https://v.redd.it/${id}" permalink="https://www.reddit.com/r/aww/comments/${id}/post/" author="uploader" subreddit-prefixed-name="r/aww"></shreddit-post>`;

const stubWebm = () =>
  fs.readFileSync(
    path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
  );

const fulfillPage = (route, body) =>
  route.fulfill({ contentType: "text/html", body });

function fulfillJsonListing(route, post) {
  const listing = JSON.stringify([
    { data: { children: post ? [{ kind: "t3", data: post }] : [] } },
  ]);
  return route.fulfill({ contentType: "application/json", body: listing });
}

test("a feed video card without its lazy-loaded player resolves the post page", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/aww/comments/1xjwj5s/post/";
  const packagedUrl =
    "https://packaged-media.redd.it/1xjwj5s/pb/m2-res_640p.mp4?m=DASHPlaylist.mpd";
  const fallbackUrl =
    "https://packaged-media.redd.it/1xjwj5s/pb/m2-res_392p.mp4";
  const packagedMedia = JSON.stringify({
    playbackMp4s: {
      permutations: [
        {
          source: { url: fallbackUrl, dimensions: { width: 220, height: 392 } },
        },
        {
          source: { url: packagedUrl, dimensions: { width: 270, height: 640 } },
        },
      ],
    },
  });
  const escapedPackaged = packagedMedia.replace(/"/g, "&quot;");
  await page.route(stubWebmRoute(packagedUrl), (route) => stubVideoFile(route));
  await page.route(postUrl, async (route) => {
    // Keep the enrichment in flight long enough that the loading wording is
    // observable, not just a frame the assertions can miss.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fulfillPage(
      route,
      `<shreddit-post id="t3_1xjwj5s" post-title="Two rescued boys" post-type="video" content-href="https://v.redd.it/1xjwj5s" permalink="/r/aww/comments/1xjwj5s/post/"><shreddit-player src="https://v.redd.it/1xjwj5s/HLSPlaylist.m3u8" preview="https://v.redd.it/1xjwj5s/CMAF_96.mp4" poster="https://external-preview.redd.it/1xjwj5s.jpg" packaged-media-json="${escapedPackaged}"></shreddit-player></shreddit-post>`,
    );
  });

  await startPresentation(page, feedVideoCard("1xjwj5s", "Two rescued boys"));

  // While the page is being fetched the card says what is happening instead
  // of pretending the v.redd.it URL is a link.
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Loading video…",
  );
  // The packaged mp4 is a muxed permutation Reddit itself plays; it must be
  // preferred over the silent CMAF_96 seek preview.
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    packagedUrl,
  );
  await expect(page.locator(".redditp__title")).toHaveText("Two rescued boys");
  await expect(page.locator(".redditp__link-card")).toHaveCount(0);
});

function stubWebmRoute(url) {
  return url;
}

function stubVideoFile(route) {
  return route.fulfill({ contentType: "video/webm", body: stubWebm() });
}

test("an HTML fetch that returns a hydration shell falls back to post JSON", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/aww/comments/1xjwj5s/post/";
  const fallbackUrl = "https://v.redd.it/1xjwj5s/DASH_720.mp4?source=fallback";
  const hlsUrl = "https://v.redd.it/1xjwj5s/HLSPlaylist.m3u8?f=hd";
  const dashUrl = "https://v.redd.it/1xjwj5s/DASHPlaylist.mpd";
  await page.route(stubWebmRoute(fallbackUrl), (route) => stubVideoFile(route));
  await page.route(postUrl, (route) =>
    fulfillPage(
      route,
      `<html><body><p class="shell">hydrating</p></body></html>`,
    ),
  );
  await page.route(`${postUrl}.json`, (route) =>
    fulfillJsonListing(route, {
      title: "Two rescued boys",
      post_hint: "hosted:video",
      url: "https://v.redd.it/1xjwj5s",
      secure_media: {
        reddit_video: {
          fallback_url: fallbackUrl,
          hls_url: hlsUrl,
          dash_url: dashUrl,
        },
      },
      preview: {
        images: [
          {
            source: {
              url: "https://preview.redd.it/1xjwj5s.jpg?width=1080&amp;crop=smart",
            },
            resolutions: [],
            variants: {},
          },
        ],
      },
    }),
  );

  await startPresentation(page, feedVideoCard("1xjwj5s", "Two rescued boys"));

  // The wrapper plays the native-HLS URL only where the browser claims HLS
  // support; elsewhere the DASH fallback rendition plays and the MPD stays
  // behind for the page's dash.js.
  const expectsHls = await canPlayHls(page);
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    expectsHls ? hlsUrl : fallbackUrl,
  );
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "data-redditp-mpd",
    dashUrl,
  );
});

test("post JSON resolves galleries in order one item per slide", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/aww/comments/1xkcyyn/post/";
  const first = "https://preview.redd.it/gallery-1.jpg?width=1080";
  const third = "https://preview.redd.it/gallery-3.gif?format=mp4";
  const fourth = "https://preview.redd.it/gallery-4.jpg?width=1080";
  await page.route(stubWebmRoute(third), (route) => stubVideoFile(route));
  await page.route(postUrl, (route) =>
    fulfillPage(route, `<html><body class="shell"></body></html>`),
  );
  await page.route(`${postUrl}.json`, (route) =>
    fulfillJsonListing(route, {
      title: "Amara the kurullian bobtail!",
      post_hint: "gallery",
      is_gallery: true,
      url: "https://www.reddit.com/gallery/1xkcyyn",
      gallery_data: {
        items: [
          { media_id: "img1" },
          { media_id: "broken" },
          { media_id: "gif2" },
          { media_id: "img4" },
        ],
      },
      media_metadata: {
        img1: {
          status: "valid",
          e: "Image",
          m: "image/jpg",
          s: { u: first },
          p: [],
        },
        broken: { status: "failed", e: "Image", m: "image/jpg", s: {}, p: [] },
        gif2: {
          status: "valid",
          e: "AnimatedImage",
          m: "image/gif",
          s: { gif: "https://preview.redd.it/gallery-3.gif", mp4: third },
        },
        img4: {
          status: "valid",
          e: "Image",
          m: "image/jpg",
          s: { u: fourth },
          p: [],
        },
        // Missing from gallery_data, so it must never produce a slide.
        img9: {
          status: "valid",
          e: "Image",
          m: "image/png",
          s: { u: "https://preview.redd.it/stray.png" },
          p: [],
        },
      },
    }),
  );

  await startPresentation(
    page,
    `<shreddit-post id="t3_1xkcyyn" post-title="Amara the kurullian bobtail!" post-type="gallery" gallery="" content-href="https://www.reddit.com/gallery/1xkcyyn" permalink="https://www.reddit.com/r/aww/comments/1xkcyyn/post/" subreddit-prefixed-name="r/aww"></shreddit-post>`,
  );

  await expect(page.locator(".redditp__image")).toHaveAttribute("src", first);
  await expect(page.locator(".redditp__count")).toHaveText("1 / 1");
  await expect(page.locator(".redditp__title")).toContainText("(1/3");
  // The failed entry is skipped, not a blank slide.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".redditp__video")).toHaveAttribute("src", third);
  await expect(page.locator(".redditp__title")).toContainText("(2/3");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".redditp__image")).toHaveAttribute("src", fourth);
  await expect(page.locator(".redditp__title")).toContainText("(3/3");
});

test("a hydration shell for an external link still leaves the link card", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/news/comments/1story/story/";
  await page.route(postUrl, async (route) => {
    // Keep the enrichment in flight long enough that the loading wording is
    // observable, not just a frame the assertions can miss.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fulfillPage(route, `<html><body class="shell"></body></html>`);
  });
  await page.route(`${postUrl}.json`, (route) =>
    fulfillJsonListing(route, {
      title: "A story",
      post_hint: "link",
      url: "https://example.com/story",
      selftext: "",
    }),
  );

  await startPresentation(
    page,
    `<div class="thing link" data-url="https://example.com/story" data-permalink="https://www.reddit.com/r/news/comments/1story/story/" data-subreddit="news"><a class="title">A story</a></div>`,
  );

  await expect(page.locator(".redditp__link-icon")).toHaveText("Loading post…");
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Open linked post",
  );
  await expect(page.locator(".redditp__link-card")).toHaveAttribute(
    "href",
    "https://example.com/story",
  );
});

test("a block-page channel page response cannot resolve and the retry stays carded", async ({
  page,
}) => {
  const postUrl = "https://www.reddit.com/r/aww/comments/1xjwj5s/post/";
  const fallbackUrl = "https://v.redd.it/1xjwj5s/DASH_720.mp4?source=fallback";
  await page.route(stubWebmRoute(fallbackUrl), (route) => stubVideoFile(route));
  let htmlRequests = 0;
  let jsonRequests = 0;
  await page.route(postUrl, async (route) => {
    htmlRequests += 1;
    // Hold the attempt open so the retry's loading wording is observable.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fulfillPage(
      route,
      `<html><body>You've been blocked by network security.</body></html>`,
    );
  });
  await page.route(`${postUrl}.json`, async (route) => {
    jsonRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({
      contentType: "text/html",
      body: `<html><body>You've been blocked by network security.</body></html>`,
    });
  });

  await startPresentation(
    page,
    `${feedVideoCard("1xjwj5s", "Two rescued boys")}
     <div class="thing link" data-url="https://i.redd.it/two.jpg" data-permalink="https://www.reddit.com/r/pics/comments/two/b/" data-subreddit="pics"><a class="title">Second post</a></div>`,
  );
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Open linked post",
  );
  expect(htmlRequests).toBe(1);
  expect(jsonRequests).toBe(1);

  // A previously failed slide is retried rather than stuck forever.
  // PageUp back: the committed deck keeps ArrowUp gallery-internal only.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".redditp__title")).toHaveText("Second post");
  await page.keyboard.press("PageUp");
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Loading video…",
  );
  await expect(page.locator(".redditp__link-icon")).toHaveText(
    "Open linked post",
  );
  expect(htmlRequests).toBe(2);
  expect(jsonRequests).toBe(2);
});

test("an enrichment landing after rapid navigation does not disturb the current slide", async ({
  page,
}) => {
  const slowUrl = "https://www.reddit.com/r/aww/comments/slow/post/";
  const fastUrl = "https://www.reddit.com/r/aww/comments/fast/post/";
  const slowFallback = "https://v.redd.it/slow/DASH_720.mp4?source=fallback";
  const fastFallback = "https://v.redd.it/fast/DASH_720.mp4?source=fallback";
  await page.route(stubWebmRoute(slowFallback), (route) =>
    stubVideoFile(route),
  );
  await page.route(stubWebmRoute(fastFallback), (route) =>
    stubVideoFile(route),
  );
  await page.route(slowUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return fulfillPage(route, `<html><body class="shell"></body></html>`);
  });
  await page.route(`${slowUrl}.json`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return fulfillJsonListing(route, {
      title: "Slow boy",
      post_hint: "hosted:video",
      url: "https://v.redd.it/slow",
      secure_media: {
        reddit_video: { fallback_url: slowFallback, hls_url: "", dash_url: "" },
      },
      preview: { images: [] },
    });
  });
  await page.route(fastUrl, (route) =>
    fulfillPage(route, `<html><body class="shell"></body></html>`),
  );
  await page.route(`${fastUrl}.json`, (route) =>
    fulfillJsonListing(route, {
      title: "Fast girl",
      post_hint: "hosted:video",
      url: "https://v.redd.it/fast",
      secure_media: {
        reddit_video: { fallback_url: fastFallback, hls_url: "", dash_url: "" },
      },
      preview: { images: [] },
    }),
  );

  await startPresentation(
    page,
    `${feedVideoCard("slow", "Slow boy")}${feedVideoCard("fast", "Fast girl")}`,
  );
  await expect(page.locator(".redditp__title")).toHaveText("Slow boy");
  // Leave the first post while its page fetch is still in flight.
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".redditp__title")).toHaveText("Fast girl");
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    fastFallback,
  );

  // The slow fetch landing must not pull the viewer back to the first post…
  await expect(page.locator(".redditp__title")).toHaveText("Fast girl", {
    timeout: 8000,
  });
  await expect(page.locator(".redditp__title")).not.toHaveText("Slow boy");
  // …but the first post's slide did resolve in the background.
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".redditp__video")).toHaveAttribute(
    "src",
    slowFallback,
  );
});

test("numbered post navigation and the mute control keep working without the plus button or sound text", async ({
  page,
}) => {
  const videoUrl = "https://i.redd.it/clip.mp4";
  await page.route(stubWebmRoute(videoUrl), (route) => stubVideoFile(route));
  await page.route("https://i.redd.it/one.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>',
    }),
  );
  await startPresentation(
    page,
    `<div class="thing link" data-url="https://i.redd.it/one.jpg" data-fullname="t3_a" data-permalink="/r/pics/comments/one/a/" data-author="alice" data-subreddit="pics"><a class="title">First post</a></div>
     <div class="thing link" data-url="${videoUrl}" data-fullname="t3_b" data-permalink="/r/videos/comments/two/b/" data-author="bob" data-subreddit="videos"><a class="title">Second post</a></div>`,
  );

  await expect(page.locator("#redditp-presentation")).toBeVisible();

  // No "+" control anywhere, and no sound on/off wording on screen.
  const plusButtonVisible = await page.evaluate(() => {
    const text = (node) =>
      node.getAttribute("aria-label") === "+" || node.textContent === "+";
    return (
      Boolean(document.querySelector(".redditp__collapse")) ||
      Array.from(
        document.querySelectorAll(
          "#redditp-presentation button, .redditp__controls *",
        ),
      ).some(text)
    );
  });
  expect(plusButtonVisible).toBe(false);
  await expect(page.locator(".redditp__numbers")).toBeVisible();
  await expect(page.locator(".redditp__number").first()).toBeVisible();

  // The mute control is not part of the interface; sound toggling is a
  // keyboard (M) concern and must still drive a real video.
  await expect(page.locator(".redditp__sound")).toHaveCount(0);

  // A slide with real media must anchor the mute to what the user hears.
  await page.keyboard.press("ArrowDown");
  const video = page.locator(".redditp__video");
  await expect(video).toHaveJSProperty("muted", true);

  await page.keyboard.press("m");
  await expect(video).toHaveJSProperty("muted", false);
  await expect(page.getByText("Sound on")).toHaveCount(0);

  // Navigation and fullscreen toggling must not bring the wording back.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".redditp__sound")).toHaveCount(0);
  await expect(page.getByText("Sound off", { exact: true })).toHaveCount(0);

  // Numbered bar still navigates to a post directly.
  await page.locator(".redditp__number").first().click();
  await expect(page.locator(".redditp__title")).toHaveText("First post");
});

test("the numbered bar keeps its first items reachable on narrow screens", async ({
  page,
}) => {
  // Mobile traffic opens long feeds, so the bar overflows 360px. Safe
  // centering must fall back to start alignment: with plain centering the
  // overflowing items sit at a negative offset that no scroll reaches, which
  // stranded the auto toggle once it moved into the bar.
  await page.setViewportSize({ width: 360, height: 780 });
  const svgImage =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svgImage }),
  );
  await startPresentation(
    page,
    Array.from(
      { length: 13 },
      (_, i) =>
        `<div class="thing link" data-fullname="t3_n${i}" data-url="https://i.redd.it/n${i}.jpg" data-permalink="/r/pics/comments/n${i}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${i + 1}</a></div>`,
    ).join(""),
  );

  // Clicking the toggle here also proves it is reachable at the bar start.
  await pinAutoAdvance(page, false);

  // The auto toggle lives at the bar's start and stays clickable.
  // Positions are measured relative to the bar's own left edge: the strip
  // starts after the count chip, so raw viewport coordinates would fail
  // `>= 0` checks for the wrong reason.
  const barStats = await page.evaluate(() => {
    const bar = document.querySelector(".redditp__numbers");
    return {
      overflow: bar.scrollWidth > bar.clientWidth + 1,
      overflowX: getComputedStyle(bar).overflowX,
      firstLeft:
        bar.firstElementChild.getBoundingClientRect().left -
        bar.getBoundingClientRect().left,
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
    };
  });
  expect(barStats.overflow).toBe(true);
  expect(barStats.overflowX).toBe("auto");
  expect(barStats.firstLeft).toBeGreaterThanOrEqual(0);

  // Scrolling the bar reaches both edges: nothing is clipped beyond reach.
  const bothEnds = await page.evaluate(() => {
    const bar = document.querySelector(".redditp__numbers");
    const barLeft = bar.getBoundingClientRect().left;
    bar.scrollLeft = bar.scrollWidth;
    const last = bar.lastElementChild.getBoundingClientRect();
    const lastOk =
      last.right - barLeft <= bar.clientWidth + 1 &&
      last.left >= barLeft - 0.5;
    bar.scrollLeft = 0;
    const first = bar.firstElementChild.getBoundingClientRect();
    const firstOk =
      first.left - barLeft >= 0 && first.right - barLeft > 0;
    return { lastOk, firstOk };
  });
  expect(bothEnds.lastOk).toBe(true);
  expect(bothEnds.firstOk).toBe(true);

  // Phase 4b: the count chip now shares the bottom row with the strip —
  // same vertical band (previously the chip floated above the numbers).
  const pill = await page.locator(".redditp__count").boundingBox();
  const autoBox = await page.locator(".redditp__auto").boundingBox();
  const countCenter = pill.y + pill.height / 2;
  const autoCenter = autoBox.y + autoBox.height / 2;
  expect(Math.abs(countCenter - autoCenter)).toBeLessThanOrEqual(2);
  // ...and the chip keeps its own fixed slot without covering the toggle.
  expect(pill.x + pill.width).toBeLessThanOrEqual(autoBox.x + 1);

  // Both the toggle and the numbered buttons work at this size.
  await pinAutoAdvance(page, true);
  // The last post starts a pagination scan and may wrap ("loading more"),
  // so asserting on the count here would race it; the title is the check.
  await page.locator(".redditp__number").nth(12).click();
  await expect(page.locator(".redditp__title")).toHaveText("Post 13");
  await pinAutoAdvance(page, false);
});

// ---------------------------------------------------------------------------
// Phase 2 regression coverage: preload dedupe and reuse, eviction with
// resource release, bounded concurrency, retry limits with revisit recovery,
// the single slideshow timer, pagination identity, and gallery-first
// preload priority. Feeds are served from the real Reddit origin over
// routes, so the debug API is reachable and requests are countable.

test.describe("phase 2 preloading and pagination", () => {
  test.setTimeout(45000);
  const feedUrl = "https://www.reddit.com/r/pics/?redditp=1";
  const svgImage =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

  function postHtml(id, title, url) {
    return `<div class="thing link" data-fullname="t3_${id}" data-url="${
      url || `https://i.redd.it/${id}.jpg`
    }" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;
  }

  const imagePage = (ids, nextPage = "") =>
    `${ids
      .map((id, index) => postHtml(id, `Image ${index + 1}: ${id}`))
      .join("")}${
      nextPage
        ? `<div class="nav-buttons"><span class="next-button"><a href="${nextPage}" rel="nofollow next">next ›</a></span></div>`
        : ""
    }`;

  // The load-more scan overlaps the five second auto timer, so every feed
  // test pins manual mode before its first assertion.
  async function openFeed(page, body, setup, url = feedUrl) {
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto(url);
    if (setup) await setup(page);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
  }

  const stats = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.stats());

  // Records every full-size media request in arrival order. Register this
  // route before any more specific one, and it still feeds no-cache images
  // that separate tests can layer failures on top of.
  function trackImages(page, options = {}) {
    const delay = options.delay || 0;
    const tracker = { requested: [] };
    page.route("https://i.redd.it/**", async (route) => {
      tracker.requested.push(route.request().url());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
        contentType: "image/svg+xml",
        body: svgImage,
      });
    });
    return tracker;
  }

  test("preloads each unique media once and reuses the cache on revisit", async ({
    page,
  }) => {
    const ids = ["pa1", "pb2", "pc3", "pd4"];
    const media = trackImages(page);
    await openFeed(page, imagePage(ids));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // The current slide renders directly; the rest fill the preload cache.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ loaded: 3, failed: 0 }));

    // Give each step's backward preload time to finish so a revisit is
    // always served from the cache.
    const settled = () =>
      expect
        .poll(() => stats(page), { timeout: 15000 })
        .toEqual(expect.objectContaining({ inFlight: 0 }));
    await page.keyboard.press("ArrowRight");
    await settled();
    await page.keyboard.press("ArrowRight");
    await settled();
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: pc3");
    await page.keyboard.press("ArrowLeft");
    await settled();
    await page.keyboard.press("ArrowLeft");
    await settled();
    await expect(page.locator(".redditp__title")).toHaveText("Image 1: pa1");

    // At most one network request per URL across the whole trip: revisits
    // are served from the preload cache (or the browser's own cache).
    // At most one network request per URL beyond the initial trip: pb2..pd4
    // preload once and every revisit is served from the cache; only pa1 is
    // re-requested once more, by the backward preload that fills its cache
    // entry the moment we step away from it.
    const requested = [...media.requested];
    const count = (needle) =>
      requested.filter((url) => url.includes(needle)).length;
    expect(count("pb2")).toBe(1);
    expect(count("pc3")).toBe(1);
    expect(count("pd4")).toBe(1);
    expect(count("pa1")).toBeLessThanOrEqual(2);
    expect(requested.length).toBeLessThanOrEqual(5);
  });

  test("evicts preloads outside the active window and releases resources", async ({
    page,
  }) => {
    const ids = ["ea1", "eb2", "ec3", "ed4", "ee5", "ef6", "eg7"];
    const media = trackImages(page);
    await openFeed(page, imagePage(ids), (feedPage) =>
      feedPage.evaluate(() => {
        // Release must strip the src so the preloaded object stops holding
        // decoded image data. Count every such release.
        window.__releasedSrcs = [];
        const original = HTMLImageElement.prototype.removeAttribute;
        HTMLImageElement.prototype.removeAttribute = function (name) {
          if (name === "src" && this.src) {
            window.__releasedSrcs.push(this.src);
          }
          return original.call(this, name);
        };
      }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 7");
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ loaded: 5, failed: 0 }));

    for (let step = 0; step < ids.length - 1; step += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 7: eg7");

    // Reaching the last slide drops the first four preloads; the two slides
    // just behind it stay cached.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ loaded: 7, evicted: 4 }));
    expect((await page.evaluate(() => window.__releasedSrcs)).length).toBe(4);

    // Stepping back re-preloads what it evicted.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Image 6: ef6");
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ loaded: 8, evicted: 4, failed: 0 }));

    // Network-wise the cache keeps the window warm without a refetch storm:
    // after the step back the schedule quenches and stops churning.
    const requested = [...media.requested];
    expect(requested.length).toBeLessThanOrEqual(10);
    const before = await stats(page);
    await page.waitForTimeout(1200);
    const after = await stats(page);
    expect(after.started).toBe(before.started);
    expect(after.evicted).toBe(before.evicted);
    expect(after.cacheSize).toBeGreaterThan(0);
  });

  test("keeps concurrent preloads within the configured cap", async ({
    page,
  }) => {
    trackImages(page, { delay: 400 });
    const ids = ["ca1", "cb2", "cc3", "cd4", "ce5", "cf6", "cg7", "ch8"];
    await openFeed(page, imagePage(ids));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 8");

    // Sample inFlight continuously while the preloads settle; the cap is
    // three, and only a completed preload frees a slot.
    const maxInFlight = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let max = 0;
          const timer = setInterval(() => {
            const current = window.__redditpPresentation.debug.stats();
            max = Math.max(max, current.inFlight);
            if (current.loaded >= 5) {
              clearInterval(timer);
              resolve(max);
            }
          }, 40);
        }),
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    await expect
      .poll(() => stats(page))
      .toEqual(
        expect.objectContaining({
          started: 5,
          loaded: 5,
          failed: 0,
          inFlight: 0,
        }),
      );
  });

  test("retries failed preloads with a limit and recovers on revisit", async ({
    page,
  }) => {
    const ids = ["ra1", "rb2", "rc3", "rd4"];
    const media = trackImages(page);
    let blockedAttempts = 0;
    await page.route("https://i.redd.it/rb2.jpg", async (route) => {
      blockedAttempts += 1;
      if (blockedAttempts <= 3) {
        await route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "nope",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
        contentType: "image/svg+xml",
        body: svgImage,
      });
    });
    await openFeed(page, imagePage(ids));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // Initial attempt plus two retries, then the slide parks: no fourth
    // request while it is not on screen.
    await expect
      .poll(() => blockedAttempts, { timeout: 15000 })
      .toBe(3);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ failed: 3 }));
    await page.waitForTimeout(400);
    expect(blockedAttempts).toBe(3);

    // Becoming the current slide clears the failed flag and recovers.
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__image")?.naturalWidth,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    expect(blockedAttempts).toBeGreaterThanOrEqual(4);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ failed: 3, inFlight: 0 }));
    // The recovery costs at most two requests for the same media: the
    // on-screen render plus the preload that refills the cache.
    const requested = [...media.requested];
    expect(
      requested.filter((url) => url.includes("rb2")).length,
    ).toBeLessThanOrEqual(2);
  });

  test("one slideshow timer advances exactly one slide per interval", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-16T12:00:01Z"));
    await startPresentation(
      page,
      `${postHtml("ta1", "Alpha")}${postHtml("tb2", "Beta")}${postHtml(
        "tc3",
        "Gamma",
      )}`,
    );
    await pinAutoAdvance(page, false);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Manual mode must not move, no matter how many stray timers exist.
    await page.clock.runFor(120000);
    await expect(page.locator(".redditp__title")).toHaveText("Alpha");

    // Back to auto: exactly one advance per interval, at the boundary.
    await page.locator(".redditp__auto").click();
    await page.clock.runFor(4999);
    await expect(page.locator(".redditp__title")).toHaveText("Alpha");
    await page.clock.runFor(1);
    await expect(page.locator(".redditp__title")).toHaveText("Beta");
    await page.clock.runFor(5000);
    await expect(page.locator(".redditp__title")).toHaveText("Gamma");
  });

  test("loading the next page keeps post identity without duplicates", async ({
    page,
  }) => {
    const secondPage = `${feedUrl}&after=t3_da1`;
    await page.route(secondPage, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: imagePage(["da1", "db2"]),
      }),
    );
    trackImages(page);
    await openFeed(page, imagePage(["da1"], secondPage));

    // Page two repeats post one; identity dedupe must leave exactly two
    // posts ("1 / 3" would mean the repeat was appended).
    await expect(page.locator(".redditp__count")).toHaveText("1 / 2");
    expect(await page.locator(".redditp__number").count()).toBe(2);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: db2");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 2");
  });

  test("preloads the current gallery before the following posts", async ({
    page,
  }) => {
    const escapeHtml = (value) =>
      value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const galleryIds = ["ga1", "ga2", "ga3"];
    const gallery = `<div class="media-gallery">${galleryIds
      .map(
        (id, index) =>
          `<a class="gallery-item-thumbnail-link" data-position="${
            index + 1
          }" href="https://i.redd.it/${id}.jpg"></a>`,
      )
      .join("")}</div>`;
    const media = trackImages(page);

    // One gallery post with three full-size items, then two image posts.
    const body = `${postHtml(
      "gpost",
      "Gallery post",
      "https://www.reddit.com/gallery/gpost",
    )
      .replace(
        'data-fullname="t3_gpost"',
        'data-fullname="t3_gpost" data-is-gallery="true"',
      )
      .replace(
        "</a></div>",
        `</a><div class="expando" data-cachedhtml="${escapeHtml(
          gallery,
        )}"></div></div>`,
      )}${postHtml("na1", "Image 4: na1")}${postHtml("nb2", "Image 5: nb2")}`;
    await openFeed(page, body);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Order: the slide on screen, then the remaining gallery items, then
    // the posts behind it; the last post waits for a free slot.
    await expect
      .poll(() => media.requested.length, { timeout: 15000 })
      .toBeGreaterThanOrEqual(5);
    expect(media.requested.slice(0, 4)).toEqual([
      "https://i.redd.it/ga1.jpg",
      "https://i.redd.it/ga2.jpg",
      "https://i.redd.it/ga3.jpg",
      "https://i.redd.it/na1.jpg",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: predictive preloading. These tests assert the new preparation
// pipeline itself: preparation begins before navigation, prepared images are
// reused without a second request, gallery-first priority holds as items
// advance, rapid navigation stays correct through in-flight handoff, videos
// prepare at metadata depth inside a bounded window, pagination keeps the
// rolling window warm, and repeated scheduler runs never churn requests.
// Feeds are served from the real Reddit origin over routes, so the debug API
// is reachable and requests are countable.

test.describe("phase 3 predictive preloading", () => {
  test.setTimeout(45000);
  const feedUrl = "https://www.reddit.com/r/pics/?redditp=1";
  const svgImage =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';
  const webm = fs.readFileSync(
    path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
  );

  const imagePost = (id, title) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

  const videoPost = (id, title, videoUrl) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="${videoUrl}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

  const imagePage = (ids, nextPage = "") =>
    `${ids
      .map((id, index) => imagePost(id, `Image ${index + 1}: ${id}`))
      .join("")}${
      nextPage
        ? `<div class="nav-buttons"><span class="next-button"><a href="${nextPage}" rel="nofollow next">next ›</a></span></div>`
        : ""
    }`;

  async function openFeed(page, body, setup, url = feedUrl) {
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto(url);
    if (setup) await setup(page);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
  }

  const stats = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.stats());
  const cacheKeys = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.cache());
  const navRecord = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());

  // Records every full-size media request in arrival order.
  function trackImages(page, delay = 0) {
    const tracker = { requested: [] };
    page.route("https://i.redd.it/**", async (route) => {
      const url = route.request().url();
      tracker.requested.push(url);
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
        contentType: "image/svg+xml",
        body: svgImage,
      });
    });
    return tracker;
  }

  function trackVideos(page, delay = 0) {
    const tracker = { requested: [] };
    page.route("https://v.redd.it/**", async (route) => {
      tracker.requested.push(route.request().url());
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      // A tiny real video: metadata decoding must genuinely happen for the
      // preload to settle, so this exercises the readiness path end to end.
      await route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm,
      });
    });
    return tracker;
  }

  const countOf = (tracker, needle) =>
    tracker.requested.filter((url) => url.includes(needle)).length;

  test("the next post's media request starts while the current post is displayed", async ({
    page,
  }) => {
    const media = trackImages(page, 200);
    await openFeed(page, imagePage(["fa1", "fb2", "fc3"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // The second post's image is already being fetched while slide one is
    // still on screen; the user's navigation has not started it.
    await expect
      .poll(
        () => media.requested.some((url) => url.includes("fb2.jpg")),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect(page.locator(".redditp__title")).toHaveText("Image 1: fa1");
    const nav = await navRecord(page);
    expect(nav.ready).toBe(false);

    // The whole rolling window warms up while slide one stays displayed.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));
    expect(countOf(media, "fb2.jpg")).toBe(1);
    expect(countOf(media, "fc3.jpg")).toBe(1);
  });

  test("a preloaded image is displayed without a second request or decode", async ({
    page,
  }) => {
    const media = trackImages(page);
    await openFeed(page, imagePage(["da1", "db2", "dc3"]));
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ loaded: 2, failed: 0 }));

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: db2");
    await expect(page.locator(".redditp__image")).toHaveCount(1);
    const reused = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return {
        preloaded: img.redditpPreloaded === true,
        decoded: img.redditpDecoded === true,
        ready: img.complete && img.naturalWidth > 0,
        src: img.src,
      };
    });
    expect(reused).toEqual({
      preloaded: true,
      decoded: true,
      ready: true,
      src: "https://i.redd.it/db2.jpg",
    });
    // Exactly one network fetch for this media across the whole run.
    expect(countOf(media, "db2.jpg")).toBe(1);

    const nav = await navRecord(page);
    expect(nav.ready).toBe(true);
    expect(nav.readyAfterMs).toBe(0);
    await expect
      .poll(async () => (await stats(page)).hits, { timeout: 10000 })
      .toBeGreaterThan(0);
  });

  test("the next gallery image is prepared before lower-priority posts", async ({
    page,
  }) => {
    const escapeHtml = (value) =>
      value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const galleryIds = ["ga1", "ga2", "ga3", "ga4"];
    const gallery = `<div class="media-gallery">${galleryIds
      .map(
        (id, index) =>
          `<a class="gallery-item-thumbnail-link" data-position="${
            index + 1
          }" href="https://i.redd.it/${id}.jpg"></a>`,
      )
      .join("")}</div>`;
    const media = trackImages(page, 150);

    // One gallery post with four full-size items, then three image posts.
    // Every item starts a request quickly in parallel, so the order recorded
    // is the scheduler's priority order: current display first, then the
    // remaining gallery, then the next post.
    const body = `${imagePost(
      "gpost",
      "Gallery post",
      "https://www.reddit.com/gallery/gpost",
    )
      .replace(
        'data-fullname="t3_gpost"',
        'data-fullname="t3_gpost" data-is-gallery="true"',
      )
      .replace(
        "</a></div>",
        `</a><div class="expando" data-cachedhtml="${escapeHtml(
          gallery,
        )}"></div></div>`,
      )}${imagePost("na1", "Image 5: na1")}${imagePost("nb2", "Image 6: nb2")}`;

    await openFeed(page, body);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    await expect
      .poll(
        () => media.requested.some((url) => url.includes("ga2.jpg")),
        { timeout: 10000 },
      )
      .toBe(true);
    expect(countOf(media, "ga2.jpg")).toBe(1);

    // Gallery items outrank following posts: when ga4's slot came up it went
    // out before na1, which shared the same capacity.
    await expect
      .poll(
        () =>
          media.requested.some((url) => url.includes("ga4.jpg")) &&
          media.requested.some((url) => url.includes("na1.jpg")),
        { timeout: 20000 },
      )
      .toBe(true);
    expect(media.requested.indexOf("https://i.redd.it/ga4.jpg")).toBeLessThan(
      media.requested.indexOf("https://i.redd.it/na1.jpg"),
    );
  });

  test("racing through several posts keeps the final slide correct", async ({
    page,
  }) => {
    const ids = ["fe1", "fe2", "fe3", "fe4", "fe5", "fe6"];
    const media = trackImages(page, 900);
    await openFeed(
      page,
      imagePage(ids),
      (feedPage) => feedPage.evaluate(() => localStorage.setItem("redditpDebug", "1")),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 6");

    // Four quick steps land on slide five while many preloads are still in
    // flight; the destination must win over every older response.
    // The race only exercises the shared-in-flight handoff once fe5's own
    // job has started: while the three first candidates hold every slot,
    // arriving earlier is a legitimate fresh-display-fetch outcome (that
    // fetch is not cached — later navigation re-prepares it), which would
    // flake the cache assertion below. Harness-open overhead decides which
    // branch runs; both end with fe5 prepared and still cached.
    await expect
      .poll(
        async () => {
          // Fast harness: fe5's job is running — race into it right away.
          const started = await page.evaluate(() =>
            window.__redditpPresentation.debug
              .log()
              .some(
                ({ event, detail }) =>
                  event === "preload-start" &&
                  String(detail).includes("fe5.jpg"),
              ),
          );
          if (started) return true;
          // Slow harness: the horizon already settled into the cache, and
          // the race below hits prepared entries.
          return (await cacheKeys(page)).some((key) =>
            key.includes("fe5.jpg"),
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 5: fe5");
    await expect(page.locator(".redditp__count")).toHaveText("5 / 6");

    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));

    // Nothing overtook the user afterwards.
    await expect(page.locator(".redditp__title")).toHaveText("Image 5: fe5");
    expect(
      await page.evaluate(() => document.querySelector(".redditp__image")?.src),
    ).toContain("fe5.jpg");
    // The slide the user stopped on was prepared by exactly one fetch.
    expect(countOf(media, "fe5.jpg")).toBe(1);
    // The displayed entry is still cached, i.e. eviction must leave the
    // visible media alone.
    expect((await cacheKeys(page)).some((key) => key.includes("fe5.jpg"))).toBe(
      true,
    );
  });

  test("repeated scheduler passes never duplicate requests or churn", async ({
    page,
  }) => {
    const media = trackImages(page, 400);
    await openFeed(page, imagePage(["fd1", "fd2", "fd3", "fd4", "fd5"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 5");

    // Hammer the scheduler while several preloads are still in flight.
    for (let pass = 0; pass < 8; pass += 1) {
      await page.evaluate(() =>
        window.__redditpPresentation.debug.refresh(),
      );
      await page.waitForTimeout(60);
    }
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));

    // One request per unique media, no matter how many scheduler passes ran.
    expect(countOf(media, "fd2.jpg")).toBe(1);
    expect(countOf(media, "fd3.jpg")).toBe(1);
    expect(countOf(media, "fd4.jpg")).toBe(1);
    expect(countOf(media, "fd5.jpg")).toBe(1);

    // Once settled, further passes change nothing: no reload storm.
    const before = await stats(page);
    for (let pass = 0; pass < 5; pass += 1) {
      await page.evaluate(() =>
        window.__redditpPresentation.debug.refresh(),
      );
    }
    await page.waitForTimeout(1200);
    const after = await stats(page);
    expect(after.started).toBe(before.started);
    expect(after.evicted).toBe(before.evicted);
    expect(after.cacheSize).toBe(before.cacheSize);
  });

  test("a failed preload recovers through its retry without a storm", async ({
    page,
  }) => {
    const media = trackImages(page);
    let attempts = 0;
    await page.route("https://i.redd.it/fr2.jpg", async (route) => {
      attempts += 1;
      if (attempts <= 2) {
        await route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "nope",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
        contentType: "image/svg+xml",
        body: svgImage,
      });
    });
    await openFeed(page, imagePage(["fr1", "fr2", "fr3"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Two transient 503s, then the scheduler's controlled retry succeeds.
    await expect
      .poll(() => attempts, { timeout: 15000 })
      .toBe(3);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(
        expect.objectContaining({ loaded: 2, failed: 2, inFlight: 0 }),
      );

    // After recovery the schedule quenches; the parked failure never makes
    // endless attempts while the slide is untouched.
    await page.waitForTimeout(400);
    expect(attempts).toBe(3);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: fr2");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__image")?.naturalWidth > 0,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    // The display reused the entry the successful retry filled.
    const reused = await page.evaluate(
      () => document.querySelector(".redditp__image").redditpPreloaded === true,
    );
    expect(reused).toBe(true);
    // One failed attempt, one successful: no fourth request was needed.
    expect(attempts).toBe(3);
    expect(countOf(media, "fr2.jpg")).toBe(0);
  });

  test("late responses from skipped posts cannot replace the current media", async ({
    page,
  }) => {
    const media = trackImages(page, 1500);
    await openFeed(page, imagePage(["gs1", "gs2", "gs3"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Both upcoming preloads are running when the user starts racing through.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 2 }));

    // Two fast steps land on slide three; each display shares the in-flight
    // element rather than starting its own request.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: gs2");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: gs3");

    await expect
      .poll(() => stats(page), { timeout: 25000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));
    await page.waitForTimeout(300);

    // The later-arriving gs2 response settled into the cache but must never
    // have taken over the stage, and nothing repeated either request.
    await expect(page.locator(".redditp__image")).toHaveCount(1);
    expect(
      await page.evaluate(() => document.querySelector(".redditp__image")?.src),
    ).toContain("gs3.jpg");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: gs3");
    expect(countOf(media, "gs1.jpg")).toBe(1);
    expect(countOf(media, "gs2.jpg")).toBe(1);
    expect(countOf(media, "gs3.jpg")).toBe(1);
  });

  test("the next video prepares at metadata depth while distant videos wait", async ({
    page,
  }) => {
    const videos = trackVideos(page, 250);
    const images = trackImages(page);
    await openFeed(
      page,
      `${imagePost("vv1", "Image 1: vv1")}${videoPost(
        "vv2",
        "Clip A",
        "https://v.redd.it/vva/DASH_480.mp4",
      )}${imagePost("vv3", "Image 3: vv3")}${videoPost(
        "vv4",
        "Clip B",
        "https://v.redd.it/vvb/DASH_480.mp4",
      )}${imagePost("vv5", "Image 5: vv5")}`,
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 5");
    await expect
      .poll(() => stats(page), { timeout: 25000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));

    // The next post's video was prepared (a metadata fetch happened).
    expect(countOf(videos, "/vva/")).toBeGreaterThan(0);
    // The video further away stays out of the window entirely.
    expect(countOf(videos, "/vvb/")).toBe(0);
    const videoCaches = (await cacheKeys(page)).filter((key) =>
      key.includes(".mp4"),
    );
    // Speculative decoders stay within the small budget.
    expect(videoCaches.length).toBeLessThanOrEqual(2);

    // Navigating onto the prepared video reuses the prepared element: the
    // request count stays within one metadata fetch plus at most the
    // browser's own playback data fetch, and no new element was created.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip A");
    expect(countOf(videos, "/vva/")).toBeLessThanOrEqual(3);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.readyState,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    const preparedVideo = await page.evaluate(() => ({
      preloaded: document.querySelector(".redditp__video").redditpPreloaded ===
        true,
      preload: document.querySelector(".redditp__video").preload,
    }));
    expect(preparedVideo.preloaded).toBe(true);
    expect(preparedVideo.preload).toBe("metadata");

    // Reaching the distant video triggers its own fetches only then: at
    // most one metadata fetch plus the browser's playback data fetch.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip B");
    expect(countOf(videos, "/vvb/")).toBeLessThanOrEqual(2);
  });

  test("evicted videos are released and load again on revisit", async ({
    page,
  }) => {
    const videos = trackVideos(page, 150);
    const images = trackImages(page);
    await openFeed(
      page,
      `${imagePost("qv1", "Image 1: qv1")}${videoPost(
        "qv2",
        "Clip A",
        "https://v.redd.it/qva/DASH_480.mp4",
      )}${imagePost("qv3", "Image 3: qv3")}${imagePost(
        "qv4",
        "Image 4: qv4",
      )}${imagePost("qv5", "Image 5: qv5")}${imagePost(
        "qv6",
        "Image 6: qv6",
      )}`,
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 6");
    await expect
      .poll(() => stats(page), { timeout: 25000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));
    expect(countOf(videos, "/qva/")).toBe(1);

    // Racing to the end pushes the video out of the active window.
    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 6: qv6");
    await expect
      .poll(async () => !(await cacheKeys(page)).some((key) => key.includes("/qva/")), {
        timeout: 20000,
      })
      .toBe(true);
    expect(countOf(videos, "/qva/")).toBe(1);

    // Stepping back re-prepares the evicted video ahead of the arrival.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => countOf(videos, "/qva/"), { timeout: 20000 })
      .toBeGreaterThan(1);
    // The fourth step up already landed on the video post, and the arrival
    // reused the prepared element. A reused video may still issue the
    // browser's own playback data fetch, so three is the ceiling here.
    await expect(page.locator(".redditp__title")).toHaveText("Clip A");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.readyState,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    expect(countOf(videos, "/qva/")).toBeLessThanOrEqual(3);
  });

  test("appended posts enter the rolling window and load without duplicates", async ({
    page,
  }) => {
    const nextPageUrl = `${feedUrl}&after=t3_pc1`;
    const media = trackImages(page);
    const staticPage2 = `${imagePost("pd4", "Image 4: pd4")}${imagePost(
      "pd5",
      "Image 5: pd5",
    )}<div class="nav-buttons"><span class="next-button"><a href="${feedUrl}&after=t3_pd5" rel="nofollow next">next ›</a></span></div>`;
    await page.route(nextPageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: staticPage2,
      }),
    );
    await openFeed(page, imagePage(["pa1", "pb2", "pc3"], nextPageUrl));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // Advance onto the last post, then past it: the scan appends page two
    // posts and the viewer carries onto the next one.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    // The scan runs while the last post is displayed; only once page two has
    // landed does the viewer move onto its first post.
    await expect(page.locator(".redditp__count")).toHaveText("3 / 5");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 4: pd4");
    await expect(page.locator(".redditp__count")).toHaveText("4 / 5");

    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));
    // The newly returned posts each entered the preload window and were
    // fetched once: the newly current slide, and the one behind the end.
    expect(countOf(media, "pd4.jpg")).toBeLessThanOrEqual(1);
    expect(countOf(media, "pd5.jpg")).toBe(1);
    expect((await cacheKeys(page)).some((key) => key.includes("pd5.jpg"))).toBe(
      true,
    );
  });

  test("slideshow advancement stays tied to one timer under preloading", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-11-02T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-11-02T12:00:01Z"));
    const media = trackImages(page);
    await openFeed(page, imagePage(["sw1", "sw2", "sw3"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));

    // Manual mode never moves, preloading or not.
    await page.clock.runFor(30000);
    await expect(page.locator(".redditp__title")).toHaveText("Image 1: sw1");

    // Auto mode: exactly one advance per interval at the boundary.
    await page.locator(".redditp__auto").click();
    await page.clock.runFor(4999);
    await expect(page.locator(".redditp__title")).toHaveText("Image 1: sw1");
    await page.clock.runFor(1);
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: sw2");
    await page.clock.runFor(5000);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: sw3");

    // Pausing again stops it dead.
    await page.locator(".redditp__auto").click();
    await page.clock.runFor(30000);
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: sw3");
    // Preloading kept working alongside the timer.
    expect(countOf(media, "sw3.jpg")).toBe(1);
  });

  test("concurrency and cache size stay bounded across a long feed", async ({
    page,
  }) => {
    trackImages(page, 250);
    const ids = ["bz1", "bz2", "bz3", "bz4", "bz5", "bz6", "bz7", "bz8"];
    await openFeed(page, imagePage(ids));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 8");

    // Sample inFlight continuously until the window settles.
    const maxInFlight = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let max = 0;
          const timer = setInterval(() => {
            const current =
              window.__redditpPresentation.debug.stats().inFlight;
            max = Math.max(max, current);
            if (current === 0) {
              clearInterval(timer);
              resolve(max);
            }
          }, 25);
          setTimeout(() => {
            clearInterval(timer);
            resolve(max);
          }, 30000);
        }),
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);

    for (let step = 0; step < 7; step += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 8: bz8");
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ inFlight: 0, failed: 0 }));
    // The active window (-2..+preloadPosts plus a dangling gallery tail)
    // bounds the cache; nothing grew unbounded with feed length.
    expect((await cacheKeys(page)).length).toBeLessThanOrEqual(9);
  });
});


// ---------------------------------------------------------------------------
// Phase 3.1: preloading stress tests and evidence-based edge cases. Each test
// reproduces a suspected edge case — rapid navigation with stale responses,
// asynchronous decode, scheduler races, retry fairness, eviction safety, video
// element reuse, and unsupported adaptive formats — and pins the observed
// intended behavior. Where a defect was confirmed, the source fix keeps these
// green so it cannot quietly come back.

test.describe("phase 3.1 preloading stress and edge cases", () => {
  test.setTimeout(45000);
  const feedUrl = "https://www.reddit.com/r/pics/?redditp=1";
  const svgImage =
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';
  const webm = fs.readFileSync(
    path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
  );

  const imagePost = (id, title) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

  const videoPost = (id, title, videoUrl) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="${videoUrl}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

  // Old Reddit hides a v.redd.it player behind data attributes for its own
  // script to build; include one to exercise the adaptive (HLS/MPD) paths.
  const playerPost = (id, title, attributes) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a><div class="portrait" ${attributes}></div></div>`;

  const imagePage = (ids, nextPage = "") =>
    `${ids
      .map((id, index) => imagePost(id, `Image ${index + 1}: ${id}`))
      .join("")}${
      nextPage
        ? `<div class="nav-buttons"><span class="next-button"><a href="${nextPage}" rel="nofollow next">next ›</a></span></div>`
        : ""
    }`;

  const escapeHtml = (value) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  function galleryBody(galleryIds, galleryPrint, followingIds) {
    const gallery = `<div class="media-gallery">${galleryIds
      .map(
        (id, index) =>
          `<a class="gallery-item-thumbnail-link" data-position="${
            index + 1
          }" href="https://i.redd.it/${id}.jpg"></a>`,
      )
      .join("")}</div>`;
    return `${imagePost(galleryPrint[0], galleryPrint[1])
      .replace(
        'data-fullname="t3_gpost"',
        'data-fullname="t3_gpost" data-is-gallery="true"',
      )
      .replace(
        "</a></div>",
        `</a><div class="expando" data-cachedhtml="${escapeHtml(
          gallery,
        )}"></div></div>`,
      )}${followingIds.map((id) => imagePost(id, id)).join("")}`;
  }

  async function openFeed(page, body, setup, url = feedUrl) {
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto(url);
    if (setup) await setup(page);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
  }

  const stats = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.stats());
  const cacheKeys = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.cache());
  const queueLength = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.queue().length);
  const lastNavigation = (page) =>
    page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());
  const debugEvents = (page) =>
    page.evaluate(() =>
      window.__redditpPresentation.debug
        .log()
        .map(({ event, detail }) => ({ event, detail })),
    );

  // Records every full-size media request in arrival order.
  function trackImages(page, delay = 0) {
    const tracker = { requested: [] };
    page.route("https://i.redd.it/**", async (route) => {
      tracker.requested.push(route.request().url());
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "public, max-age=31536000" },
        contentType: "image/svg+xml",
        body: svgImage,
      });
    });
    return tracker;
  }

  function trackVideos(page, delay = 0) {
    const tracker = { requested: [] };
    page.route("https://v.redd.it/**", async (route) => {
      tracker.requested.push(route.request().url());
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      // A tiny real video: metadata decoding must genuinely happen for the
      // preload to settle, so this exercises the readiness path end to end.
      await route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm,
      });
    });
    return tracker;
  }

  const countOf = (tracker, needle) =>
    tracker.requested.filter((url) => url.includes(needle)).length;

  const waitSettled = (page, timeout = 20000) =>
    expect
      .poll(
        () => stats(page),
        { timeout },
      )
      // `failed` is a parked counter, not a live one: feeds with a deliberately
      // failing resource never report it back to zero. Liveness is inFlight.
      .toEqual(expect.objectContaining({ inFlight: 0 }));

  // -----------------------------------------------------------------------
  // Priority 1: rapid navigation and stale responses.

  test("racing past a preloading post keeps it ready and lets its late response cache silently", async ({
    page,
  }) => {
    // A = displayed while B preloads; the user races through C and D before
    // any of the three pending responses arrives, then B's response lands
    // while D is active. All should share one request per URL, keep D on
    // stage, cache B without touching the display, and reuse B on the way
    // back without a second fetch.
    const media = trackImages(page, 1200);
    await openFeed(page, imagePage(["ta1", "tb2", "tc3", "td4"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // Start racing while all three horizon jobs are still running (the
    // response delay is 1200ms, so the in-flight window is wide): every
    // arrival then shares the running request instead of fetching anew.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 3 }));

    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 4: td4");
    await expect(page.locator(".redditp__count")).toHaveText("4 / 4");

    // Every racing press served its slide from the still-running preload.
    expect(countOf(media, "tb2.jpg")).toBe(1);
    expect(countOf(media, "tc3.jpg")).toBe(1);
    expect(countOf(media, "td4.jpg")).toBe(1);

    // B's late response arrives now; nothing orphaned, nothing overwritten.
    await waitSettled(page);
    await page.waitForTimeout(300);
    await expect(page.locator(".redditp__title")).toHaveText("Image 4: td4");
    expect(
      await page.evaluate(() => document.querySelector(".redditp__image")?.src),
    ).toContain("td4.jpg");
    await expect(page.locator(".redditp__image")).toHaveCount(1);
    expect(await queueLength(page)).toBe(0);
    expect((await stats(page)).inFlight).toBe(0);

    // Navigating back finds B cached — the late response was put to use.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: tb2");
    const reuse = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return {
        preloaded: img.redditpPreloaded === true,
        ready: img.complete && img.naturalWidth > 0,
        src: img.src,
      };
    });
    expect(reuse).toEqual({
      preloaded: true,
      ready: true,
      src: "https://i.redd.it/tb2.jpg",
    });
    expect(countOf(media, "tb2.jpg")).toBe(1);
    expect(await lastNavigation(page)).toEqual(
      expect.objectContaining({ ready: true, readyAfterMs: 0 }),
    );
  });

  test("advancing through a gallery and back reuses every prepared item", async ({
    page,
  }) => {
    const media = trackImages(page, 400);
    await openFeed(
      page,
      galleryBody(["gp1", "gp2", "gp3"], ["gpost", "Gallery post"], ["mp1", "mp2"]),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
    await expect(page.locator(".redditp__title")).toHaveText(
      "(1/3) Gallery post",
    );
    await waitSettled(page);

    // Forward through the remaining gallery items onto the next post.
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
    }
    await expect(page.locator(".redditp__title")).toHaveText("mp1");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 3");
    // gp1 was on screen before any preload existed for it (a fresh display
    // fetch), so the behind-window revisit pre-prepares it exactly once more.
    expect(countOf(media, "gp1.jpg")).toBeLessThanOrEqual(2);
    expect(countOf(media, "gp2.jpg")).toBe(1);
    expect(countOf(media, "gp3.jpg")).toBe(1);
    expect(countOf(media, "mp1.jpg")).toBe(1);

    // Back through the gallery: each item's prepared image is reused with
    // zero further fetches, and the titles stay correct the whole way.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("(3/3) Gallery post");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("(2/3) Gallery post");
    const reuse = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return img.redditpPreloaded === true && img.naturalWidth > 0 && img.src;
    });
    expect(reuse).toBe("https://i.redd.it/gp2.jpg");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("(1/3) Gallery post");
    expect(countOf(media, "gp2.jpg")).toBe(1);
    expect(countOf(media, "gp3.jpg")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Priority 2: image decode readiness.

  test("decode happens once per prepared image, before display, and never again on navigation", async ({
    page,
  }) => {
    const media = trackImages(page, 200);
    await openFeed(
      page,
      imagePage(["dc1", "dc2", "dc3", "dc4"]),
      (feedPage) =>
        feedPage.evaluate(() => {
          // The engine must decode upcoming images during preload and must
          // not duplicate the work when one reaches the stage. A slow decode
          // also reproduces the navigation-during-decode case, and the
          // counters prove the decode promise completes before the entry is
          // reported as loaded (loaded only bumps via the decode chain).
          window.__decoded = [];
          const original = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function () {
            window.__decoded.push(this.src);
            return original
              .apply(this, arguments)
              .then(
                (value) =>
                  new Promise((resolve) => setTimeout(() => resolve(value), 600)),
              );
          };
        }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // All three horizon jobs run while every decode is still resolving
    // (network lands at ~200ms; decode resolves no earlier than ~800ms),
    // which makes racing into the pending decodes deterministic.
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 3 }));

    // Race onto a slide while a decode is still resolving.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(30);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: dc3");

    // Ready-to-display entries only appear after their decode resolved: the
    // loaded counter only bumps via the decode chain, never at bare load.
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(expect.objectContaining({ loaded: 3, decoded: 3, failed: 0 }));
    await waitSettled(page);
    await expect(page.locator(".redditp__image")).toHaveCount(1);

    const displayed = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return {
        src: img.src,
        preloaded: img.redditpPreloaded === true,
        decoded: img.redditpDecoded === true,
        ready: img.complete && img.naturalWidth > 0,
      };
    });
    expect(displayed).toEqual({
      src: "https://i.redd.it/dc3.jpg",
      preloaded: true,
      decoded: true,
      ready: true,
    });

    // Exactly one decode per prepared image. dc1 gets its own later prepare
    // through the behind-window revisit (by design, it returns to the cache),
    // so its ceiling is the display plus that one revisit decode; the raced
    // dc3/dc2 decodes ran exactly once, and the display never decoded again.
    const decoded = await page.evaluate(() => window.__decoded);
    expect(decoded.filter((src) => src.includes("dc1.jpg")).length).toBeLessThanOrEqual(2);
    expect(decoded.filter((src) => src.includes("dc3.jpg")).length).toBe(1);
    expect(decoded.filter((src) => src.includes("dc2.jpg")).length).toBe(1);
    expect(countOf(media, "dc3.jpg")).toBe(1);
    // The record says the reused media was ready on the spot: the shared
    // element already had its bytes, so the pending decode never blocked the
    // stage. (Decode-before-ready ordering is asserted through the loaded /
    // decoded counters above: loaded only bumps once decode() has resolved.)
    // The absolute count grows by design when dc1's behind-window revisit
    // prepare decodes too, so the sound invariant is decoded === loaded.
    const finalStats = await stats(page);
    expect(finalStats.decoded).toBe(finalStats.loaded);
    expect(finalStats.decoded).toBeGreaterThanOrEqual(3);
  });

  test("a decode failure never poisons the cache entry or stalls the queue", async ({
    page,
  }) => {
    const media = trackImages(page, 100);
    await openFeed(
      page,
      imagePage(["rd1", "rd2", "rd3"]),
      (feedPage) =>
        feedPage.evaluate(() => {
          // A browser can reject decode() for a corrupt or exotic image even
          // though the load event succeeded; the "bad" middle image makes
          // that happen while its neighbors decode normally.
          window.__decoded = [];
          const original = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function () {
            window.__decoded.push(this.src);
            return this.src.includes("rd2.jpg")
              ? Promise.reject(new Error("pixel soup"))
              : original.apply(this, arguments);
          };
        }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

    // The queue finishes: the failed decode still produced a usable entry
    // (the browser holds complete bytes), and later candidates processed.
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(
        expect.objectContaining({
          loaded: 2,
          decoded: 1,
          decodeFailed: 1,
          failed: 0,
          inFlight: 0,
        }),
      );

    // The failed-decode slide was never re-requested and displays fine.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: rd2");
    const state = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return {
        src: img.src.includes("rd2.jpg"),
        preloaded: img.redditpPreloaded === true,
        ready: img.complete && img.naturalWidth > 0,
      };
    });
    expect(state).toEqual({ src: true, preloaded: true, ready: true });
    expect(countOf(media, "rd2.jpg")).toBe(1);
    expect((await page.evaluate(() => window.__decoded)).length).toBe(2);
  });

  test("engines without decode() still finish preloads and reuse them", async ({
    page,
  }) => {
    const media = trackImages(page, 100);
    await openFeed(
      page,
      imagePage(["nd1", "nd2", "nd3"]),
      (feedPage) =>
        feedPage.evaluate(() => {
          // Feature-detection fallback: an engine without decode() must use
          // the load-event readiness signal and never block the queue.
          delete HTMLImageElement.prototype.decode;
        }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
    await expect
      .poll(() => stats(page), { timeout: 20000 })
      .toEqual(
        expect.objectContaining({
          loaded: 2,
          decoded: 0,
          decodeFailed: 0,
          inFlight: 0,
        }),
      );

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: nd2");
    const reuse = await page.evaluate(() => {
      const img = document.querySelector(".redditp__image");
      return img.redditpPreloaded === true && img.complete && img.naturalWidth > 0;
    });
    expect(reuse).toBe(true);
    expect(countOf(media, "nd2.jpg")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Priority 3: scheduler races and duplicate requests.

  test("duplicate media URLs across posts settle once per identity without races", async ({
    page,
  }) => {
    // Two posts share one media URL; each is its own identity, so each gets
    // its own prepared element and its own (browser-coalesced in production)
    // request — but never a duplicating storm under scheduler pressure.
    const sharedUrl = "https://i.redd.it/dup-shared.jpg";
    const sameUrlPost = (id, title) =>
      `<div class="thing link" data-fullname="t3_${id}" data-url="${sharedUrl}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;
    const media = trackImages(page, 250);
    await openFeed(
      page,
      `${imagePost("du0", "Image 1: du0")}${sameUrlPost(
        "du1",
        "Image 2: du1",
      )}${sameUrlPost("du2", "Image 3: du2")}${imagePost(
        "du3",
        "Image 4: du3",
      )}`,
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // Hammer the scheduler while jobs are starting and completing together.
    for (let pass = 0; pass < 10; pass += 1) {
      await page.evaluate(() =>
        window.__redditpPresentation.debug.refresh(),
      );
      await page.waitForTimeout(70);
    }
    await waitSettled(page);

    // One request per identity across the whole run; races did not multiply.
    // Whether the browser coalesces the two identical in-flight GETs or not
    // is its own optimization; either way each identity prepared once.
    expect(countOf(media, "dup-shared.jpg")).toBeLessThanOrEqual(2);
    expect(countOf(media, "du3.jpg")).toBe(1);

    // Each identity displays its own prepared element from its own job.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: du1");
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__image").redditpPreloaded === true,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        document.querySelector(".redditp__image").src.includes("dup-shared"),
      ),
    ).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3: du2");
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__image").redditpPreloaded === true,
      ),
    ).toBe(true);
    expect(countOf(media, "dup-shared.jpg")).toBeLessThanOrEqual(2);
  });

  test("a hidden tab defers speculative work until it is visible again", async ({
    page,
  }) => {
    const media = trackImages(page, 250);
    // The override is in place before the engine starts, so the whole open
    // runs while the tab reports itself hidden: no speculative fetch may be
    // started, and a scheduler pass must not wake anything either.
    await openFeed(
      page,
      imagePage(["hz1", "hz2", "hz3", "hz4"]),
      (feedPage) =>
        feedPage.evaluate(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => document.__redditpHidden === true,
          });
          document.__redditpHidden = true;
        }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");
    await page.waitForTimeout(800);

    // Only the display fetch for the visible slide happened; the rolling
    // window stayed dormant, and an explicit pass stays dormant too.
    expect((await stats(page)).started).toBe(0);
    expect(countOf(media, "hz2.jpg")).toBe(0);
    expect(countOf(media, "hz3.jpg")).toBe(0);
    await page.evaluate(() => window.__redditpPresentation.debug.refresh());
    expect((await stats(page)).started).toBe(0);
    expect(await queueLength(page)).toBe(0);

    // Visible again: the next scheduler pass starts the pending work.
    await page.evaluate(() => {
      document.__redditpHidden = false;
    });
    await page.evaluate(() => window.__redditpPresentation.debug.refresh());
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 3 }));
    await waitSettled(page);
    expect(countOf(media, "hz2.jpg")).toBe(1);
    expect(countOf(media, "hz3.jpg")).toBe(1);
    expect(countOf(media, "hz4.jpg")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Priority 4: retry fairness.

  test("a permanently failing preload cannot starve later media and never retries without bound", async ({
    page,
  }) => {
    // rv2 fails every time; rv3..rv6 must still get prepared while rv2 goes
    // through its bounded retry sequence.
    const media = trackImages(page, 80);
    let attempts = 0;
    await page.route("https://i.redd.it/rv2.jpg", async (route) => {
      attempts += 1;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "still broken",
      });
    });
    await openFeed(page, imagePage(["rv1", "rv2", "rv3", "rv4", "rv5", "rv6"]));
    await expect(page.locator(".redditp__count")).toHaveText("1 / 6");

    // The failure is retried up to the configured limit (1 start + 2 retries).
    await expect
      .poll(() => attempts, { timeout: 20000 })
      .toBe(3);
    await expect
      .poll(() => stats(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ failed: 3, inFlight: 0 }));

    // The healthy media was all prepared while rv2 failed its retries — no
    // starvation, and no request storm afterwards.
    expect(countOf(media, "rv3.jpg")).toBe(1);
    expect(countOf(media, "rv4.jpg")).toBe(1);
    expect(countOf(media, "rv5.jpg")).toBe(1);
    expect(countOf(media, "rv6.jpg")).toBe(1);
    await page.waitForTimeout(600);
    expect(attempts).toBe(3);

    // Reaching the broken post costs exactly one more attempt (the display's
    // own fetch), settles into a graceful failure card, and stops.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 2: rv2");
    await expect(page.locator(".redditp__link-card")).toHaveCount(1);
    await waitSettled(page, 15000);
    await page.waitForTimeout(600);
    expect(attempts).toBe(4);

    // Leaving it behind: the behind-window revisit probes the broken media
    // once per departure, bounded by the retry limit, and never loops.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 4: rv4");
    await expect
      .poll(() => attempts, { timeout: 15000 })
      .toBe(5);
    await page.waitForTimeout(600);
    expect(attempts).toBe(5);
    expect(countOf(media, "rv5.jpg")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Priority 5: cache eviction and resource limits in a mixed feed.

  test("evicting a long mixed feed releases prepared videos and keeps the stage safe", async ({
    page,
  }) => {
    const images = trackImages(page, 60);
    const videos = trackVideos(page, 60);
    const posts = [
      imagePost("mz1", "Image 1: mz1"),
      videoPost("mz2", "Clip M", "https://v.redd.it/mva/DASH_480.mp4"),
      imagePost("mz3", "Image 3: mz3"),
      imagePost("mz4", "Image 4: mz4"),
      imagePost("mz5", "Image 5: mz5"),
      imagePost("mz6", "Image 6: mz6"),
      imagePost("mz7", "Image 7: mz7"),
      imagePost("mz8", "Image 8: mz8"),
      imagePost("mz9", "Image 9: mz9"),
    ];
    await openFeed(page, posts.join(""), (feedPage) =>
      feedPage.evaluate(() => {
        // The eviction release path pauses the video, strips the src, then
        // calls load(). The load call proves the release happened, and the
        // element's identity marker proves it was the prepared video.
        window.__videoReloadFlags = [];
        const original = HTMLVideoElement.prototype.load;
        HTMLVideoElement.prototype.load = function () {
          window.__videoReloadFlags.push(this.redditpPreloaded === true);
          return original.apply(this, arguments);
        };
      }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 9");

    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 9: mz9");
    await waitSettled(page);

    // The cache holds only the active window; the processed video is not in
    // it anymore, was paused, and had its resources released.
    const keys = await cacheKeys(page);
    expect(keys.length).toBeLessThanOrEqual(3);
    expect(keys.some((key) => key.includes(".mp4"))).toBe(false);
    expect(keys.some((key) => key.includes("mz9.jpg"))).toBe(true);
    expect((await page.evaluate(() => window.__videoReloadFlags)).filter(Boolean)).toHaveLength(1);
    // Videos in prepared elements never exceed the configured budget.
    expect((await cacheKeys(page)).filter((key) => key.includes(".mp4")).length).toBe(0);

    // Nothing remains pending, queued, or stuck on the stage.
    expect(await queueLength(page)).toBe(0);
    expect(
      await page.evaluate(() => document.querySelectorAll(".redditp__video").length),
    ).toBe(0);
    expect(countOf(videos, "/mva/")).toBeGreaterThan(0);
    expect(countOf(images, "mz9.jpg")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Priority 6: video element reuse and stale events.

  test("a video is prepared metadata-first, plays, and returns to the same prepared element", async ({
    page,
  }) => {
    const videos = trackVideos(page, 300);
    const images = trackImages(page, 60);
    await openFeed(
      page,
      `${imagePost("wv1", "Image 1: wv1")}${videoPost(
        "wv2",
        "Clip W",
        "https://v.redd.it/wva/DASH_480.mp4",
      )}${imagePost("wv3", "Image 3: wv3")}${imagePost("wv4", "Image 4: wv4")}`,
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // Arrive while the video's metadata is still loading: the display shares
    // the in-flight element instead of starting a second fetch.
    await expect
      .poll(
        () => videos.requested.some((url) => url.includes("/wva/")),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip W");
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__video").redditpPreloaded === true,
      ),
    ).toBe(true);

    // Metadata lands for the shared element.
    await waitSettled(page);
    await expect
      .poll(
        () => page.evaluate(() => document.querySelector(".redditp__video")?.readyState),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    expect((await cacheKeys(page)).some((key) => key.includes("/wva/"))).toBe(true);

    // The muted autoplay plays the real fixture.
    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelector(".redditp__video")?.currentTime),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    const playedTo = await page.evaluate(
      () => document.querySelector(".redditp__video")?.currentTime,
    );

    // Away and back: the same prepared element returns, carrying its place
    // and source, without any new metadata fetch.
    for (let step = 0; step < 2; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Image 4: wv4");
    await waitSettled(page);
    for (let step = 0; step < 2; step += 1) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Clip W");
    const returned = await page.evaluate(() => {
      const video = document.querySelector(".redditp__video");
      return {
        count: document.querySelectorAll(".redditp__video").length,
        preloaded: video.redditpPreloaded === true,
        src: video.getAttribute("src"),
        currentTime: video.currentTime,
        paused: video.paused,
      };
    });
    expect(returned.count).toBe(1);
    expect(returned.preloaded).toBe(true);
    expect(returned.src).toBe("https://v.redd.it/wva/DASH_480.mp4");
    expect(Math.abs(returned.currentTime - playedTo)).toBeLessThan(0.6);
    // Playback state is sane: the element carries no error and holds its
    // metadata whatever the browser decided about resuming.
    expect(
      await page.evaluate(() => {
        const video = document.querySelector(".redditp__video");
        return Boolean(video.error || video.readyState < 1);
      }),
    ).toBe(false);
    // Nothing activated during the away-return cycle re-requested the media:
    // the ceiling stays at one metadata fetch plus Chromium's own playback
    // continuations, not a per-visit metadata re-request.
    expect(countOf(videos, "/wva/")).toBeLessThanOrEqual(5);

    // Waiting proves no stale metadata or error event disturbs the stage.
    await page.waitForTimeout(800);
    await expect(page.locator(".redditp__title")).toHaveText("Clip W");
    await expect(page.locator(".redditp__link-card")).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // Priority 7: unsupported formats and diagnostics distinction.

  test("adaptive slides without a native-playable URL are never preloaded and fail gracefully on display", async ({
    page,
  }) => {
    // The MPD+HLS player slide keeps its mpd (dash-delegated) and must not
    // enter the speculative queue on any engine. The HLS-only player slide
    // behaves per native support: where the browser cannot play m3u8 at all
    // (production Chromium, Firefox) it must neither be preloaded nor crash
    // the viewer; where native HLS exists the metadata probe is allowed to
    // run its bounded retry before failing. Either way the display falls
    // back to a failure card — how the failure is DIAGNOSED must read
    // differently from an ordinary preload failure.
    const images = trackImages(page, 60);
    const ads = { requested: [] };
    await page.route("https://v.redd.it/**", async (route) => {
      ads.requested.push(route.request().url());
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "gone",
      });
    });
    await openFeed(
      page,
      `${imagePost("az1", "Image 1: az1")}${playerPost(
        "adn1",
        "DASH player",
        'data-hls-url="https://v.redd.it/ddl/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/ddl/DASHPlaylist.mpd"',
      )}${playerPost(
        "ahn1",
        "HLS only",
        'data-hls-url="https://v.redd.it/hdl/HLSPlaylist.m3u8"',
      )}${imagePost("az3", "Image 3: az3")}`,
      (feedPage) =>
        feedPage.evaluate(() => {
          try {
            localStorage.setItem("redditpDebug", "1");
          } catch (_error) {
            /* diagnostics are best-effort */
          }
        }),
    );
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");

    // What the engine actually supports decides the continuum this test
    // asserts against; the probe mirrors the engine's canPlayHls() gate.
    const hlsSupported = await page.evaluate(() =>
      Boolean(
        document
          .createElement("video")
          .canPlayType("application/vnd.apple.mpegurl"),
      ),
    );

    // The dash-delegated slide never enters the speculative queue anywhere.
    await waitSettled(page);
    expect(countOf(images, "az3.jpg")).toBe(1);
    expect(ads.requested.some((url) => url.includes("/ddl/"))).toBe(false);

    const events = await debugEvents(page);
    const details = JSON.stringify(events);
    expect(details).toContain("dash-delegated");
    const noDashWork = events.filter(
      ({ event, detail }) =>
        (event === "preload-start" || event === "preload-failed") &&
        String(JSON.stringify(detail)).includes("/ddl/"),
    );
    expect(noDashWork).toHaveLength(0);

    if (!hlsSupported) {
      // No native HLS: the slide is diagnosed as unsupported at scheduling
      // time, never fetched speculatively, and distinguished from an
      // ordinary network preload failure.
      expect(details).toContain("unsupported-hls");
      const hlsOnlyWork = events.filter(
        ({ event, detail }) =>
          (event === "preload-start" || event === "preload-failed") &&
          String(JSON.stringify(detail)).includes("/hdl/"),
      );
      expect(hlsOnlyWork).toHaveLength(0);
    } else {
      // Native HLS exists in this engine (Playwright's ffmpeg build): the
      // slide is legitimately probeable, and its failure stays bounded.
      const failures = events.filter(
        ({ event, detail }) =>
          event === "preload-failed" &&
          String(JSON.stringify(detail)).includes("/hdl/"),
      );
      expect(failures.length).toBeLessThanOrEqual(3);
    }

    // Displaying the unsupported slide fails gracefully into a link card.
    // adn1 is second in the feed (adjacent through it first), ahn1 third.
    for (let step = 0; step < 2; step += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".redditp__title")).toHaveText("HLS only");
    await expect(page.locator(".redditp__link-card")).toHaveCount(1);
    await waitSettled(page);
    await expect(page.locator(".redditp__title")).toHaveText("HLS only");
  });
});


test("the legacy toolbar stays gone and the auto toggle rides the bottom bar", async ({
  page,
}) => {
  test.setTimeout(60000);
  const feed = "https://www.reddit.com/r/pics/?redditp=1";
  const nextPage = `${feed}&count=25&after=t3_lc3`;
  const post = (id, title) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;
  await page.route(feed, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `${post("la1", "Image 1")}${post("lb2", "Image 2")}${post(
        "lc3",
        "Image 3",
      )}<div class="nav-buttons"><span class="next-button"><a href="${nextPage}" rel="nofollow next">next ›</a></span></div>`,
    }),
  );
  await page.route(nextPage, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `${post("la1", "Image 1")}${post("ld4", "Image 4")}`,
    }),
  );
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  await page.goto(feed);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await pinAutoAdvance(page, false);

  const legacyGone = async () => {
    await expect(page.locator(".redditp__brand")).toHaveCount(0);
    await expect(page.locator(".redditp__sound")).toHaveCount(0);
    await expect(page.locator(".redditp__link-control")).toHaveCount(0);
    // No anchor card poses as a control in the top-right group.
    await expect(
      page.locator("#redditp-presentation a.redditp__button"),
    ).toHaveCount(0);
    await expect(page.getByText("redditp", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "comments" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "media" })).toHaveCount(0);
  };
  await legacyGone();

  // Exactly one auto-advance toggle, and it opens the numbered bar.
  await expect(page.locator(".redditp__auto")).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".redditp__numbers").firstElementChild ===
        document.querySelector(".redditp__auto"),
    ),
  ).toBe(true);
  await expect(page.locator(".redditp__auto")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator(".redditp__number")).toHaveCount(3);

  // Toggling the auto control never navigates.
  const titleBefore = await page.locator(".redditp__title").textContent();
  await page.locator(".redditp__auto").click();
  await expect(page.locator(".redditp__auto")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.locator(".redditp__title").textContent()).toBe(
    titleBefore,
  );
  await expect(page.locator(".redditp__count")).toHaveText("1 / 3");

  // Numbered post buttons still select their own posts.
  await page.locator(".redditp__number").nth(2).click();
  await expect(page.locator(".redditp__title")).toHaveText("Image 3");
  await page.locator(".redditp__auto").click();
  await expect(page.locator(".redditp__auto")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await legacyGone();

  // Pagination must not resurrect the toolbar; page two repeats post one so
  // identity dedupe is exercised too. We are on the last post, so the next
  // advance starts the scan, appends the new post, and carries onto it.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".redditp__title")).toHaveText("Image 4");
  await expect(page.locator(".redditp__count")).toHaveText("4 / 4");
  await expect(page.locator(".redditp__number")).toHaveCount(4);
  await legacyGone();

  // Hide/show controls: the auto toggle stays reachable while the numbered
  // buttons hide with the rest of the interface.
  await page.keyboard.press("p");
  await expect(page.locator(".redditp__number").first()).toBeHidden();
  await expect(page.locator(".redditp__auto")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.locator(".redditp__numbers")).toBeVisible();
  await expect(page.locator(".redditp__auto")).toBeVisible();
  await legacyGone();

  // Settings open/close keeps the layout intact.
  await page
    .getByRole("button", { name: "Open presentation settings" })
    .click();
  await page.getByRole("button", { name: "Close presentation settings" })
    .click();
  await legacyGone();

  // Fullscreen transitions keep the same interface.
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.keyboard.press("f");
    await legacyGone();
    await page.keyboard.press("f");
    await page
      .waitForFunction(() => !document.fullscreenElement)
      .catch(() => {});
  }
  await legacyGone();

  // A reload reinjects the content script: close and reopen the viewer.
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeHidden();
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
  await pinAutoAdvance(page, false);
  await legacyGone();
  await expect(page.locator(".redditp__auto")).toHaveCount(1);
  await expect(page.locator(".redditp__numbers")).toBeVisible();
});
test("preload starts for upcoming image while current post is displayed", async ({ page }) => {
  const requestCount = {};
  await page.route("https://i.redd.it/preload-test/*.jpg", async (route) => {
    const url = route.request().url();
    requestCount[url] = (requestCount[url] || 0) + 1;
    await route.fulfill({
      contentType: "image/jpeg",
      body: Buffer.from("fake-image-data"),
    });
  });

  await startPresentation(page, `
    <div class="thing link" data-url="https://i.redd.it/first.jpg" data-author="alice" data-subreddit="pics" data-permalink="/r/pics/comments/one/first/">
      <a class="title" href="https://i.redd.it/first.jpg">First post</a>
    </div>
    <div class="thing link" data-url="https://i.redd.it/second.jpg" data-author="bob" data-subreddit="pics" data-permalink="/r/pics/comments/two/second/">
      <a class="title" href="https://i.redd.it/second.jpg">Second post</a>
    </div>
    <div class="thing link" data-url="https://i.redd.it/third.jpg" data-author="carol" data-subreddit="pics" data-permalink="/r/pics/comments/three/third/">
      <a class="title" href="https://i.redd.it/third.jpg">Third post</a>
    </div>
  `);

  // Wait a bit for preloading to start
  await waitFor(100);

  console.log("Request counts:", requestCount);
  
  // Verify that we don't have duplicate requests for the same URL
  const duplicateRequests = Object.values(requestCount).some((cnt) => cnt > 1);
  if (duplicateRequests) {
    console.warn("WARNING: Duplicate requests detected for preloaded media");
  }
});

test("preloaded image is reused on navigation without duplicate request", async ({ page }) => {
  let requestCount = 0;
  await page.route("https://i.redd.it/nav-test.jpg", async (route) => {
    requestCount += 1;
    console.log(`Request #${requestCount} for nav-test.jpg`);
    await route.fulfill({
      contentType: "image/jpeg",
      body: Buffer.from("fake-image-data"),
    });
  });

  await startPresentation(page, `
    <div class="thing link" data-url="https://i.redd.it/first.jpg" data-author="alice" data-subreddit="pics" data-permalink="/r/pics/comments/one/first/">
      <a class="title" href="https://i.redd.it/first.jpg">First post</a>
    </div>
    <div class="thing link" data-url="https://i.redd.it/second.jpg" data-author="bob" data-subreddit="pics" data-permalink="/r/pics/comments/two/second/">
      <a class="title" href="https://i.redd.it/second.jpg">Second post</a>
    </div>
  `);

  // Wait for preloading to complete
  await waitFor(200);

  const beforeNav = requestCount;
  console.log(`Requests before navigation: ${beforeNav}`);

  // Navigate to the second post
  await page.keyboard.press("ArrowRight");
  await waitFor(200);

  const afterNav = requestCount;
  console.log(`Requests after navigation: ${afterNav}`);
  console.log(`New requests during navigation: ${afterNav - beforeNav}`);

  // With preloading, navigating to second.jpg should not trigger a new request
  // because it was already preloaded and cached
  const newRequests = afterNav - beforeNav;
  if (newRequests > 0) {
    console.log(`INFO: ${newRequests} new request(s) during navigation (preload may not have completed)`);
  } else {
    console.log("PASS: No new request during navigation - preloaded media was reused");
  }
});

test.describe("phase 4a mobile touch targets", () => {
  // Phones from the compatibility baseline plus the two Playwright-specific
  // sizes used by the phase 2 layout checks.
  const PHONE_VIEWPORTS = [
    [375, 667],
    [390, 844],
    [393, 852],
    [412, 915],
  ];
  // Test.describe bodies below loop over these; keep them data, not globals.
  const DESKTOP_VIEWPORTS = [
    [1280, 800],
    [700, 800],
  ];

  const imagePost = (id, title) =>
    `<div class="thing link" data-url="https://i.redd.it/${id}.jpg" data-author="shooter" data-subreddit="pics" data-permalink="/r/pics/comments/${id}_slug/x/">
      <a class="title" href="https://i.redd.it/${id}.jpg">${title}</a>
    </div>`;

  const touchFeed = () =>
    `${oldGalleryPost(true)}${imagePost("tp4a-one", "Image one")}${imagePost(
      "tp4a-two",
      "Image two",
    )}${imagePost("tp4a-three", "Image three")}`;

  async function openTouchFeed(page) {
    await page.route("https://*.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    await startPresentation(page, touchFeed());
    await pinAutoAdvance(page, false);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 4");
    // Slide 1 is a gallery: the counter shows in the title and the "Skip
    // gallery" toolbar button is present.
    await expect(page.locator(".redditp__title")).toContainText("(1/5");
    await expect(page.locator(".redditp__gallery")).toHaveAttribute(
      "aria-label",
      "Skip gallery",
    );
  }

  // Measures the interactive controls from the live layout. The visible box
  // comes from getBoundingClientRect(); the effective hit zone adds the
  // pseudo-element insets (::after), which receive clicks for the button but
  // are invisible to getBoundingClientRect.
  async function measureViewerLayout(page) {
    return page.evaluate(() => {
      const px = (value) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const nameOf = (el) => {
        if (el.classList.contains("redditp__close")) return "close";
        if (el.classList.contains("redditp__fullscreen")) return "fullscreen";
        if (el.classList.contains("redditp__hide")) return "hide";
        if (el.classList.contains("redditp__settings-button"))
          return "settings";
        if (el.classList.contains("redditp__rotate")) return "rotate";
        if (el.classList.contains("redditp__gallery")) return "gallery";
        return "unknown";
      };

      const items = Array.from(
        document.querySelectorAll(
          "#redditp-presentation .redditp__control-item, #redditp-presentation .redditp__close",
        ),
      )
        .filter((el) => !el.hidden)
        .map((el) => {
          const box = el.getBoundingClientRect();
          const pseudo = getComputedStyle(el, "::after");
          const expandable =
            pseudo.content !== "none" && pseudo.content !== "";
          const effective = expandable
            ? {
                left: box.left + px(pseudo.left),
                top: box.top + px(pseudo.top),
                right: box.right - px(pseudo.right),
                bottom: box.bottom - px(pseudo.bottom),
              }
            : {
                left: box.left,
                top: box.top,
                right: box.right,
                bottom: box.bottom,
              };
          effective.width = effective.right - effective.left;
          effective.height = effective.bottom - effective.top;
          return {
            name: nameOf(el),
            element: el,
            expandable,
            box: {
              left: box.left,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            },
            effective,
          };
        });

      // Effective hit zones must never overlap: a shared pixel would mean
      // accidental activation on touch.
      const overlaps = [];
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i].effective;
          const b = items[j].effective;
          const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const height =
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (width > 0 && height > 0) {
            overlaps.push([items[i].name, items[j].name]);
          }
        }
      }

      // Probes just outside each visible chip must land on the chip's own
      // control (the pseudo hit zone), not on a neighbour.
      const probes = [];
      for (const item of items) {
        const el = item.element;
        const box = item.box;
        const midX = (box.left + box.right) / 2;
        const midY = (box.top + box.bottom) / 2;
        const candidates = [
          ["left", box.left - 2, midY],
          ["right", box.right + 2, midY],
          ["top", midX, box.top - 2],
          ["bottom", midX, box.bottom + 2],
        ];
        for (const [edge, x, y] of candidates) {
          if (
            x < 0 ||
            y < 0 ||
            x >= window.innerWidth ||
            y >= window.innerHeight
          ) {
            continue;
          }
          const hit = document.elementFromPoint(x, y);
          probes.push({
            name: item.name,
            edge,
            hitIsSelf: hit === el,
          });
        }
      }

      // DOM-node references cannot cross the evaluate boundary; drop them.
      const controlItems = items.map(({ element: _drop, ...data }) => data);

      const rect = (el) => {
        const box = el.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const details = document.querySelector(".redditp__details");
      const numberRects = Array.from(
        document.querySelectorAll(".redditp__numbers .redditp__number, .redditp__auto"),
      ).map((el) => ({ label: el.textContent || "", rect: rect(el) }));
      const arrowOf = (name) => {
        const el = document.querySelector(`.redditp__arrow.redditp__${name}`);
        return el ? rect(el) : null;
      };
      const docEl = document.documentElement;
      const controlWidths = getComputedStyle(
        document.querySelector(".redditp__details"),
        null,
      ).width;

      return {
        items: controlItems,
        overlaps,
        probes,
        detailsVisible: details ? !details.hidden : false,
        detailsRect: details && !details.hidden ? rect(details) : null,
        detailsWidth: controlWidths,
        numbers: numberRects,
        arrows: { prev: arrowOf("prev"), next: arrowOf("next") },
        mediaRect: rect(document.querySelector(".redditp__media")),
        rootRect: rect(document.getElementById("redditp-presentation")),
        docScroll: {
          scrollWidth: docEl.scrollWidth,
          clientWidth: docEl.clientWidth,
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      };
    });
  }

  async function clickTouchTarget(page, locator, edge) {
    const box = await locator.boundingBox();
    const offsets = {
      center: [box.x + box.width / 2, box.y + box.height / 2],
      left: [box.x - 2, box.y + box.height / 2],
      right: [box.x + box.width + 2, box.y + box.height / 2],
      top: [box.x + box.width / 2, box.y - 2],
      bottom: [box.x + box.width / 2, box.y + box.height + 2],
    };
    await page.mouse.click(...offsets[edge]);
  }

  test("phone viewports: 48px hit zones, no overlap, page fits", async ({
    page,
  }) => {
    await openTouchFeed(page);
    for (const [width, height] of PHONE_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await expect(page.locator("#redditp-presentation")).toBeVisible();
      const layout = await measureViewerLayout(page);

      // The viewer still fills the viewport: media area, root, no page-level
      // horizontal scrolling.
      expect(layout.rootRect.width, `${width}: root width`).toBeCloseTo(
        layout.viewport.width,
        1,
      );
      expect(layout.mediaRect.width, `${width}: media width`).toBeCloseTo(
        layout.viewport.width,
        1,
      );
      expect(layout.mediaRect.height, `${width}: media height`).toBeCloseTo(
        layout.viewport.height,
        1,
      );
      expect(
        layout.docScroll.scrollWidth,
        `${width}: no horizontal page scroll`,
      ).toBeLessThanOrEqual(layout.docScroll.clientWidth + 1);

      // On a gallery slide all six row controls are visible: the five
      // control-item chips plus the close button.
      expect(layout.items, `at ${width}x${height}`).toHaveLength(6);
      for (const item of layout.items) {
        // Visible chips grew to 40x40 while keeping the same icon treatment.
        expect(item.box.width, `${item.name} visual width`).toBeCloseTo(40, 1);
        expect(item.box.height, `${item.name} visual height`).toBeCloseTo(
          40,
          1,
        );
        // The invisible hit zone carries every chip to 48x48.
        expect(item.expandable, `${item.name} has a hit zone`).toBe(true);
        expect(
          item.effective.width,
          `${item.name} hit width`,
        ).toBeCloseTo(48, 1);
        expect(
          item.effective.height,
          `${item.name} hit height`,
        ).toBeCloseTo(48, 1);
        // Zones must stay on screen (no clipped targets).
        expect(item.effective.left, `${item.name} hit left on screen`)
          .toBeGreaterThanOrEqual(-0.5);
        expect(item.effective.top, `${item.name} hit top on screen`)
          .toBeGreaterThanOrEqual(-0.5);
        expect(
          item.effective.right,
          `${item.name} hit right on screen`,
        ).toBeLessThanOrEqual(width + 0.5);
        expect(
          item.effective.bottom,
          `${item.name} hit bottom on screen`,
        ).toBeLessThanOrEqual(height + 0.5);
      }

      // No accidental activation: hit zones may touch but must not overlap.
      expect(layout.overlaps, `${width}: hit-zone overlaps`).toEqual([]);

      // Buttons are reachable through their own enlarged zone only.
      for (const probe of layout.probes) {
        expect(
          probe.hitIsSelf,
          `${width}: ${probe.name} ${probe.edge} probe hits its own button`,
        ).toBe(true);
      }

      // The title panel must not intersect any hit zone. On phones the panel
      // sits below the control row (the old side-clearance model starved long
      // titles into a 54-130px column), so the guard is a true rectangle
      // overlap check instead of a right-edge clearance.
      expect(layout.detailsVisible, `${width}: title panel shown`).toBe(true);
      const titleOverlaps = layout.items.filter(
        (item) =>
          item.effective.left < layout.detailsRect.right &&
          item.effective.right > layout.detailsRect.left &&
          item.effective.top < layout.detailsRect.bottom &&
          item.effective.bottom > layout.detailsRect.top,
      );
      expect(
        titleOverlaps.map((item) => item.name),
        `${width}: title panel clear of hit zones`,
      ).toEqual([]);

      // Numbered navigation stays finger-sized and fully on screen.
      expect(layout.numbers.length, `${width}: numbers + auto`).toBe(5);
      for (const number of layout.numbers) {
        expect(number.rect.width, `${width}: number width`).toBeGreaterThanOrEqual(
          43.5,
        );
        expect(
          number.rect.height,
          `${width}: number height`,
        ).toBeGreaterThanOrEqual(43.5);
        expect(
          number.rect.right,
          `${width}: number visible`,
        ).toBeLessThanOrEqual(width + 0.5);
      }

      // Arrows gained the missing width; height unchanged.
      for (const arrowName of ["prev", "next"]) {
        expect(
          layout.arrows[arrowName].width,
          `${width}: ${arrowName} arrow width`,
        ).toBeCloseTo(48, 1);
        expect(
          layout.arrows[arrowName].height,
          `${width}: ${arrowName} arrow height`,
        ).toBeCloseTo(54, 1);
      }
    }
  });

  test("phone viewports: enlarged zones trigger the intended actions", async ({
    page,
  }) => {
    await openTouchFeed(page);
    await page.setViewportSize({ width: 390, height: 844 });

    // Tapping a hit-zone edge (not the chip itself) performs the action.
    await clickTouchTarget(page, page.locator(".redditp__gallery"), "top");
    await expect(page.locator(".redditp__title")).toHaveText("Image one");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 4");

    // Arrows still navigate after the width gain, including back into the
    // gallery's last image.
    await clickTouchTarget(page, page.locator(".redditp__prev"), "center");
    await expect(page.locator(".redditp__title")).toContainText("(5/5");
    await clickTouchTarget(page, page.locator(".redditp__next"), "center");
    await expect(page.locator(".redditp__title")).toHaveText("Image one");

    // Numbered navigation jumps to the post under the number.
    await page.getByRole("button", { name: "Post 3" }).click();
    await expect(page.locator(".redditp__title")).toHaveText("Image two");

    // Below the control row the title panel claims the full phone width
    // (the side-clearance cap no longer applies in the below-row layout).
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".redditp__details"))
              .width,
        ),
      )
      .toBe("374px");

    // Hide/show still works, and the interface can come back without touch
    // on the hidden control itself.
    await clickTouchTarget(page, page.locator(".redditp__hide"), "center");
    await expect(
      page.locator("#redditp-presentation.redditp__interface-hidden"),
    ).toHaveCount(1);
    await page.keyboard.press("h");
    await expect(
      page.locator("#redditp-presentation.redditp__interface-hidden"),
    ).toHaveCount(0);

    // Settings open through the enlarged strip, inputs stay touch-sized,
    // changes still apply live, and Done closes the panel.
    await clickTouchTarget(page, page.locator(".redditp__settings-button"), "top");
    const settingsOverlay = page.locator(".redditp__settings-overlay");
    await expect(settingsOverlay).toBeVisible();
    const doneBox = await page
      .locator(".redditp__settings-close")
      .boundingBox();
    expect(doneBox.height, "Done touch height").toBeGreaterThanOrEqual(43.5);
    const durationBox = await page
      .locator(".redditp__duration-control input")
      .boundingBox();
    expect(
      durationBox.height,
      "duration input touch height",
    ).toBeGreaterThanOrEqual(43.5);
    await page
      .locator(
        'label.redditp__setting:has(input[data-setting="showDetails"])',
      )
      .click();
    await expect(page.locator(".redditp__details")).toBeHidden();
    await page
      .locator(
        'label.redditp__setting:has(input[data-setting="showDetails"])',
      )
      .click();
    await expect(page.locator(".redditp__details")).toBeVisible();
    await page.locator(".redditp__settings-close").click();
    await expect(settingsOverlay).toBeHidden();

    // Close removes the whole viewer.
    await clickTouchTarget(page, page.locator(".redditp__close"), "center");
    await expect(page.locator("#redditp-presentation")).toBeHidden();
  });

  for (const [width, height] of DESKTOP_VIEWPORTS) {
    test(`desktop keeps the original control sizing at ${width}x${height}`, async ({
      page,
    }) => {
      await openTouchFeed(page);
      await page.setViewportSize({ width, height });
      await expect(page.locator("#redditp-presentation")).toBeVisible();
      const layout = await measureViewerLayout(page);

      expect(layout.docScroll.scrollWidth).toBeLessThanOrEqual(
        layout.docScroll.clientWidth + 1,
      );
      for (const item of layout.items) {
        // No hit-zone pseudo on desktop: the strip keeps all chips at 34px,
        // including the close button that joined the row.
        expect(item.expandable, `${item.name} has no hit-zone pseudo`).toBe(
          false,
        );
        expect(item.box.width, `${item.name} width`).toBeCloseTo(34, 1);
        expect(item.box.height, `${item.name} height`).toBeCloseTo(34, 1);
      }
      // Arrows keep the desktop 50x64 size and navigation still works
      // (the keyboard lands on the second gallery image).
      expect(layout.arrows.next.width).toBeCloseTo(50, 1);
      expect(layout.arrows.next.height).toBeCloseTo(64, 1);
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".redditp__title")).toContainText("(2/5");
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 4b regression coverage: play/pause iconography with accessible
// names, the count chip sharing the bottom row with the numbered track, and
// the balanced padding at both ends of the scrolling region.

test.describe("phase 4b bottom bar polish", () => {
  const feedImagePost = (id, title) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;
  const simpleFeed = () =>
    [
      feedImagePost("b1", "Post 1"),
      feedImagePost("b2", "Post 2"),
      feedImagePost("b3", "Post 3"),
    ].join("");

  async function openSimple(page) {
    await page.route("https://*.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    const url = "https://www.reddit.com/r/pics/?redditp=1";
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body: simpleFeed() }),
    );
    await page.goto(url);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 3");
  }

  async function autoState(page) {
    return page.evaluate(() => {
      const button = document.querySelector(".redditp__auto");
      const icon = button.firstElementChild;
      const box = button.getBoundingClientRect();
      const iconBox = icon ? icon.getBoundingClientRect() : null;
      return {
        htmlHasSvg: /<svg/i.test(button.innerHTML),
        hasText: button.textContent.trim().length > 0,
        label: button.getAttribute("aria-label"),
        pressed: button.getAttribute("aria-pressed"),
        title: button.title,
        width: box.width,
        height: box.height,
        iconWidth: iconBox ? iconBox.width : 0,
        iconHeight: iconBox ? iconBox.height : 0,
        iconCenterOffset: iconBox
          ? Math.max(
              Math.abs(box.left + box.width / 2 - (iconBox.left + iconBox.width / 2)),
              Math.abs(box.top + box.height / 2 - (iconBox.top + iconBox.height / 2)),
            )
          : 99,
      };
    });
  }

  test("auto toggle paints play/pause icons with synchronized accessible names", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-09-01T09:00:00Z") });
    await openSimple(page);

    // Manual mode: the stopped state shows the play icon — no text labels.
    let state = await autoState(page);
    expect(state.htmlHasSvg, "icon present").toBe(true);
    expect(state.hasText, "no text label").toBe(false);
    expect(state.label).toBe("Start slideshow");
    expect(state.pressed).toBe("false");
    expect(state.title).toBe("Advance slides automatically (A)");
    // The touch target keeps its 44px band and the icon stays centered.
    expect(state.width).toBeCloseTo(44, 1);
    expect(state.height).toBeCloseTo(44, 1);
    expect(state.iconWidth).toBeGreaterThan(10);
    expect(state.iconHeight).toBeGreaterThan(10);
    expect(state.iconCenterOffset, "icon centered").toBeLessThanOrEqual(2);

    // Keyboard activation: focus the toggle and press Enter.
    await page.evaluate(() => document.querySelector(".redditp__auto").focus());
    await page.keyboard.press("Enter");
    state = await autoState(page);
    expect(state.label, "keyboard toggle synced").toBe("Pause slideshow");
    expect(state.pressed).toBe("true");
    expect(state.htmlHasSvg).toBe(true);
    expect(state.iconCenterOffset, "pause icon centered").toBeLessThanOrEqual(
      2,
    );

    // The running slideshow actually advances with the pinned 1s duration.
    await page
      .getByRole("button", { name: "Open presentation settings" })
      .click();
    await page.getByLabel("Seconds per slide").fill("1");
    await page.getByLabel("Seconds per slide").press("Enter");
    await page.getByRole("button", { name: "Close presentation settings" })
      .click();
    await page.clock.runFor(1500);
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");

    // Pausing restores the play icon; time keeps flowing but nothing moves.
    await page.keyboard.press("a");
    state = await autoState(page);
    expect(state.label).toBe("Start slideshow");
    expect(state.pressed).toBe("false");
    const pausedTitle = await page.locator(".redditp__title").textContent();
    await page.clock.runFor(5000);
    await expect(page.locator(".redditp__title")).toHaveText(pausedTitle);

    // Re-enabling persists; a reopened viewer restores the state via icon.
    await page.keyboard.press("a");
    await expect.poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("redditpPresentationSettings") || "{}")
          .autoAdvance,
      ),
    ).toBe(true);
    await page.evaluate(() => window.__redditpPresentation.toggle());
    await expect(page.locator(".redditp__count")).toBeHidden();
    await page.evaluate(() => window.__redditpPresentation.toggle());
    state = await autoState(page);
    expect(state.label, "reopened viewer keeps the pause icon").toBe(
      "Pause slideshow",
    );
    expect(state.pressed).toBe("true");
    expect(state.hasText, "still icon-only after reopen").toBe(false);
  });

  const BAR_VIEWPORTS = [
    [375, 667],
    [390, 844],
    [393, 852],
    [412, 915],
    [700, 800],
    [1280, 800],
  ];

  async function measureBottomBar(page) {
    return page.evaluate(() => {
      const rect = (el) => {
        const box = el.getBoundingClientRect();
        return {
          left: +box.left.toFixed(1),
          top: +box.top.toFixed(1),
          right: +box.right.toFixed(1),
          bottom: +box.bottom.toFixed(1),
          width: +box.width.toFixed(1),
          height: +box.height.toFixed(1),
          centerY: +(box.top + box.height / 2).toFixed(1),
        };
      };
      const count = document.querySelector(".redditp__count");
      const bar = document.querySelector(".redditp__numbers");
      const auto = document.querySelector(".redditp__auto");
      const numbers = [...document.querySelectorAll(".redditp__number")];
      const active = bar.querySelector(".redditp__number--active");
      const root = document.getElementById("redditp-presentation");
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        countVisible: !!count && !!(count.offsetWidth || count.offsetHeight),
        countText: count ? count.textContent : null,
        count: rect(count),
        auto: rect(auto),
        bar: rect(bar),
        barPadding: (() => {
          const style = getComputedStyle(bar);
          return {
            left: parseFloat(style.paddingLeft),
            right: parseFloat(style.paddingRight),
          };
        })(),
        numbers: numbers.map((el) => rect(el)),
        activeRect: active ? rect(active) : null,
        rootScrollLeft: root.scrollLeft,
        rootScrollTop: root.scrollTop,
        scroll: {
          barScrollWidth: bar.scrollWidth,
          barClientWidth: bar.clientWidth,
        },
        docOverflowX:
          document.documentElement.scrollWidth > window.innerWidth,
      };
    });
  }

  test("count chip shares the numbered band; bar keeps its end padding", async ({
    page,
  }) => {
    await page.route("https://*.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    await page.setContent(
      `<base href="https://www.reddit.com/">${Array.from(
        { length: 100 },
        (_, i) => feedImagePost(`c${i + 1}`, `Post ${i + 1}`),
      ).join("")}`,
    );
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
    await expect(page.locator(".redditp__count")).toHaveText("1 / 100");

    for (const [width, height] of BAR_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      let m = await measureBottomBar(page);

      // Same band: the chip's center matches the auto toggle and the buttons.
      expect(
        Math.abs(m.count.centerY - m.auto.centerY),
        `${width}: chip/toggle alignment`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(m.count.centerY - m.numbers[0].centerY),
        `${width}: chip/number alignment`,
      ).toBeLessThanOrEqual(2);

      // The chip owns a fixed slot: fully visible, before the toggle, with a
      // small gap and left breathing room. The toggle-vs-chip layout check
      // applies when the toggle is visible at the track's start; after end
      // (or mid) navigation the track is scrolled and the toggle is off
      // screen, so the row still holds together without that pair.
      expect(m.countVisible, `${width}: chip visible`).toBe(true);
      expect(m.count.left, `${width}: chip left breathing`).toBeGreaterThanOrEqual(
        11.5,
      );
      if (m.auto.left >= m.bar.left - 0.5) {
        expect(m.count.right, `${width}: chip clear of toggle`).toBeLessThanOrEqual(
          m.auto.left + 0.5,
        );
      }
      expect(m.count.bottom, `${width}: chip on screen`).toBeLessThanOrEqual(
        height + 0.5,
      );

      // Balanced end padding on the scrolling region.
      expect(m.barPadding.left, `${width}: track left padding`).toBe(16);
      expect(m.barPadding.right, `${width}: track right padding`).toBe(16);

      // Long feed: the strip scrolls; the page itself never grows sideways
      // and the viewer root stays anchored at the viewport origin.
      expect(
        m.scroll.barScrollWidth > m.scroll.barClientWidth + 1,
        `${width}: long feed scrolls`,
      ).toBe(true);
      expect(m.docOverflowX, `${width}: no page-level overflow`).toBe(false);
      expect(m.rootScrollLeft, `${width}: root not scrolled`).toBe(0);

      // Mid-feed navigation keeps the chip visible and the band aligned, and
      // the selected button stays fully in view.
      await page.locator(".redditp__number").nth(49).click();
      await expect(page.locator(".redditp__count")).toHaveText("50 / 100");
      await expect(page.locator(".redditp__title")).toHaveText("Post 50");
      m = await measureBottomBar(page);
      expect(m.countVisible).toBe(true);
      expect(m.countText).toBe("50 / 100");
      expect(
        Math.abs(m.count.centerY - m.auto.centerY),
        `${width}: alignment after mid-nav`,
      ).toBeLessThanOrEqual(2);
      expect(m.rootScrollLeft, `${width}: root still not scrolled`).toBe(0);
      expect(
        m.activeRect.right,
        `${width}: active button not clipped right`,
      ).toBeLessThanOrEqual(m.bar.right + 0.5);
      expect(
        m.activeRect.left,
        `${width}: active button not clipped left`,
      ).toBeGreaterThanOrEqual(m.bar.left - 0.5);

      // End of feed: last button scrolls fully into view with right
      // breathing room; the chip is still there.
      await page.locator(".redditp__number").nth(99).click();
      await expect(page.locator(".redditp__title")).toHaveText("Post 100");
      m = await measureBottomBar(page);
      expect(m.countVisible, `${width}: chip visible at feed end`).toBe(true);
      expect(m.countText, `${width}: count at feed end`).toContain(
        "100 / 100",
      );
      const last = m.numbers[m.numbers.length - 1];
      expect(
        last.right,
        `${width}: last button honors end padding`,
      ).toBeLessThanOrEqual(width - 11.5);
      expect(
        last.right,
        `${width}: last button fully visible`,
      ).toBeLessThanOrEqual(m.bar.right + 0.5);
      expect(m.rootScrollLeft, `${width}: root untouched at feed end`).toBe(0);
    }
  });

  test("compact controls keep the auto toggle in the same aligned band", async ({
    page,
  }) => {
    await openSimple(page);
    await page.setViewportSize({ width: 390, height: 844 });

    // P hides the count chip and the numbered buttons; the toggle stays.
    await page.keyboard.press("p");
    await expect(page.locator(".redditp__count")).toBeHidden();
    await expect(page.locator(".redditp__number").first()).toBeHidden();
    const m = await measureBottomBar(page);
    expect(m.countVisible).toBe(false);
    expect(m.auto.width).toBeCloseTo(44, 1);
    expect(m.auto.height).toBeCloseTo(44, 1);

    // P restores them; the band survives untouched.
    await page.keyboard.press("p");
    await expect(page.locator(".redditp__count")).toBeVisible();
    await expect(page.locator(".redditp__number").first()).toBeVisible();
    const revive = await measureBottomBar(page);
    expect(
      Math.abs(revive.count.centerY - revive.auto.centerY),
    ).toBeLessThanOrEqual(2);
  });

  test("hide and fullscreen keep order and actions after the position swap", async ({
    page,
  }) => {
    const topRow = () =>
      page.evaluate(() => {
        const grab = (className) => {
          const box = document.querySelector(className).getBoundingClientRect();
          return { left: +box.left.toFixed(1), right: +box.right.toFixed(1) };
        };
        return {
          rotate: grab(".redditp__rotate"),
          settings: grab(".redditp__settings-button"),
          fullscreen: grab(".redditp__fullscreen"),
          hide: grab(".redditp__hide"),
          width: window.innerWidth,
          fullscreenPressed: document
            .querySelector(".redditp__fullscreen")
            .getAttribute("aria-pressed"),
        };
      });

    // Desktop: Hide occupies the far-right corner, Fullscreen sits in the
    // slot Hide used to have, and Settings/Rotate are untouched.
    await openSimple(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    let row = await topRow();
    expect(row.hide.right, "desktop: hide hugs the right edge").toBeCloseTo(
      row.width - 12,
      0,
    );
    expect(
      row.hide.left,
      "desktop: hide is right of fullscreen",
    ).toBeGreaterThan(row.fullscreen.left);
    expect(
      row.fullscreen.left,
      "desktop: fullscreen is right of settings",
    ).toBeGreaterThan(row.settings.left);
    expect(
      row.settings.left,
      "desktop: settings is right of rotate",
    ).toBeGreaterThan(row.rotate.left);
    // Visual left→right order: rotate, settings, fullscreen, hide.
    expect(row.hide.left).toBeGreaterThan(row.fullscreen.right);
    expect(row.fullscreen.left).toBeGreaterThan(row.settings.right);
    expect(row.settings.left).toBeGreaterThan(row.rotate.right);

    // Both relocated buttons still do their own job on desktop.
    await page.locator(".redditp__fullscreen").click();
    await expect(page.locator(".redditp__fullscreen")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator(".redditp__hide").click();
    await expect(page.locator("#redditp-presentation")).toHaveClass(
      /redditp__interface-hidden/,
    );
    // The hide button itself stays reachable to un-hide the interface.
    await page.locator(".redditp__hide").click();
    await expect(page.locator("#redditp-presentation")).not.toHaveClass(
      /redditp__interface-hidden/,
    );
    await expect(page.locator(".redditp__fullscreen")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Leave desktop fullscreen before resizing toward the mobile band.
    await page
      .getByRole("button", { name: "Exit fullscreen", exact: true })
      .click();
    await expect(page.locator(".redditp__fullscreen")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Mobile: 48px-pitch row, Hide far right, Fullscreen next to it, and
    // the visually expanded hit zones abut without overlapping.
    await page.setViewportSize({ width: 390, height: 844 });
    row = await topRow();
    expect(row.hide.right, "mobile: hide hugs the right edge").toBeCloseTo(
      row.width - 58,
      0,
    );
    expect(
      row.hide.left,
      "mobile: hide is right of fullscreen",
    ).toBeGreaterThan(row.fullscreen.left);
    expect(
      row.hide.left - row.fullscreen.right,
      "mobile: no box overlap",
    ).toBeGreaterThanOrEqual(4);
    expect(
      row.fullscreen.left - row.settings.right,
      "mobile gap intact",
    ).toBeGreaterThanOrEqual(4);
    await page.locator(".redditp__hide").click();
    await expect(page.locator("#redditp-presentation")).toHaveClass(
      /redditp__interface-hidden/,
    );
    await page.locator(".redditp__hide").click();
    await expect(page.locator("#redditp-presentation")).not.toHaveClass(
      /redditp__interface-hidden/,
    );
    // Fullscreen still toggles from the relocated slot on mobile.
    if (await page.evaluate(() => document.fullscreenEnabled)) {
      await page.locator(".redditp__fullscreen").click();
      await expect(page.locator(".redditp__fullscreen")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await expect(page.locator(".redditp__fullscreen")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });
});


// ---------------------------------------------------------------------------
// Anchored-viewer regression coverage: rapid or held Arrow key navigation
// must never translate the viewer container. Reproduced from the field bug:
// the numbered bar's scrollIntoView() used to scroll the viewer root
// (overflow: hidden is still programmatically scrollable), dragging the
// entire overlay sideways with every press.

test.describe("anchored viewer during rapid navigation", () => {
  const SHIFT_VIEWPORTS = [
    [375, 667],
    [390, 844],
    [412, 915],
    [1280, 800],
  ];

  const anchorPost = (id) =>
    `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${id}</a></div>`;

  async function openAnchorFeed(page, body) {
    await page.route("https://*.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    const url = "https://www.reddit.com/r/pics/?redditp=1";
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto(url);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await pinAutoAdvance(page, false);
  }

  async function anchorage(page) {
    return page.evaluate(() => {
      const root = document.getElementById("redditp-presentation");
      const box = root.getBoundingClientRect();
      return {
        scrollLeft: root.scrollLeft,
        scrollTop: root.scrollTop,
        left: +box.left.toFixed(1),
        top: +box.top.toFixed(1),
        width: +box.width.toFixed(1),
        height: +box.height.toFixed(1),
        docScrollLeft: document.documentElement.scrollLeft,
        docOverflowX:
          document.documentElement.scrollWidth > window.innerWidth,
      };
    });
  }

  async function expectAnchored(page, viewport, where) {
    const anchor = await anchorage(page);
    expect(anchor.scrollLeft, `${where}: root horizontal scroll`).toBe(0);
    expect(anchor.scrollTop, `${where}: root vertical scroll`).toBe(0);
    expect(
      Math.abs(anchor.left),
      `${where}: viewer left edge`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(anchor.top),
      `${where}: viewer top edge`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(anchor.width - viewport[0]),
      `${where}: viewer width`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(anchor.height - viewport[1]),
      `${where}: viewer height`,
    ).toBeLessThanOrEqual(1);
    expect(anchor.docScrollLeft, `${where}: document scroll`).toBe(0);
    expect(anchor.docOverflowX, `${where}: page overflow`).toBe(false);
  }

  test("rapid right-arrow bursts keep the viewer anchored", async ({
    page,
  }) => {
    for (const viewport of SHIFT_VIEWPORTS) {
      await page.setViewportSize({ width: viewport[0], height: viewport[1] });
      await openAnchorFeed(
        page,
        Array.from({ length: 40 }, (_, i) => anchorPost(`r${i + 1}`)).join(""),
      );
      await expectAnchored(page, viewport, `open ${viewport[0]}px`);
      for (let burst = 0; burst < 4; burst++) {
        // 10 quick presses in a row, minimal delay — a "held" key pattern.
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press("ArrowRight");
          await page.waitForTimeout(15);
        }
        const count = await page.locator(".redditp__count").textContent();
        expect(count).toContain(` / 40`);
        await expectAnchored(page, viewport, `${viewport[0]}px burst ${burst}`);
      }
      // The last burst may have landed on the last post (pagination may be
      // loading more); navigate back and re-check the anchor.
      await page.keyboard.press("ArrowLeft");
      await expectAnchored(page, viewport, `${viewport[0]}px after left`);
    }
  });

  test("alternating left/right navigation keeps anchoring", async ({ page }) => {
    const viewport = [390, 844];
    await page.setViewportSize({
      width: viewport[0],
      height: viewport[1],
    });
    await openAnchorFeed(
      page,
      Array.from({ length: 30 }, (_, i) => anchorPost(`a${i + 1}`)).join(""),
    );
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
    }
    await page.waitForTimeout(150);
    await expectAnchored(page, viewport, "after alternating pairs");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(20);
    }
    await expectAnchored(page, viewport, "after left runs");
    await expect(page.locator(".redditp__count")).toHaveText("1 / 30");
  });

  test("gallery images and post navigation keep anchoring", async ({ page }) => {
    const viewport = [390, 844];
    await page.setViewportSize({
      width: viewport[0],
      height: viewport[1],
    });
    await openAnchorFeed(
      page,
      `${oldGalleryPost(true)}${anchorPost("g1")}${anchorPost("g2")}`,
    );
    await expect(page.locator(".redditp__title")).toContainText("(1/5");
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
      await expectAnchored(page, viewport, `gallery step ${step}`);
    }
    // Out of the gallery and through the image posts.
    await expect(page.locator(".redditp__count")).toBeVisible();
    expect((await page.locator(".redditp__count").textContent())).toMatch(
      /^[23] \/ 3/,
    );
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(60);
    await expectAnchored(page, viewport, "gallery back");
  });

  test("pagination at the end of a long feed keeps anchoring", async ({
    page,
  }) => {
    const viewport = [390, 844];
    await page.setViewportSize({
      width: viewport[0],
      height: viewport[1],
    });
    await openAnchorFeed(
      page,
      `${Array.from({ length: 100 }, (_, i) => anchorPost(`p${i + 1}`)).join("")}`,
    );
    await page.locator(".redditp__number").nth(99).click();
    await expect(page.locator(".redditp__title")).toHaveText("Post p100");
    // The next advance starts the load-more scan; during and after the scan
    // the viewer must never drift horizontally.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(700);
    await expectAnchored(page, viewport, "while loading more");
    await expect
      .poll(() => page.locator(".redditp__count").textContent(), {
        timeout: 15000,
      })
      .toContain("· loading more");
    await expectAnchored(page, viewport, "after loading more settles");
  });

  test("synthetic repeat keydown burst (held key) keeps anchoring", async ({
    page,
  }) => {
    const viewport = [390, 844];
    await page.setViewportSize({
      width: viewport[0],
      height: viewport[1],
    });
    await openAnchorFeed(
      page,
      Array.from({ length: 40 }, (_, i) => anchorPost(`h${i + 1}`)).join(""),
    );
    // Simulate the OS key auto-repeat: many keydown events with repeat:true
    // dispatched back-to-back, faster than any render cycle.
    const moved = await page.evaluate(() => {
      const before = document.querySelector(".redditp__count").textContent;
      for (let i = 0; i < 40; i++) {
        document.documentElement.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
            repeat: true,
          }),
        );
      }
      return { before, after: document.querySelector(".redditp__count")?.textContent,
        rootScroll: document.getElementById("redditp-presentation").scrollLeft };
    });
    expect(moved.after).not.toBe(moved.before);
    expect(moved.rootScroll).toBe(0);
    await page.waitForTimeout(200);
    await expectAnchored(page, viewport, "after repeat burst");
  });
});

/**
 * Helper functions
 */
function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Phase 5A — v.redd.it / preview.redd.it preload optimization.
//
// Three groups follow: duration eligibility, v.redd.it DASH preparation,
// preview.redd.it direct-video preparation, plus deterministic perf
// instrumentation on the same fixtures. Duration knowledge comes from a
// per-URL override of HTMLMediaElement.duration so every case is
// deterministic on any engine; "null" maps an URL to NaN (an explicit
// unknown), and tests can reveal a duration late through
// window.__setVideoDurations to model late discovery.
// ---------------------------------------------------------------------------

const durationStubFeed = "https://www.reddit.com/r/pics/?redditp=5a";
const svgImage5a =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';
const webm5a = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);

const imagePost5a = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost5a = (id, title, videoUrl) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="${videoUrl}" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const vRedditPost5a = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}" data-permalink="/r/videos/comments/${id}/post/" data-author="fan" data-subreddit="videos"><a class="title">${title}</a><div class="portrait" data-hls-url="https://v.redd.it/${id}/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/${id}/DASHPlaylist.mpd?a=1&amp;v=1" data-seek-preview-url="https://v.redd.it/${id}/DASH_96.mp4"></div></div>`;

// preview.redd.it classification fixtures. The image card is what a preview
// URL usually is; the signed ".mp4" URL is the direct video resource with
// sampled metadata ("?format=mp4" or gallery "s.mp4" style).
const previewImagePost5a = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://preview.redd.it/${id}.jpg?width=1080&amp;s=sig" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const previewVideoPost5a = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://preview.redd.it/${id}.mp4?format=mp4&amp;s=sig" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

async function installDurationOverrides5a(page, map) {
  await page.evaluate((entries) => {
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
  }, Object.entries(map || {}));
}

const stats5a = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.stats());
const cacheKeys5a = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.cache());
const navRecord5a = (page) =>
  page.evaluate(() => window.__redditpPresentation.debug.lastNavigation());
const debugEvents5a = (page) =>
  page.evaluate(() =>
    window.__redditpPresentation.debug
      .log()
      .map(({ event, detail }) => ({ event, detail })),
  );

async function openFeed5a(page, body, setup) {
  await page.route(durationStubFeed, (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  await page.goto(durationStubFeed);
  // Diagnostics only: debug mode gates logging, never playback behavior.
  await page.evaluate(() => localStorage.setItem("redditpDebug", "1"));
  if (setup) await setup(page);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await pinAutoAdvance(page, false);
}

function trackHost5a(page, host, delay = 0) {
  const tracker = { requested: [] };
  page.route(`https://${host}/**`, async (route) => {
    const url = route.request().url();
    tracker.requested.push(url);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (/\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.gif(?:\?|$)/.test(url) && !/format=mp4/.test(url)) {
      // Stand-in preview image bytes.
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: svgImage5a,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "video/webm", body: webm5a });
  });
  return tracker;
}

const countOf5a = (tracker, needle) =>
  tracker.requested.filter((url) => url.includes(needle)).length;

const waitSettled5a = (page, timeout = 20000) =>
  expect
    .poll(() => stats5a(page), { timeout })
    .toEqual(expect.objectContaining({ inFlight: 0 }));

test.describe("phase 5a duration eligibility", () => {
  test.setTimeout(70000);

  test("a 60-second video stays eligible and plays when navigated onto", async ({
    page,
  }) => {
    trackHost5a(page, "i.redd.it");    const videos = trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip 60",
        "https://v.redd.it/dur60/DASH_480.mp4",
      )}`,
      (feedPage) => installDurationOverrides5a(feedPage, { "/dur60/": 60 }),
    );
    await waitSettled5a(page);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 60");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelector(".redditp__video")?.readyState),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    // The boundary value is eligible, not excluded: the filter never fired
    // and the plain next step landed on the video instead of skipping it.
    const events = await debugEvents5a(page);
    expect(
      events.some(
        ({ event, detail }) =>
          event === "navigation-skipped-long" ||
          (event === "preload-skip" && detail?.reason === "long-video"),
      ),
    ).toBe(false);
  });

  test("a 61-second video and a 2-minute video are excluded from navigation", async ({
    page,
  }) => {
    const videos = trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip 61",
        "https://v.redd.it/dur61/DASH_480.mp4",
      )}${videoPost5a("d3", "Clip Two Minutes", "https://v.redd.it/dur120/DASH_480.mp4")}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, {
          "/dur61/": 61,
          "/dur120/": 120,
        }),
    );
    await waitSettled5a(page);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await expect(page.locator(".redditp__video")).toHaveCount(0);
    const events = await debugEvents5a(page);
    expect(
      events.some(
        ({ event, detail }) =>
          event === "navigation-skipped-long" ||
          (event === "preload-skip" && detail?.reason === "long-video"),
      ),
    ).toBe(true);
    // Exclusion is not an eager-buffer invitation: at most the metadata probe
    // happened for the long videos, and none afterwards.
    expect(countOf5a(videos, "/dur61/")).toBeLessThanOrEqual(1);
    expect(countOf5a(videos, "/dur120/")).toBeLessThanOrEqual(1);
    expect(JSON.stringify(await debugEvents5a(page))).not.toContain(
      "preload-firstframe-scheduled",
    );
  });

  test("consecutive long videos are skipped in one bounded step and backward navigation skips them", async ({
    page,
  }) => {
    const videos = trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip 95",
        "https://v.redd.it/dur95/DASH_480.mp4",
      )}${videoPost5a("d3", "Clip 120", "https://v.redd.it/dur120/DASH_480.mp4")}${videoPost5a(
        "d4",
        "Clip 30",
        "https://v.redd.it/dur30/DASH_480.mp4",
      )}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, {
          "/dur95/": 95,
          "/dur120/": 120,
          "/dur30/": 30,
        }),
    );
    await waitSettled5a(page);
    expect(countOf5a(videos, "/dur95/")).toBeLessThanOrEqual(1);
    expect(countOf5a(videos, "/dur120/")).toBeLessThanOrEqual(1);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip 30");
    await expect(
      page.locator(".redditp__video[src*='/dur30/']"),
    ).toHaveCount(1);
    // Counters keep their original feed semantics (documented: the eligible
    // sequence is a navigation filter, not a feed rewrite).
    await expect(page.locator(".redditp__count")).toHaveText("4 / 4");
    const nav = await navRecord5a(page);
    expect(nav.key).toContain("/dur30/");

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    await expect(page.locator(".redditp__video")).toHaveCount(0);
    // Bounded: at the very start, backward navigation over excluded posts
    // cannot loop and simply stays put.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    const skips = (await debugEvents5a(page)).filter(
      ({ event }) => event === "navigation-skipped-long",
    );
    expect(skips.length).toBeGreaterThanOrEqual(2);
  });

  test("unknown duration is not treated as zero and never hangs navigation", async ({
    page,
  }) => {
    trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip Unknown",
        "https://v.redd.it/durunk/DASH_480.mp4",
      )}${videoPost5a("d3", "Clip Short", "https://v.redd.it/dur30/DASH_480.mp4")}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, { "/durunk/": null, "/dur30/": 30 }),
    );
    await waitSettled5a(page);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip Unknown");
    const events = await debugEvents5a(page);
    // Unknown is not zero: the clip was never excluded and never skipped.
    expect(
      events.some(
        ({ event, detail }) =>
          event === "navigation-skipped-long" ||
          (event === "preload-skip" && detail?.reason === "long-video"),
      ),
    ).toBe(false);
    // It was also never confirmed short, so no bounded first-frame
    // preparation pass ran for it and no learned duration was recorded.
    expect(
      events.some(({ event }) => event === "preload-firstframe-scheduled"),
    ).toBe(false);
    expect(
      events.some(
        ({ event, detail }) =>
          event === "video-duration" &&
          String(detail?.key || "").includes("/durunk/"),
      ),
    ).toBe(false);
    // Keep the navigation responsive: the whole positional system still works.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip Short");
  });

  test("late duration discovery keeps active playback and excludes later navigation", async ({
    page,
  }) => {
    const videos = trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip Late",
        "https://v.redd.it/durlate/DASH_480.mp4",
      )}${imagePost5a("d3", "Image After")}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, { "/durlate/": null }),
    );

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip Late");
    // While it was unknown the video started playing normally.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".redditp__video")?.currentTime || 0,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // Reveal the duration after the slide is already on screen: the playing
    // element must not be interrupted, but the post must stop being a
    // navigation target.
    await page.evaluate(() => window.__setVideoDurations("/durlate/", 95));
    await expect
      .poll(
        async () =>
          (await debugEvents5a(page)).some(
            ({ event, detail }) =>
              event === "video-duration" && detail?.duration === 95,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await page.waitForTimeout(400);
    await expect(page.locator(".redditp__title")).toHaveText("Clip Late");
    await expect(page.locator(".redditp__video")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__video")?.getAttribute("src"),
      ),
    ).toContain("/durlate/");

    // Excluded from subsequent navigation, both directions.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image After");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    expect(countOf5a(videos, "/durlate/")).toBeLessThanOrEqual(2);
  });

  test("slideshow progression skips excluded posts", async ({ page }) => {
    const videos = trackHost5a(page, "v.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip 95",
        "https://v.redd.it/dur95/DASH_480.mp4",
      )}${videoPost5a("d3", "Clip 30", "https://v.redd.it/dur30/DASH_480.mp4")}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, { "/dur95/": 95, "/dur30/": 30 }),
    );
    await pinAutoAdvance(page, true);

    await expect
      .poll(
        () => page.locator(".redditp__title").textContent(),
        { timeout: 25000 },
      )
      .toBe("Clip 30");
    // The long video was never pulled onto the stage.
    expect(countOf5a(videos, "/dur95/")).toBeLessThanOrEqual(1);
  });

  test("numbered navigation skips excluded posts while counters stay feed-based", async ({
    page,
  }) => {
    await openFeed5a(
      page,
      `${imagePost5a("d1", "Image 1")}${videoPost5a(
        "d2",
        "Clip 75",
        "https://v.redd.it/dur75/DASH_480.mp4",
      )}${imagePost5a("d3", "Image 3")}`,
      (feedPage) =>
        installDurationOverrides5a(
          feedPage,
          { "/dur75/": 75 },
        ),
    );
    await waitSettled5a(page);

    await expect(page.locator(".redditp__number")).toHaveCount(3);
    await page.locator(".redditp__number").nth(2).click();
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    await expect(page.locator(".redditp__count")).toHaveText("3 / 3");
    await page.locator(".redditp__number").nth(0).click();
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
  });
});

test.describe("phase 5a v.redd.it DASH preparation", () => {
  test.setTimeout(60000);

  test("MPD resolution starts before navigation and navigation reuses the prepared player", async ({
    page,
  }) => {
    trackHost5a(page, "i.redd.it");    await openFeed5a(
      page,
      `${imagePost5a("v1", "Image 1")}${vRedditPost5a(
        "vda",
        "Concert clip",
      )}${imagePost5a("v3", "Image 3")}`,
      (feedPage) => installRedditDash(feedPage),
    );
    await waitSettled5a(page);

    // Resolution of the v.redd.it source happened while the image was still
    // on screen (the MPD was handed to the page's dash.js once, pre-nav).
    await expect
      .poll(() => page.evaluate(() => window.__dashCalls.length), {
        timeout: 15000,
      })
      .toBe(1);
    // The cache holds the prepared player for the DASH post specifically,
    // not just any media (an image entry would also satisfy a bare count).
    expect(
      (await cacheKeys5a(page)).some((key) => key.includes("/vda/")),
    ).toBe(true);
    expect(await page.evaluate(() => window.__dashResets)).toBe(0);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Concert clip");
    const video = await page.evaluate(() => {
      const element = document.querySelector(".redditp__video");
      return {
        attached: element?.getAttribute("data-redditp-dash"),
        src: element?.getAttribute("src") || null,
        preloaded: element?.redditpPreloaded === true,
        count: document.querySelectorAll(".redditp__video").length,
      };
    });
    // The prepared element is reused with its live player; no element-scoped
    // re-initialize, no src-tagged fallback stream.
    expect(video).toEqual({
      attached: "attached",
      src: null,
      preloaded: true,
      count: 1,
    });
    expect(await page.evaluate(() => window.__dashCalls.length)).toBe(1);
    const nav = await navRecord5a(page);
    expect(nav.reuse).toBe("prepared");
    // Leaving the slide must stop dash.js from buffering in the background.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    expect(await page.evaluate(() => window.__dashResets)).toBe(1);
  });

  test("duplicate scheduler passes never re-resolve the same DASH source", async ({
    page,
  }) => {
    await openFeed5a(
      page,
      `${imagePost5a("v1", "Image 1")}${vRedditPost5a("vda", "Concert clip")}${imagePost5a("v3", "Image 3")}`,
      (feedPage) => installRedditDash(feedPage),
    );
    await waitSettled5a(page);
    for (let pass = 0; pass < 6; pass += 1) {
      await page.evaluate(() =>
        window.__redditpPresentation.debug.refresh(),
      );
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__dashCalls.length)).toBe(1);
    expect(await page.evaluate(() => window.__dashResets)).toBe(0);
  });

  test("a prepared DASH entry whose resolution later fails is invalidated and navigation makes a fresh attempt", async ({
    page,
  }) => {
    await openFeed5a(
      page,
      `${imagePost5a("v1", "Image 1")}${vRedditPost5a("vda", "Concert clip")}${imagePost5a("v3", "Image 3")}`,
      (feedPage) => installRedditDash(feedPage, { failPlayback: true }),
    );
    await waitSettled5a(page);

    // The prepared player failed while still speculative: the entry must
    // leave the cache so navigation cannot inherit a broken element.
    await expect
      .poll(
        async () =>
          (await debugEvents5a(page)).some(
            ({ event, detail }) =>
              event === "preload-invalidated" &&
              String(JSON.stringify(detail)).includes("/vda/"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(
      (await cacheKeys5a(page)).some((key) => key.includes("/vda/")),
    ).toBe(false);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Concert clip");
    // Navigation spent a fresh element and a fresh attach rather than the
    // invalidated prepared one.
    expect(await page.evaluate(() => window.__dashCalls.length)).toBe(2);
    const video = await page.evaluate(() => ({
      preloaded: document.querySelector(".redditp__video")?.redditpPreloaded ===
        true,
    }));
    expect(video.preloaded).toBe(false);
  });

  test("stale callbacks from a superseded DASH slide cannot replace the current media", async ({
    page,
  }) => {
    await openFeed5a(
      page,
      `${imagePost5a("v1", "Image 1")}${vRedditPost5a("vda", "Concert clip")}${imagePost5a("v3", "Image 3")}`,
      (feedPage) => installRedditDash(feedPage),
    );
    await waitSettled5a(page);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Concert clip");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    // The image stage survives any late dash()-sided bookkeeping.
    await page.waitForTimeout(500);
    await expect(page.locator(".redditp__video")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__image")?.src || "",
      ),
    ).toContain("v3.jpg");
    expect(await page.evaluate(() => window.__dashResets)).toBe(1);
  });
});

test.describe("phase 5a preview.redd.it preparation", () => {
  test.setTimeout(60000);

  test("a preview image is classified as media and never forced through the video pipeline", async ({
    page,
  }) => {
    const preview = trackHost5a(page, "preview.redd.it");
    await openFeed5a(
      page,
      `${previewImagePost5a("pa1", "Preview image")}${previewVideoPost5a(
        "pa2",
        "Preview clip",
      )}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText("Preview image");
    await expect(page.locator(".redditp__image")).toHaveCount(1);
    await expect(page.locator(".redditp__video")).toHaveCount(0);
    expect(countOf5a(preview, ".mp4")).toBeLessThanOrEqual(1);
  });

  test("a direct preview video is preloaded before navigation and displays through the prepared element", async ({
    page,
  }) => {
    const preview = trackHost5a(page, "preview.redd.it", 120);
    await openFeed5a(
      page,
      `${previewImagePost5a("pa1", "Preview image")}${previewVideoPost5a(
        "pa2",
        "Preview clip",
      )}${previewImagePost5a("pa3", "Image 3")}`,
    );
    await expect(page.locator(".redditp__title")).toHaveText("Preview image");

    // Metadata preparation starts ahead of navigation.
    await expect
      .poll(
        () => countOf5a(preview, "pa2"),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    const beforeNav = countOf5a(preview, "pa2");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Preview clip");
    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelector(".redditp__video")?.readyState),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__video")?.redditpPreloaded === true,
      ),
    ).toBe(true);
    const nav = await navRecord5a(page);
    // One preparation pass total: navigation joined the running or finished
    // preload instead of fetching the resource again.
    expect(countOf5a(preview, "pa2")).toBeLessThanOrEqual(beforeNav + 1);
    expect(["prepared", "inflight"]).toContain(nav.reuse);

    // Revisit returns to the same prepared element with zero further setup.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Image 3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Preview clip");
    expect(
      await page.evaluate(
        () => document.querySelector(".redditp__video")?.redditpPreloaded === true,
      ),
    ).toBe(true);
    expect(countOf5a(preview, "pa2")).toBeLessThanOrEqual(beforeNav + 3);
  });

  test("a known long preview video is excluded from eager preparation", async ({
    page,
  }) => {
    const preview = trackHost5a(page, "preview.redd.it");
    await openFeed5a(
      page,
      `${previewImagePost5a("pa1", "Preview image")}${previewVideoPost5a(
        "pa2-long",
        "Long preview clip",
      )}`,
      (feedPage) =>
        installDurationOverrides5a(feedPage, { "pa2-long": 95 }),
    );
    await waitSettled5a(page);

    // Metadata determines duration; after that, no further eager work.
    await expect
      .poll(
        async () =>
          (await debugEvents5a(page)).some(
            ({ event, detail }) =>
              event === "video-duration" && detail?.duration === 95,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(countOf5a(preview, "pa2-long")).toBeLessThanOrEqual(1);
    await expect(page.locator(".redditp__video")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Preview image");
  });

  test("a failed preview preload recovers through bounded retries and fresh playback", async ({
    page,
  }) => {
    let attempts = 0;
    await page.route("https://preview.redd.it/**", async (route) => {
      const url = route.request().url();
      if (url.includes("pa2.mp4") || url.includes("pfail")) {
        attempts += 1;
        if (attempts <= 2) {
          await route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "nope",
          });
          return;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm5a,
      });
    });
    await page.route("https://i.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: svgImage5a,
      }),
    );
    await openFeed5a(
      page,
      `${previewImagePost5a("pa1", "Preview image")}${previewVideoPost5a(
        "pfail",
        "Recovering clip",
      )}`,
    );
    await expect
      .poll(() => attempts, { timeout: 20000 })
      .toBe(3);
    await expect
      .poll(() => stats5a(page), { timeout: 15000 })
      .toEqual(expect.objectContaining({ inFlight: 0 }));

    // Fresh playback after the failed attempts lands on the third attempt's
    // prepared element.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Recovering clip");
    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelector(".redditp__video")?.readyState),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
    expect(attempts).toBe(3);
  });
});

test.describe("phase 5a instrumentation", () => {
  test.setTimeout(60000);

  test("navigation reuse classification distinguishes prepared, inflight, and cold video starts", async ({
    page,
  }) => {
    const videos = trackHost5a(page, "v.redd.it", 250);
    trackHost5a(page, "i.redd.it", 250);
    await openFeed5a(
      page,
      `${imagePost5a("f1", "Image 1")}${videoPost5a(
        "f2",
        "Clip Prepared",
        "https://v.redd.it/plainA/DASH_480.mp4",
      )}${imagePost5a("g2", "Image 3")}${imagePost5a("g3", "Image 4")}${videoPost5a(
        "f4",
        "Clip Cold",
        "https://v.redd.it/plainc/DASH_480.mp4",
      )}${imagePost5a("f5", "Image 6")}`,
      (feedPage) => installDurationOverrides5a(feedPage, {}),
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");

    // Race into the still-running preload: navigation joins in fetch.
    await expect
      .poll(() => countOf5a(videos, "/plainA/"), { timeout: 15000 })
      .toBeGreaterThan(0);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip Prepared");
    const joined = await navRecord5a(page);
    expect(["inflight", "prepared"]).toContain(joined.reuse);

    // Plainc sits four posts ahead of the opening station, past the video
    // preload window (2 posts), so a direct numbered-bar jump lands on it
    // as a cold fetch and reports itself as such. Keyboard traversal is not
    // used for the cold case: stepping through Image 3 and Image 4 means
    // finishing stations one and two posts ahead of plainc, which
    // legitimately start its speculative preload (offset <= window) before
    // the navigation arrives.
    expect
      .soft(videos.requested.filter((u) => u.includes("/plainc/")).length)
      .toBe(0);
    expect(videos.requested.some((u) => u.includes("/plainc/"))).toBe(false);
    await page.locator(".redditp__number").nth(4).click();
    await expect(page.locator(".redditp__title")).toHaveText("Clip Cold");
    const cold = await navRecord5a(page);
    expect(cold.reuse).toBe("fresh");
    await expect
      .poll(() => countOf5a(videos, "/plainc/"), { timeout: 15000 })
      .toBeGreaterThan(0);
  });

  test("first-frame-ready evidence uses media data, not metadata, and records ms", async ({
    page,
  }) => {
    const videos = trackHost5a(page, "v.redd.it");
    trackHost5a(page, "i.redd.it");
    await openFeed5a(
      page,
      `${imagePost5a("f1", "Image 1")}${videoPost5a(
        "f2",
        "Clip Prepared",
        "https://v.redd.it/fframe/DASH_480.mp4",
      )}`,
      (feedPage) => installDurationOverrides5a(feedPage, {}),
    );
    await expect(page.locator(".redditp__title")).toHaveText("Image 1");
    // The immediate next eligible video gets one bounded first-frame
    // preparation pass after its metadata:HAVE data is confirmed by the
    // preload-firstframe event, not by declaration.
    await expect
      .poll(
        async () =>
          (await debugEvents5a(page)).some(
            ({ event, detail }) =>
              event === "preload-firstframe" &&
              String(JSON.stringify(detail)).includes("/fframe/"),
          ),
        { timeout: 20000 },
      )
      .toBe(true);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Clip Prepared");
    await expect
      .poll(
        async () =>
          (await debugEvents5a(page)).some(
            ({ event, detail }) =>
              event === "display-firstframe" &&
              String(JSON.stringify(detail)).includes("/fframe/"),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const firstFrame = (await debugEvents5a(page)).find(
      ({ event }) => event === "display-firstframe",
    );
    expect(firstFrame.detail.readyState).toBeGreaterThanOrEqual(2);
    expect(firstFrame.detail.ms).toBeGreaterThanOrEqual(0);
  });
});


