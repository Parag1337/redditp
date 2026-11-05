const path = require("path");
const fs = require("fs");
const { test, expect } = require("@playwright/test");

// Feed-pagination regression suite. These tests pin the behavior broken by
// the filtered-feed stall: the end-of-feed loader only fired when the user
// stood on the raw feed's last post, which the media modes and the 60s
// duration policy can keep permanently out of reach (the reported 50-post
// stall and the ninth-video stall).
const extensionScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const listing = "https://www.reddit.com/r/pagination/?redditp=pagination";
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pagination/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}/DASH_480.mp4" data-permalink="/r/pagination/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// Old-style 6-slide mixed gallery (4 images interleaved with 2 videos),
// resolved through the post JSON endpoint the way the media-mode suite
// models galleries.
const galleryCard = (title) =>
  `<shreddit-post id="t3_gal" post-title="${title}" post-type="gallery" content-href="https://www.reddit.com/gallery/gal" permalink="https://www.reddit.com/r/pagination/comments/gal/post/" subreddit-prefixed-name="r/pagination"></shreddit-post>`;

const galleryPostUrl = "https://www.reddit.com/r/pagination/comments/gal/post/";

function galleryJson() {
  const imageIds = ["gal-img1", "gal-img2", "gal-img3", "gal-img4"];
  const videoIds = ["gal-vid1", "gal-vid2"];
  const metadata = {};
  imageIds.forEach((mediaId) => {
    metadata[mediaId] = {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: `https://preview.redd.it/${mediaId}.jpg?width=1080` },
      p: [],
    };
  });
  videoIds.forEach((mediaId) => {
    metadata[mediaId] = {
      status: "valid",
      e: "AnimatedImage",
      m: "image/gif",
      s: {
        gif: `https://preview.redd.it/${mediaId}.gif`,
        mp4: `https://preview.redd.it/${mediaId}.mp4?format=mp4`,
      },
      p: [],
    };
  });
  return {
    title: "Gallery post",
    post_hint: "gallery",
    is_gallery: true,
    url: "https://www.reddit.com/gallery/gal",
    gallery_data: {
      items: [
        { media_id: imageIds[0] },
        { media_id: videoIds[0] },
        { media_id: imageIds[1] },
        { media_id: videoIds[1] },
        { media_id: imageIds[2] },
        { media_id: imageIds[3] },
      ],
    },
    media_metadata: metadata,
  };
}

// Builds `pageCount` batches of 25 posts each; `kindFor(n)` returns
// "image" or "video" for the 1-based feed position n.
function buildBatches(pageCount, kindFor) {
  const pages = [];
  for (let p = 0; p < pageCount; p += 1) {
    const posts = [];
    for (let i = 0; i < 25; i += 1) {
      const n = p * 25 + i + 1;
      posts.push(
        kindFor(n) === "video"
          ? videoPost(`n${n}`, `Video ${n}`)
          : imagePost(`n${n}`, `Image ${n}`),
      );
    }
    pages.push(posts);
  }
  return pages;
}

// Serves the listing fixture and returns the log of requested listing URLs
// (initial page included). `failLeft` sizes transient failures per URL,
// `delayMs` delays a fulfillment so pagination can be raced.
function serveListing(page, pages, { failLeft = {}, delayMs = {} } = {}) {
  const requests = [];
  pages.forEach((posts, index) => {
    const cursor =
      index === 0 ? "" : `?count=${index * 25}&after=t3_cursor${index - 1}`;
    const url = `${listing}${cursor}`;
    page.route(
      new RegExp(`^${url.replace(/[.?]/g, "\\$&")}$`),
      async (route) => {
        requests.push(url);
        if (failLeft[url] > 0) {
          failLeft[url] -= 1;
          await route.fulfill({ status: 429, body: "slow down" });
          return;
        }
        const nextHref =
          index + 1 < pages.length
            ? `<div class="nav-buttons"><span class="nextprev">view more:
              <span class="next-button"><a href="${listing}?count=${(index + 1) * 25}&amp;after=t3_cursor${index}" rel="nofollow next">next ›</a></span>
            </span></div>`
            : "";
        const body = `<html><body>${posts.join("")}${nextHref}</body></html>`;
        if (delayMs[url]) {
          await new Promise((resolve) => setTimeout(resolve, delayMs[url]));
        }
        await route.fulfill({ contentType: "text/html", body });
      },
    );
  });
  return requests;
}

// Serves media assets deterministically so the preload queue stays out of
// the way of the pagination assertions.
function trackMediaHosts(page) {
  page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svgImage,
    }),
  );
  page.route("https://v.redd.it/**", (route) =>
    route.fulfill({ status: 200, contentType: "video/webm", body: webm }),
  );
  page.route("https://preview.redd.it/**", (route) => {
    const url = route.request().url();
    if (/\.mp4/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: svgImage,
    });
  });
}

// Deterministic HTMLMediaElement.duration, the same model the media-mode
// suite uses. `null` means the stream reports NaN (unknown duration).
async function installDurationOverrides(page, map) {
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
  }, Object.entries(map || {}));
}

async function openFeed(page, seed, { pinAuto = true, durations = null } = {}) {
  await page.goto(listing);
  await page.evaluate((seedValue) => {
    localStorage.setItem("redditpDebug", "1");
    localStorage.removeItem("redditpPresentationSettings");
    if (seedValue) {
      localStorage.setItem(
        "redditpPresentationSettings",
        JSON.stringify(seedValue),
      );
    }
  }, seed || null);
  if (durations) await installDurationOverrides(page, durations);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  if (pinAuto) {
    const auto = page.locator(".redditp__auto");
    const pressed = await auto.getAttribute("aria-pressed");
    if (pressed !== "false") await auto.click();
    await expect(auto).toHaveAttribute("aria-pressed", "false");
  }
}

const countChip = (page) => page.locator(".redditp__count");
const titleChip = (page) => page.locator(".redditp__title");
const modeButton = (page) => page.locator(".redditp__media-mode");

async function pressRight(page, times) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press("ArrowRight");
    // A press landing while the loader is in flight may be queued instead
    // of moving; wait for the in-flight marker to clear so press counts
    // stay exact.
    const text = await page.textContent(".redditp__count");
    if (text && text.includes("loading more")) {
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".redditp__count")
            ?.textContent.includes("loading more") ||
          document.querySelector(".redditp__count")?.textContent === null,
        null,
        { timeout: 5000 },
      );
    }
  }
}

// Routes the gallery detail pages (post page + post JSON endpoint).
function routeGalleryDetail(page) {
  page.route(`${galleryPostUrl}$`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body class='shell'></body></html>",
    }),
  );
  page.route(
    new RegExp(`^${galleryPostUrl.replace(/\./g, "\\.")}\\.json$`),
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          {
            data: { children: [{ kind: "t3", data: galleryJson() }] },
          },
        ]),
      }),
  );
}

test.describe("feed pagination", () => {
  test.setTimeout(120 * 1000);

  test("loads the second batch when the initial one is used up", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const requests = serveListing(page, buildBatches(3, () => "image"));
    await openFeed(page);
    await expect(countChip(page)).toHaveText("1 / 25");

    // The 24th press parks on the last post of batch one; the loader fires
    // from that render and appends the next batch (requests: page + 1).
    await pressRight(page, 24);
    await expect(countChip(page)).toHaveText("25 / 50");
    await expect(requests.length).toBe(2);

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 26");
    await expect(countChip(page)).toHaveText("26 / 50");
    await expect(requests.length).toBe(2);
  });

  test("loads a third batch when approaching the end of the second", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const requests = serveListing(page, buildBatches(4, () => "image"));
    await openFeed(page);

    await pressRight(page, 49);
    // Standing on Image 50 appended batch three from the last render.
    await expect(countChip(page)).toHaveText("50 / 75");
    await expect(requests.length).toBe(3);

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 51");
    await expect(countChip(page)).toHaveText("51 / 75");
    // Approaching the end must not re-request a satisfied cursor.
    await expect(requests.length).toBe(3);
  });

  test("pagination keeps running after appended posts become the active feed", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const requests = serveListing(page, buildBatches(5, () => "image"));
    await openFeed(page);

    // 99 presses reach Image 100; along the way every batch boundary
    // (25/50/75/100) appended the following batch from its render.
    await pressRight(page, 99);
    await expect(countChip(page)).toHaveText("100 / 125");
    await expect(requests.length).toBe(5);
  });

  test("videos mode loads further batches after the ninth eligible video", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Nine eligible clips in the first 50 posts; the rest are images.
    const videoNos = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45]);
    const kindFor = (n) => (videoNos.has(n) ? "video" : "image");
    const pages = buildBatches(3, kindFor);
    pages[2][0] = videoPost("n51", "Video 51");
    const requests = serveListing(page, pages);
    await openFeed(page, { mediaMode: "videos" });

    // The mode only numbers the eligible videos. Batch two (appended
    // passively while walking through batch one) and batch three (appended
    // passively on the ninth video's render) are already in place.
    await expect(countChip(page)).toHaveText("1 / 5");
    await pressRight(page, 8);
    await expect(countChip(page)).toHaveText("9 / 10");
    await expect(requests.length).toBe(3);

    // The tenth navigation request finds the eligible clip in batch three.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Video 51");
    await expect(countChip(page)).toHaveText("10 / 10");
    await expect(requests.length).toBe(3);
  });

  test("images mode keeps scanning after the ninth eligible image", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Nine eligible images in the first 50 posts; everything else is video.
    const imageNos = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45]);
    const kindFor = (n) => (imageNos.has(n) ? "image" : "video");
    const pages = buildBatches(3, kindFor);
    pages[2][0] = imagePost("n51", "Image 51");
    const requests = serveListing(page, pages);
    await openFeed(page, { mediaMode: "images" });

    await expect(countChip(page)).toHaveText("1 / 5");
    await pressRight(page, 8);
    await expect(countChip(page)).toHaveText("9 / 10");
    await expect(requests.length).toBe(3);

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 51");
    await expect(countChip(page)).toHaveText("10 / 10");
    await expect(requests.length).toBe(3);
  });

  test("consecutive batches without eligible media keep getting requested, then eligible content is found", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Batch one holds five eligible clips; batches two and three hold none;
    // batch four brings clips again.
    const videoNos = new Set([5, 10, 15, 20, 25, 76, 81]);
    const kindFor = (n) => (videoNos.has(n) ? "video" : "image");
    const pages = buildBatches(4, kindFor);
    const requests = serveListing(page, pages);
    await openFeed(page, { mediaMode: "videos" });

    await expect(countChip(page)).toHaveText("1 / 5");
    await pressRight(page, 4);
    await expect(countChip(page)).toHaveText("5 / 5");
    // Parked on Video 25 (the batch-one walk) already appended batch two,
    // which holds no clips.
    await expect(requests.length).toBe(2);

    // First "next" past Video 25: batch three appends, still without clips.
    await page.keyboard.press("ArrowRight");
    await expect(countChip(page)).toHaveText("5 / 5");
    await expect(requests.length).toBe(3);

    // Second "next": batch four finally holds clips, and navigation lands on
    // the first of them without another user action.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Video 76");
    await expect(countChip(page)).toHaveText("6 / 7");
    await expect(requests.length).toBe(4);
  });

  test("a mixed gallery's last video triggers loading in videos mode and the mode switch keeps the gallery reachable", async ({
    page,
  }) => {
    trackMediaHosts(page);
    routeGalleryDetail(page);
    const pages = buildBatches(3, (n) => (n >= 51 ? "video" : "image"));
    // The gallery replaces the last post of batch one; batch two stays all
    // images, so batch two adds no eligible video.
    pages[0][24] = galleryCard("Gallery post");
    const requests = serveListing(page, pages);
    await openFeed(page, { mediaMode: "videos" });

    // The gallery's two clips are the only eligible slides of batch one.
    await expect(titleChip(page)).toContainText("(1/2)");
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(2/2)");
    // Standing on the gallery's LAST video parks the user on the last
    // eligible post, whose render loaded batch two through cursor0.
    const secondCursor = `${listing}?count=25&after=t3_cursor0`;
    await expect
      .poll(() => requests.includes(secondCursor), { timeout: 10000 })
      .toBe(true);

    // Batch two holds no clips; further presses scan further batches (the
    // loader runs in the background while parked) until batch three's first
    // video becomes reachable.
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press("ArrowRight");
      if ((await titleChip(page).textContent()) === "Video 51") break;
    }
    await expect(titleChip(page)).toHaveText("Video 51");
    await expect(countChip(page)).toHaveText("2 / 26");
    await expect(requests.length).toBe(3);

    // Back to images mode: the gallery's images are reachable again. From
    // Video 51 nothing eligible lies forward, so the re-land searches back
    // and finds the raw feed's last eligible image.
    await modeButton(page).click(); // videos -> both
    await modeButton(page).click(); // both -> images
    await expect(titleChip(page)).toHaveText("Image 50");
    await expect(countChip(page)).toHaveText("50 / 50");
  });

  test("slideshow continues through a batch appended while standing on the last eligible slide", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const videoNos = new Set([5, 10, 15, 20, 25, 31]);
    const kindFor = (n) => (videoNos.has(n) ? "video" : "image");
    const pages = buildBatches(3, kindFor);
    const requests = serveListing(page, pages);
    await openFeed(
      page,
      {
        mediaMode: "videos",
        slideDurationSeconds: 1,
        autoAdvance: true,
      },
      { pinAuto: false },
    );

    // The slideshow walks the five clips of batch one; batch two appends
    // passively from the render of the parked last clip, and the timer
    // keeps advancing into it. Landing on the appended clip fires the
    // passive loader again, so batch three is requested in the background.
    await expect(titleChip(page)).toHaveText("Video 31", { timeout: 30000 });
    await expect(countChip(page)).toHaveText("6 / 6");
    await expect(requests.length).toBe(3);
  });

  test("numbered navigation near the end of the loaded feed triggers loading", async ({
    page,
  }) => {
    trackMediaHosts(page);
    const requests = serveListing(page, buildBatches(3, () => "image"));
    await openFeed(page);

    // Jump straight to the last post of batch one.
    await page
      .locator(".redditp__number")
      .filter({ hasText: "25" })
      .last()
      .click();
    await expect(titleChip(page)).toHaveText("Image 25");
    // The render of that landing appends batch two; the numbered bar shows
    // the raw feed's posts (5A identity), not a filtered rewrite.
    await expect(countChip(page)).toHaveText("25 / 50");
    await expect(await page.locator(".redditp__number").count()).toBe(50);
    await expect(requests.length).toBe(2);
  });

  test("a transient next-page failure wraps and later navigations recover", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // The third page fails once (429) so the passive loader parked on
    // Image 50 exhausts its first attempt.
    const failedUrl = `${listing}?count=50&after=t3_cursor1`;
    const requests = serveListing(page, buildBatches(3, () => "image"), {
      failLeft: { [failedUrl]: 1 },
    });
    await openFeed(page);

    await pressRight(page, 24);
    await expect(countChip(page)).toHaveText("25 / 50");
    await expect(requests.length).toBe(2);

    await pressRight(page, 25);
    // Standing on Image 50 fires the loader, which fails (429): the feed
    // keeps both appended batches and stays parked on the last post.
    await expect(titleChip(page)).toHaveText("Image 50");
    await expect(countChip(page)).toHaveText("50 / 50");
    await expect(requests.length).toBe(3);

    // The next navigation retries the same cursor and recovers.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 51");
    await expect(countChip(page)).toHaveText("51 / 75");
    await expect(requests.length).toBe(4);
  });

  test("genuine exhaustion stops cleanly without repeated requests", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Batch two has no follow-up: the provider feed truly ends here.
    const requests = serveListing(page, buildBatches(2, () => "image"));
    await openFeed(page);

    await pressRight(page, 24);
    await expect(countChip(page)).toHaveText("25 / 50");

    await pressRight(page, 25);
    await expect(titleChip(page)).toHaveText("Image 50");
    await expect(countChip(page)).toHaveText("50 / 50");

    // The next press scans for more, finds a cursor-less feed, and wraps.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 1");
    await expect(countChip(page)).toHaveText("1 / 50");

    // Continued navigation stays inside the feed and never re-requests a
    // satisfied cursor.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 2");
    await expect(requests.length).toBe(2);
  });

  test("scroll and navigation triggers close together request each cursor once", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // A delayed second page guarantees the burst happens while the loader
    // is in flight.
    const requests = serveListing(page, buildBatches(3, () => "image"), {
      delayMs: { [`${listing}?count=25&after=t3_cursor0`]: 600 },
    });
    await openFeed(page);

    await pressRight(page, 24);
    await expect(titleChip(page)).toHaveText("Image 25");
    // The 24th press kicked off the (delayed) loader and pressRight waited
    // for it to settle, so the appended batch is in place before the burst.
    await expect(countChip(page)).toHaveText("25 / 50");
    await expect(requests.length).toBe(2);

    // Two rapid presses: each advances exactly one post. The burst does
    // not duplicate the satisfied cursor.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 27");
    await expect(countChip(page)).toHaveText("27 / 50");
    await expect(requests.length).toBe(2);

    // Another press with the appended batch in place: plain navigation, no
    // extra cursor request.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 28");
    await expect(countChip(page)).toHaveText("28 / 50");
    await expect(requests.length).toBe(2);
  });

  test("switching modes while a pagination request is in flight keeps the cursor and appends once", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Batch one: 24 images + a 60s eligible clip at the end; batch two:
    // 25 images; batches three and four: 25 videos each (ineligible in
    // images mode).
    const pages = buildBatches(4, (n) => (n >= 51 ? "video" : "image"));
    pages[0][24] = videoPost("c60", "Clip 60");
    const requests = serveListing(page, pages, {
      delayMs: { [`${listing}?count=25&after=t3_cursor0`]: 600 },
    });
    await openFeed(page, null, {
      durations: { "/c60/": 60 },
    });
    await pressRight(page, 23);
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Clip 60");
    // The 24th press kicked off the delayed loader; its in-flight marker
    // (the count suffix) proves the request is actually in flight.
    await expect(countChip(page)).toHaveText("25 / 25 · loading more");

    // Mode switches while the delayed fetch is in flight.
    await modeButton(page).click(); // both -> images
    await expect(modeButton(page)).toHaveAttribute("data-media-mode", "images");

    // The in-flight scan completes after the switch and appends once.
    await expect(countChip(page)).toHaveText("24 / 49");
    await expect(requests.length).toBe(2);

    // The cursor survives the switch: walking the appended batch and later
    // pressing past its end fetches only the second cursor, and no cursor
    // is requested twice.
    await pressRight(page, 25);
    await expect(titleChip(page)).toHaveText("Image 50");
    await expect(countChip(page)).toHaveText("49 / 49");
    // The last-eligible render loaded batch three in the background.
    await expect
      .poll(() => requests.length, { timeout: 10000 })
      .toBe(3);
    await page.keyboard.press("ArrowRight");
    // Batch four appends but adds nothing in images mode, so the count and
    // the position stay put without wrapping.
    await expect(countChip(page)).toHaveText("49 / 49");
    await expect(requests.length).toBe(4);
    await expect(new Set(requests).size).toBe(requests.length);
  });

  test("the 60-second duration policy survives pagination", async ({
    page,
  }) => {
    trackMediaHosts(page);
    // Batch one: images 1..22, a 60s clip, a 75s clip, an unknown clip;
    // batch two: plain images.
    const pages = buildBatches(2, () => "image");
    pages[0][22] = videoPost("c60", "Clip 60");
    pages[0][23] = videoPost("clong", "Clip Long");
    pages[0][24] = videoPost("cunknown", "Clip Unknown");
    const requests = serveListing(page, pages);
    await openFeed(page, null, {
      durations: { "/c60/": 60, "/clong/": 75, "/cunknown/": null },
    });

    await pressRight(page, 22);
    await expect(titleChip(page)).toHaveText("Clip 60");
    await expect(countChip(page)).toHaveText("23 / 25");

    // The 75s clip is skipped as a whole post, and the unknown clip stays
    // provisionally eligible. Ending on the last eligible post appends
    // batch two from its render, so the total becomes 50.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Clip Unknown");
    await expect(countChip(page)).toHaveText("25 / 50");
    await expect(requests.length).toBe(2);

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Image 26");
    // Duration-excluded posts keep their feed numbers (5A identity), so the
    // count walks 1..22 images, Clip 60=23, Clip Long=24, Clip
    // Unknown=25, Image 26=26.
    await expect(countChip(page)).toHaveText("26 / 50");
    await expect(requests.length).toBe(2);
  });
});
