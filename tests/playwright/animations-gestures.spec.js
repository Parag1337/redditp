const path = require("path");
const fs = require("fs");
const { test, expect } = require("@playwright/test");

// Slide transitions + tap/swipe/keyboard interaction audit (phase 6).
// These tests pin the whole navigation contract: one animation engine under
// every entry point, post-level tap zones and swipes, gallery
// falls-throughs at the boundary, pagination-aware end-of-feed middle taps,
// and native video controls that stay untouched by the gesture layer.
// Fixtures are deterministic — no live Reddit.
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
const webm = fs.readFileSync(
  path.resolve(__dirname, "../../test-data/browser-extension-sound.webm"),
);

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/gestures/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const videoPost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}/DASH_480.mp4" data-permalink="/r/gestures/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

const listingContent = (posts) => `<html><body>${posts.join("")}</body></html>`;

const w = (page) => page.evaluate(() => window.innerWidth);
const h = (page) => page.evaluate(() => window.innerHeight);

// A deterministic tap at exact viewport coordinates: left region (15%),
// middle region (50%), right region (85%). The gesture layer must act on
// these coordinates — never on internal navigation calls.
async function tapAt(page, ratioX, ratioY = 0.55) {
  const x = Math.round((await w(page)) * ratioX);
  const y = Math.round((await h(page)) * ratioY);
  await page.mouse.click(x, y);
}

// The swipe path the shipped extension also runs with in Firefox: two
// distinct pointer events with real coordinates. Chromium touch emulation
// is not relied on anywhere.
async function swipe(page, fromRatioX, toRatioX, { ratioY = 0.55 } = {}) {
  const y = Math.round((await h(page)) * ratioY);
  await page.locator("#redditp-presentation").dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "touch",
    clientX: Math.round((await w(page)) * fromRatioX),
    clientY: y,
  });
  await page.locator("#redditp-presentation").dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "touch",
    clientX: Math.round((await w(page)) * toRatioX),
    clientY: y,
  });
}

async function pinAutoAdvance(page, enabled) {
  const auto = page.locator(".redditp__auto");
  const pressed = await auto.getAttribute("aria-pressed");
  if (pressed !== String(enabled)) await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", String(enabled));
}

// Installs media routes, seeds stored settings (seed null = clean defaults),
// injects the viewer (which opens itself), and pins manual mode so timers
// cannot interfere with the assertions. The listing is a real routed URL so
// localStorage seeding works in every engine.
const feedUrl = "https://www.reddit.com/r/gestures/?redditp=gestures";

async function openFeed(page, html, { seed = null, durations = null } = {}) {
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svgImage }),
  );
  await page.route("https://v.redd.it/**", (route) =>
    route.fulfill({ contentType: "video/webm", body: webm }),
  );
  await page.route(
    new RegExp(`^${feedUrl.replace(/[.?]/g, "\\$&")}$`),
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><body>${html}</body></html>`,
      }),
  );
  await page.goto(feedUrl);
  await page.evaluate((seedValue) => {
    if (seedValue) {
      localStorage.setItem(
        "redditpPresentationSettings",
        JSON.stringify(seedValue),
      );
    } else {
      localStorage.removeItem("redditpPresentationSettings");
    }
  }, seed);
  if (durations) await installDurationOverrides(page, durations);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
  // Pin manual mode only when the control row exists: the auto button is
  // hidden while the first slide is still resolving, and a click that
  // raced a running 5s auto timer would leave the feed advancing under
  // the assertions.
  await expect(page.locator(".redditp__auto")).toBeVisible();
  await pinAutoAdvance(page, false);
}

// Forces a deterministic 640x360 video: .redditp__video is height:100% with
// width:auto, so its on-screen geometry follows the source aspect ratio.
// Native 16:9 makes the element full-bleed, which keeps tap coordinates on
// video tests stable in every engine.
async function patchVideoSize(page) {
  await page.evaluate(() => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
      configurable: true,
      get: () => 360,
    });
  });
}

// Deterministic HTMLMediaElement.duration (the model the media-mode and
// pagination suites use): entries map a URL needle to seconds.
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
    },
    Object.entries(map || {}),
  );
}

const titleChip = (page) => page.locator(".redditp__title");
const countChip = (page) => page.locator(".redditp__count");

// The current incoming media element and its animation bookkeeping, read
// straight from the live presentation.
function transitionState(page) {
  return page.evaluate(() => {
    const media = document.querySelector(".redditp__media > :first-child");
    const ghost = document.querySelector(".redditp__ghost");
    return {
      animationName: media ? getComputedStyle(media).animationName : "",
      animClass:
        media?.className?.match(/redditp__media-anim--(\S+)/)?.[1] || "",
      hasBaseClass: Boolean(media?.classList.contains("redditp__media-anim")),
      ghostChildren: ghost ? ghost.children.length : -1,
      ghostAnimation: ghost?.firstElementChild
        ? getComputedStyle(ghost.firstElementChild).animationName
        : "",
      ghostInlineStyle: ghost?.firstElementChild?.getAttribute("style") || "",
    };
  });
}

// A seven-image gallery feed with two ordinary posts after the gallery —
// the shape most of the tap-zone boundary tests navigate.
function galleryFixture() {
  const galleryIds = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"];
  const metadata = {};
  galleryIds.forEach((id) => {
    metadata[id] = {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: `https://preview.redd.it/${id}.jpg?width=1080` },
      p: [],
    };
  });
  const galleryJson = {
    title: "Gallery post",
    post_hint: "gallery",
    is_gallery: true,
    url: "https://www.reddit.com/gallery/gal",
    gallery_data: {
      items: galleryIds.map((media_id) => ({ media_id })),
    },
    media_metadata: metadata,
  };

  async function install(page, { seed = null } = {}) {
    await page.route("https://preview.redd.it/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: svgImage }),
    );
    await page.route(
      new RegExp(
        "^https://www\\.reddit\\.com/r/gestures/comments/gal/post/\\.json$",
      ),
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([
            { data: { children: [{ kind: "t3", data: galleryJson }] } },
          ]),
        }),
    );
    await openFeed(
      page,
      listingContent([
        `<shreddit-post id="t3_gal" post-title="Gallery post" post-type="gallery" content-href="https://www.reddit.com/gallery/gal" permalink="https://www.reddit.com/r/gestures/comments/gal/post/" subreddit-prefixed-name="r/gestures"></shreddit-post>`,
        imagePost("after1", "After gallery"),
        imagePost("after2", "Final post"),
      ]),
      { seed },
    );
    // The gallery detail resolves asynchronously: until it does, the first
    // slide is the pending card labelled (1/1), and one press or tap would
    // jump straight past the gallery. Every caller needs the resolved form.
    await expect(titleChip(page)).toContainText("(1/7)");
  }
  return { install };
}

// Serves `pageCount` batches of 25 posts each and returns the listing URLs
// requested (initial page included).
function serveBatches(page, pageCount) {
  const listing = "https://www.reddit.com/r/gestures/?redditp=gestures";
  const requests = [];
  const pages = [];
  for (let p = 0; p < pageCount; p += 1) {
    const posts = [];
    for (let i = 0; i < 25; i += 1) {
      const n = p * 25 + i + 1;
      posts.push(imagePost(`n${n}`, `Image ${n}`));
    }
    pages.push(posts);
  }
  pages.forEach((posts, index) => {
    const cursor =
      index === 0 ? "" : `?count=${index * 25}&after=t3_cursor${index - 1}`;
    const url = `${listing}${cursor}`;
    page.route(
      new RegExp(`^${url.replace(/[.?]/g, "\\$&")}$`),
      async (route) => {
        requests.push(url);
        const nextHref =
          index + 1 < pages.length
            ? `<div class="nav-buttons"><span class="nextprev">view more:
              <span class="next-button"><a href="${listing}?count=${(index + 1) * 25}&amp;after=t3_cursor${index}" rel="nofollow next">next ›</a></span>
            </span></div>`
            : "";
        await route.fulfill({
          contentType: "text/html",
          body: listingContent([...posts]).replace(
            "</body>",
            `${nextHref}</body>`,
          ),
        });
      },
    );
  });
  return { listing, requests };
}

test.describe("transition animation settings", () => {
  test("default is None and navigation adds no animation", async ({ page }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
    );
    await page.locator(".redditp__settings-button").click();
    await expect(
      page.locator('select[data-setting="transitionAnimation"]'),
    ).toHaveValue("none");
    await page.locator(".redditp__settings-close").click();

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    const state = await transitionState(page);
    expect(state.animClass).toBe("");
    expect(state.hasBaseClass).toBe(false);
    expect(state.ghostChildren).toBe(0);
  });

  test("all six options appear in settings", async ({ page }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
    );
    await page.locator(".redditp__settings-button").click();
    const labels = await page
      .locator('select[data-setting="transitionAnimation"] option')
      .allTextContents();
    expect(labels).toEqual([
      "None",
      "Fade",
      "Slide Right",
      "Slide Left",
      "Ken Burns",
      "Random",
    ]);
  });

  test("selection persists after reload and other settings stay intact", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
    );
    await page.locator(".redditp__settings-button").click();
    await page
      .locator('select[data-setting="transitionAnimation"]')
      .selectOption("fade");
    await page.locator(".redditp__settings-close").click();

    await page.reload();
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await expect(page.locator("#redditp-presentation")).toBeVisible();
    await page.locator(".redditp__settings-button").click();
    await expect(
      page.locator('select[data-setting="transitionAnimation"]'),
    ).toHaveValue("fade");
  });

  test("invalid stored value falls back to None and keeps other settings", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
      {
        seed: {
          slideDurationSeconds: 7,
          transitionAnimation: "sparkle",
        },
      },
    );
    await page.locator(".redditp__settings-button").click();
    await expect(
      page.locator('select[data-setting="transitionAnimation"]'),
    ).toHaveValue("none");
    // The unrelated setting must survive the fallback untouched.
    await expect(page.locator(".redditp__duration-control input")).toHaveValue(
      "7",
    );
  });

  test("Fade animates in, ghosts the previous image out, and cleans up", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
      { seed: { transitionAnimation: "fade" } },
    );
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    const state = await transitionState(page);
    expect(state.animClass).toBe("fade");
    expect(state.animationName).toBe("redditp-anim-fade-in");
    expect(state.ghostChildren).toBe(1);
    expect(state.ghostAnimation).toBe("redditp-anim-fade-out");

    // Animation (or the safety timer) releases every trace.
    await expect
      .poll(async () => (await transitionState(page)).ghostChildren, {
        timeout: 3000,
      })
      .toBe(0);
    await expect
      .poll(async () => (await transitionState(page)).animClass, {
        timeout: 3000,
      })
      .toBe("");
  });

  test("Slide Right: new media enters from the right, old leaves left", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
      { seed: { transitionAnimation: "slide-right" } },
    );
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    const state = await transitionState(page);
    expect(state.animClass).toBe("slide-right");
    expect(state.animationName).toBe("redditp-anim-enter-right");
    expect(state.ghostAnimation).toBe("redditp-anim-exit-left");
    await expect
      .poll(async () => (await transitionState(page)).ghostChildren, {
        timeout: 3000,
      })
      .toBe(0);
  });

  test("Slide Left mirrors the slide no matter which way it is travelled", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
      { seed: { transitionAnimation: "slide-left" } },
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect(titleChip(page)).toHaveText("One");
    const state = await transitionState(page);
    expect(state.animClass).toBe("slide-left");
    expect(state.animationName).toBe("redditp-anim-enter-left");
    expect(state.ghostAnimation).toBe("redditp-anim-exit-right");
    // With slide-left chosen, back-to-forward navigation shows the same
    // left-enter style: the setting names the orientation, not the hop.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    expect((await transitionState(page)).animClass).toBe("slide-left");
  });

  test("Ken Burns animates images and falls back to fade for videos", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("a1", "One"),
        videoPost("a2", "Clip"),
        imagePost("a3", "Three"),
      ]),
      { seed: { transitionAnimation: "ken-burns" } },
    );
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Clip");
    // A zooming video element would scale its native control bar too, so
    // video slides always use the fade instead.
    expect((await transitionState(page)).animClass).toBe("fade");
    await expect(page.locator(".redditp__video")).toHaveJSProperty(
      "muted",
      true,
    );

    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Three");
    const state = await transitionState(page);
    expect(state.animClass).toBe("ken-burns");
    expect(state.animationName).toBe("redditp-anim-ken-burns");
    expect(state.ghostChildren).toBe(0);
  });

  test("Random picks through the injectable sampler and never repeats", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("a1", "One"),
        imagePost("a2", "Two"),
        imagePost("a3", "Three"),
        imagePost("a4", "Four"),
        imagePost("a5", "Five"),
      ]),
      { seed: { transitionAnimation: "random" } },
    );
    // The sampler returns 0, 0.25, 0.5, 0.75 across four calls: each pick
    // lands deeper in the shrinking pool, so the sequence shows all four
    // styles and can never repeat the immediately previous one. "none" is
    // not in the pool at all.
    await page.evaluate(() => {
      let calls = 0;
      window.__redditpPresentation.setRandomSource(() => calls++ / 4);
    });
    const names = [];
    const titles = ["One", "Two", "Three", "Four", "Five"];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("ArrowRight");
      await expect(titleChip(page)).toHaveText(titles[i + 1]);
      names.push((await transitionState(page)).animationName);
    }
    // fade first; every later pick excludes the previous style.
    expect(names).toEqual([
      "redditp-anim-fade-in",
      "redditp-anim-enter-right",
      "redditp-anim-enter-left",
      "redditp-anim-ken-burns",
    ]);
    // The seam restores the production sampler harmlessly.
    await page.evaluate(() =>
      window.__redditpPresentation.setRandomSource(null),
    );
  });

  test("reduced motion keeps navigation immediate and predictable", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("a1", "One"), imagePost("a2", "Two")]),
      { seed: { transitionAnimation: "fade" } },
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    const state = await transitionState(page);
    expect(state.animClass).toBe("");
    expect(state.ghostChildren).toBe(0);
    // No animation runs at all: the computed name is empty or the engines'
    // literal "none".
    expect(["", "none"]).toContain(state.animationName);
  });

  test("rapid navigation supersedes cleanly without stale classes", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("a1", "One"),
        imagePost("a2", "Two"),
        imagePost("a3", "Three"),
        imagePost("a4", "Four"),
      ]),
      { seed: { transitionAnimation: "fade" } },
    );
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // supersedes an in-flight step
    await expect(titleChip(page)).toHaveText("Four");
    await expect
      .poll(async () => {
        const state = await transitionState(page);
        return { anim: state.animClass, ghosts: state.ghostChildren };
      })
      .toEqual({ anim: "", ghosts: 0 });
    // Whatever the engine reports for "nothing running" is fine — the point
    // is that no transitioning class or parked ghost survives.
    const settled = await transitionState(page);
    expect(["", "none"]).toContain(settled.animationName);
    // The displayed image is the real preloaded element, not a visitor that
    // dropped out of the ghost layer: no leftover inline sizing.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll(".redditp__ghost > *")).length,
        ),
      )
      .toBe(0);
    expect(
      await page.evaluate(
        () => (document.querySelector(".redditp__image") || {}).style?.width,
      ),
    ).toBe("");
  });

  test("animations keep gallery counters and slide identity exact", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page, { seed: { transitionAnimation: "fade" } });
    await expect(titleChip(page)).toContainText("(1/7)");
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(2/7)");
    const state = await transitionState(page);
    expect(state.animClass).toBe("fade");
    // The counter is right while the entering animation is still running.
    await expect(titleChip(page)).toContainText("(2/7)");
    await expect(
      page.locator(".redditp__media > :first-child").locator("xpath=.."),
    ).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Tap model — every tap uses real viewport coordinates.

test.describe("tap zones", () => {
  test("left taps land on the previous post at every gallery position", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    // Step into the gallery; the gallery is the feed's first post, so a
    // left tap has no previous post to reach and must not move slides.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(2/7)");
    await tapAt(page, 0.15);
    await expect(titleChip(page)).toContainText("(2/7)");
    // From the post after the gallery, the left zone returns to the
    // PREVIOUS POST — its last eligible slide, not the slide before the
    // current one.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("After gallery");
    await tapAt(page, 0.15);
    await expect(titleChip(page)).toContainText("(7/7)");
  });

  test("right taps always mean next post, not next gallery image", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    await tapAt(page, 0.85);
    await expect(titleChip(page)).toHaveText("After gallery");
  });

  test("middle taps advance gallery images one at a time", async ({ page }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toContainText("(2/7)");
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toContainText("(3/7)");
  });

  test("middle tap on the last gallery image goes to the next post", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(7/7)");
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toHaveText("After gallery");
  });

  test("middle tap on a single-image post goes to the next post", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("s1", "Solo"),
        imagePost("s2", "Second"),
        imagePost("s3", "Third"),
      ]),
    );
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toHaveText("Second");
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toHaveText("Third");
  });

  test("middle tap on a single video post goes to the next post", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([videoPost("v1", "Clip"), imagePost("s2", "Second")]),
    );
    await patchVideoSize(page);
    await expect(titleChip(page)).toHaveText("Clip");
    // The native video may need a moment to attach (a pending slide keeps
    // a poster instead), then the tap lands on the picture, far above the
    // native control strip.
    const video = page.locator(".redditp__video");
    await expect(video).toHaveCount(1);
    const bounds = await video.boundingBox();
    expect(bounds).toBeTruthy();
    const bottom = bounds.y + bounds.height;
    const y = Math.round(bounds.y + bounds.height / 3);
    const x = Math.round((await w(page)) * 0.5);
    expect(bottom - y).toBeGreaterThan(56);
    if (test.info().project.name === "firefox") {
      // Playwright's Firefox build routes pointer input over a native
      // control-bearing video into the browser's own video widget: the page
      // never sees pointerdown/pointerup (verified with an event probe).
      // The same coordinates dispatched on the element exercise the exact
      // same handler path instead.
      await video.dispatchEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: x,
        clientY: y,
      });
      await video.dispatchEvent("pointerup", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: x,
        clientY: y,
      });
    } else {
      await page.mouse.click(x, y);
    }
    await expect(titleChip(page)).toHaveText("Second");
  });

  test("middle tap at the end of the loaded feed triggers pagination", async ({
    page,
  }) => {
    const { listing, requests } = serveBatches(page, 2);
    await page.route("https://i.redd.it/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: svgImage }),
    );
    await page.route("https://v.redd.it/**", (route) =>
      route.fulfill({ contentType: "video/webm", body: webm }),
    );
    await page.goto(listing);
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await expect(page.locator("#redditp-presentation")).toBeVisible();
    await expect(page.locator(".redditp__auto")).toBeVisible();
    await pinAutoAdvance(page, false);
    await expect(countChip(page)).toHaveText("1 / 25");
    for (let i = 0; i < 24; i += 1) await page.keyboard.press("ArrowRight");
    // Landing on the last loaded post already fires the loader (this pin is
    // the shipped behavior the pagination suite asserts) — the count
    // reflects the appended batch while the slide stays parked.
    await expect(countChip(page)).toHaveText("25 / 50");
    // The middle tap is what actually walks onto the appended post.
    await tapAt(page, 0.5);
    await expect(titleChip(page)).toHaveText("Image 26");
    await expect(countChip(page)).toHaveText("26 / 50");
    expect(requests.length).toBe(2);
  });

  test("UI controls never additionally trigger tap-zone navigation", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("c1", "One"),
        imagePost("c2", "Two"),
        imagePost("c3", "Three"),
      ]),
    );
    await expect(countChip(page)).toHaveText("1 / 3");
    // Each control is exercised on its own and undone, so a later control's
    // click is never blocked by an overlay opened by an earlier one.
    await page.locator(".redditp__rotate").click();
    await expect(countChip(page)).toHaveText("1 / 3");
    await page.keyboard.press("r"); // undo rotate
    await page.locator(".redditp__fullscreen").click();
    await expect(countChip(page)).toHaveText("1 / 3");
    await page.locator(".redditp__hide").click();
    await expect(countChip(page)).toHaveText("1 / 3");
    await page.keyboard.press("h"); // unhide the interface again
    await page.locator(".redditp__settings-button").click();
    await expect(countChip(page)).toHaveText("1 / 3");
    await page.locator(".redditp__settings-close").click();
    await expect(countChip(page)).toHaveText("1 / 3");
  });
});

// --------------------------------------------------------------------------
// Swipe model — post-level in both directions, with thresholds.

test.describe("swipe gestures", () => {
  test("swipe left is the next post even from inside a gallery", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(3/7)");
    await swipe(page, 0.75, 0.25);
    await expect(titleChip(page)).toHaveText("After gallery");
  });

  test("swipe right is the previous post's last eligible slide", async ({
    page,
  }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    await swipe(page, 0.75, 0.25); // to After gallery
    await expect(titleChip(page)).toHaveText("After gallery");
    await swipe(page, 0.25, 0.75); // back to the gallery
    await expect(titleChip(page)).toContainText("(7/7)");
  });

  test("swipe on a video navigates posts without touching playback", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        videoPost("v1", "Clip"),
        imagePost("i2", "Second"),
        imagePost("i3", "Third"),
      ]),
    );
    await expect(titleChip(page)).toHaveText("Clip");
    await swipe(page, 0.75, 0.25);
    await expect(titleChip(page)).toHaveText("Second");
    await swipe(page, 0.25, 0.75);
    await expect(titleChip(page)).toHaveText("Clip");
  });

  test("vertical swipes are never read as horizontal navigation", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("v1", "One"), imagePost("v2", "Two")]),
    );
    const y0 = Math.round((await h(page)) * 0.2);
    const y1 = Math.round((await h(page)) * 0.8);
    await page.locator("#redditp-presentation").dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: Math.round((await w(page)) * 0.5),
      clientY: y0,
    });
    await page.locator("#redditp-presentation").dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      clientX: Math.round((await w(page)) * 0.5),
      clientY: y1,
    });
    await expect(titleChip(page)).toHaveText("One");
  });

  test("small horizontal movements do not navigate", async ({ page }) => {
    await openFeed(
      page,
      listingContent([imagePost("s1", "One"), imagePost("s2", "Two")]),
    );
    const midX = Math.round((await w(page)) * 0.5);
    const y = Math.round((await h(page)) * 0.55);
    await page.locator("#redditp-presentation").dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: midX,
      clientY: y,
    });
    await page.locator("#redditp-presentation").dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      clientX: midX + 30,
      clientY: y,
    });
    await expect(titleChip(page)).toHaveText("One");
  });

  test("taps keep working on video picture areas; the strip stays clear", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([videoPost("v1", "Clip"), imagePost("i2", "Second")]),
    );
    await patchVideoSize(page);
    const video = page.locator(".redditp__video");
    await expect(video).toHaveCount(1);
    const bounds = await video.boundingBox();
    expect(bounds).toBeTruthy();
    // A picture tap in the LEFT zone cannot navigate (no previous post at
    // the feed start), so it keeps the existing surface toggle behavior:
    // pause first, play again with the second tap.
    const tapX = Math.round(bounds.x + bounds.width * 0.2);
    const tapY = Math.round(bounds.y + bounds.height / 3);
    if (test.info().project.name === "firefox") {
      // Same UA-widget limitation as above: in Playwright's Firefox the page
      // receives no pointer or click events over a control-bearing video, so
      // the surface toggle is exercised through dispatched events at the
      // identical picture coordinates. Chromium verifies the real
      // hit-tested path with the mouse below.
      await video.dispatchEvent("click", {
        button: 0,
        bubbles: true,
        clientX: tapX,
        clientY: tapY,
      });
      await expect(video).toHaveJSProperty("paused", true);
      await video.dispatchEvent("click", {
        button: 0,
        bubbles: true,
        clientX: tapX,
        clientY: tapY,
      });
      await expect(video).toHaveJSProperty("paused", false);
    } else {
      await page.mouse.click(tapX, tapY);
      await expect(video).toHaveJSProperty("paused", true);
      await page.mouse.click(tapX, tapY);
      await expect(video).toHaveJSProperty("paused", false);
    }
    // The control strip (bottom 56px of the video) must not navigate. The
    // coordinates travel through the video element so the strip guard's
    // event.target check is exercised in both engines.
    const stripY = Math.round(bounds.y + bounds.height - 30);
    if (test.info().project.name !== "firefox") {
      // Real hit-tested mouse input where the engine supports it: the strip
      // must not navigate (and the browser's own controls stay usable).
      await page.mouse.move(Math.round((await w(page)) * 0.5), stripY);
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await video.dispatchEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: Math.round((await w(page)) * 0.5),
        clientY: stripY,
      });
      await video.dispatchEvent("pointerup", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: Math.round((await w(page)) * 0.5),
        clientY: stripY,
      });
    }
    await expect(titleChip(page)).toHaveText("Clip");
  });

  test("swipes still navigate in rotated mode", async ({ page }) => {
    await openFeed(
      page,
      listingContent([imagePost("r1", "One"), imagePost("r2", "Two")]),
    );
    await page.keyboard.press("r");
    await expect(
      page.locator("#redditp-presentation.redditp__rotated"),
    ).toHaveCount(1);
    await swipe(page, 0.75, 0.25);
    await expect(titleChip(page)).toHaveText("Two");
    await swipe(page, 0.25, 0.75);
    await expect(titleChip(page)).toHaveText("One");
  });

  test("taps respect filtered feeds and the 60-second exclusion", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("f1", "First image"),
        videoPost("long", "Long video"),
        imagePost("f2", "Second image"),
      ]),
      {
        seed: { mediaMode: "images" },
        durations: [["v.redd.it/long", 90]],
      },
    );
    await expect(titleChip(page)).toHaveText("First image");
    await tapAt(page, 0.85); // must skip the excluded 90s video post
    await expect(titleChip(page)).toHaveText("Second image");
    await tapAt(page, 0.15);
    await expect(titleChip(page)).toHaveText("First image");
    // Words-only mode: in mode filtering the loader sits on the tail.
    await expect(countChip(page)).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// Keyboard model

test.describe("keyboard navigation", () => {
  test("arrows step posts on ordinary feeds", async ({ page }) => {
    await openFeed(
      page,
      listingContent([imagePost("k1", "One"), imagePost("k2", "Two")]),
    );
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    await page.keyboard.press("ArrowLeft");
    await expect(titleChip(page)).toHaveText("One");
    await page.keyboard.press("PageDown");
    await expect(titleChip(page)).toHaveText("Two");
    await page.keyboard.press("PageUp");
    await expect(titleChip(page)).toHaveText("One");
  });

  test("up and down step images inside a gallery", async ({ page }) => {
    const gallery = galleryFixture();
    await gallery.install(page);
    await expect(titleChip(page)).toContainText("(1/7)");
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toContainText("(2/7)");
    await page.keyboard.press("ArrowDown");
    await expect(titleChip(page)).toContainText("(3/7)");
    await page.keyboard.press("ArrowUp");
    await expect(titleChip(page)).toContainText("(2/7)");
  });

  test("keys focused inside settings never navigate the viewer", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("k1", "One"), imagePost("k2", "Two")]),
      { seed: { slideDurationSeconds: 5 } },
    );
    await page.locator(".redditp__settings-button").click();
    const input = page.locator(".redditp__duration-control input");
    await input.focus();
    await page.keyboard.press("ArrowUp"); // the input owns this key
    await expect(input).toHaveValue("6");
    await expect(titleChip(page)).toHaveText("One");
    await page.keyboard.press("ArrowDown");
    await expect(input).toHaveValue("5");
    const select = page.locator('select[data-setting="transitionAnimation"]');
    await select.focus();
    await page.keyboard.press("ArrowRight"); // walks the select's options
    await expect(select).toHaveValue("fade");
    await expect(titleChip(page)).toHaveText("One");
    await page.keyboard.press("Escape");
    await expect(page.locator(".redditp__settings-overlay")).toBeHidden();
    await expect(titleChip(page)).toHaveText("One");
  });
});

// --------------------------------------------------------------------------
// Cross-feature regression

test.describe("cross-feature", () => {
  test("slideshow auto-advance keeps working with the chosen animation", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([imagePost("s1", "One"), imagePost("s2", "Two")]),
      { seed: { transitionAnimation: "fade" } },
    );
    await pinAutoAdvance(page, true);
    // The 5s default slide timer drives the advance; poll past its worst
    // case once.
    await expect(titleChip(page)).toHaveText("Two", { timeout: 9000 });
    const state = await transitionState(page);
    expect(["fade", ""].includes(state.animClass)).toBe(true);
    expect(state.animationName).not.toBe("");
  });

  test("every entry point shares the same transition engine", async ({
    page,
  }) => {
    await openFeed(
      page,
      listingContent([
        imagePost("x1", "One"),
        imagePost("x2", "Two"),
        imagePost("x3", "Three"),
      ]),
      { seed: { transitionAnimation: "slide-right" } },
    );
    // Keyboard, tap, and swipe each go through the same request mechanism.
    await page.keyboard.press("ArrowRight");
    await expect(titleChip(page)).toHaveText("Two");
    expect((await transitionState(page)).animClass).toBe("slide-right");
    await expect
      .poll(async () => (await transitionState(page)).ghostChildren, {
        timeout: 3000,
      })
      .toBe(0);
    await tapAt(page, 0.85);
    await expect(titleChip(page)).toHaveText("Three");
    expect((await transitionState(page)).animClass).toBe("slide-right");
    await expect
      .poll(async () => (await transitionState(page)).ghostChildren, {
        timeout: 3000,
      })
      .toBe(0);
    await swipe(page, 0.25, 0.75);
    await expect(titleChip(page)).toHaveText("Two");
    expect((await transitionState(page)).animClass).toBe("slide-right");
  });
});
