// Focused coverage for the 2026-11 preload-reliability pass and the mobile
// UI redesign. The preload tests read the localStorage.redditpDebug ring via
// window.__redditpPresentation.debug, so every asserted transition is a real
// production event, not a test-only hook. Mobile tests use touch-enabled
// emulation at phone viewports; they are emulation, not real-device runs.
const path = require("path");
const { test, expect } = require("@playwright/test");

const extensionScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const listingUrl = "https://www.reddit.com/r/pics/";
const svgImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>';

function postHtml(id, title, url) {
  return `<div class="thing link" data-fullname="t3_${id}" data-url="${
    url || `https://i.redd.it/${id}.jpg`
  }" data-permalink="/r/pics/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;
}

function feedHtml(count, titlePrefix = "Post") {
  return Array.from({ length: count }, (_, i) =>
    postHtml(`m${i + 1}`, `${titlePrefix} ${i + 1}`),
  ).join("");
}

// Serves the feed from the real origin (localStorage and the debug ring
// work there) and opens the viewer with auto-advance pinned off.
async function openFeed(page, html, { media = {}, clock = false } = {}) {
  if (clock) await page.clock.install();
  await page.route(listingUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route("https://i.redd.it/**", (route) => {
    const pending = media[route.request().url()];
    if (pending) return pending(route);
    return route.fulfill({ contentType: "image/svg+xml", body: svgImage });
  });
  await page.goto(listingUrl);
  await page.evaluate(() => {
    localStorage.setItem("redditpPresentationSettings", JSON.stringify({}));
    localStorage.setItem("redditpDebug", "1");
  });
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await expect(page.locator("#redditp-presentation")).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.locator(".redditp__auto")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
}

function debugLog(page, filter) {
  return page.evaluate((event) => {
    return window.__redditpPresentation.debug
      .log()
      .filter((entry) => !event || entry.event === event)
      .map((entry) => ({ event: entry.event, detail: entry.detail }));
  }, filter);
}

test.describe("preload reliability", () => {
  test("image preloads record the state chain and a forward navigation reuses the cache", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(4));
    // Let the scheduler drain the horizon.
    await page.waitForTimeout(300);

    const started = await debugLog(page, "preload-start");
    expect(started.length).toBeGreaterThan(0);
    const loaded = await debugLog(page, "preload-loaded");
    expect(loaded.length).toBeGreaterThan(0);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
    const navigation = await page.evaluate(() =>
      window.__redditpPresentation.debug.lastNavigation(),
    );
    expect(navigation.ready).toBe(true);
    const hits = await debugLog(page, "cache-hit");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("cache reuse survives a step backward without a second request", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(4));
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
    await page.waitForTimeout(200);

    const startedBefore = await page.evaluate(
      () => window.__redditpPresentation.debug.stats().started,
    );
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Post 1");
    await page.waitForTimeout(200);

    const mark = await page.evaluate(() => Date.now());
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".redditp__title")).toHaveText("Post 1");
    await page.waitForTimeout(200);

    const stats = await page.evaluate(() =>
      window.__redditpPresentation.debug.stats(),
    );
    // The step back reused the prepared element: no new network work beyond
    // the initial horizon drain (a revisit-video job may add at most one).
    expect(stats.started).toBeLessThanOrEqual(startedBefore + 1);
    // Post 1's media came from the cache: no fresh fetch after the step
    // back. (Earlier misses belong to the cold start, so the check is
    // time-filtered.)
    const lateMisses = await page.evaluate((since) => {
      return window.__redditpPresentation.debug
        .log()
        .filter(
          (entry) =>
            entry.event === "cache-miss" &&
            entry.t >= since &&
            String(entry.detail || "").includes("m1|0|"),
        );
    }, mark);
    expect(lateMisses).toEqual([]);
  });

  test("rapid navigation leaves no corrupted state and the stage shows the landing slide", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(10));
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(30);
    }
    await expect(page.locator(".redditp__title")).toHaveText("Post 9");
    const stage = await page.evaluate(() => {
      const box = document.querySelector(".redditp__media");
      const index = window.__redditpPresentation.debug.snapshot().index;
      return { children: box.children.length, index };
    });
    expect(stage.children).toBe(1);
    expect(stage.index).toBe(8);
    // In-flight work stays within the concurrency budget; a canceled or
    // superseded job never left a phantom entry.
    const stats = await page.evaluate(() =>
      window.__redditpPresentation.debug.stats(),
    );
    expect(stats.inFlight).toBeLessThanOrEqual(3);
  });

  test("a hung image preload times out, retries in a bounded way, and frees its slot", async ({
    page,
  }) => {
    // Virtual clock: the watchdogs are production setTimeouts. One
    // forever-hanging image sits one post ahead, inside the preload horizon
    // (the displayed slide's own fetch belongs to the display path); the
    // rest load normally.
    const hang = () => new Promise(() => {});
    await openFeed(
      page,
      `${postHtml("ok1", "Ok 1")}${postHtml(
        "hung",
        "Hung 2",
        "https://i.redd.it/hung.jpg",
      )}${postHtml("ok3", "Ok 3")}${postHtml("ok4", "Ok 4")}`,
      { clock: true, media: { "https://i.redd.it/hung.jpg": hang } },
    );
    await page.clock.runFor(1000);

    // The hung job held a slot, then the watchdog fired: the log says why.
    await page.clock.runFor(31000);
    const timeouts = await debugLog(page, "preload-timeout");
    expect(timeouts.length).toBeGreaterThanOrEqual(1);

    // Bounded retries: after the retry limit the slide is parked and no
    // further work is scheduled for it.
    await page.clock.runFor(95000);
    const stats = await page.evaluate(() =>
      window.__redditpPresentation.debug.stats(),
    );
    // The original attempt plus two retries.
    expect(stats.started).toBeGreaterThanOrEqual(3);
    expect(stats.inFlight).toBeLessThanOrEqual(3);
    const retries = (await debugLog(page, "preload-retry")).filter((entry) =>
      String(entry.detail?.key || "").includes("hung"),
    );
    expect(retries.length).toBe(2);
  });

  test("a displayed image that never settles ends in the failure card, not an eternal loader", async ({
    page,
  }) => {
    const hang = () => new Promise(() => {});
    await openFeed(
      page,
      `${postHtml("stuck", "Stuck 1", "https://i.redd.it/stuck.jpg")}${feedHtml(
        1,
        "Ok",
      ).replaceAll("m1", "ok1")}`,
      { clock: true, media: { "https://i.redd.it/stuck.jpg": hang } },
    );
    await expect(page.locator(".redditp__title")).toHaveText("Stuck 1");

    // One display budget earns a fresh retry; the second ends the wait.
    await page.clock.runFor(62000);
    await expect(
      page.locator(".redditp__link-card", { hasText: "Image unavailable" }),
    ).toBeVisible();
    const events = (await debugLog(page)).map((entry) => entry.event);
    expect(events).toContain("display-timeout");
  });

  test("a slow image that eventually loads replaces the wait state with measured media", async ({
    page,
  }) => {
    const slow = (route) =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            route.fulfill({ contentType: "image/svg+xml", body: svgImage }),
          );
        }, 700);
      });
    await openFeed(page, feedHtml(2), {
      media: { "https://i.redd.it/m1.jpg": slow },
    });
    await expect(page.locator(".redditp__media img")).toBeVisible({
      timeout: 5000,
    });
    const navigation = await page.evaluate(() =>
      window.__redditpPresentation.debug.lastNavigation(),
    );
    // Navigation-to-ready was actually measured, not assumed (the single-slot
    // record keeps `ready` false for a cold fetch; the measured delay is the
    // readiness evidence).
    expect(typeof navigation.readyAfterMs).toBe("number");
    expect(navigation.readyAfterMs).toBeGreaterThanOrEqual(0);
  });
});

test.describe("mobile viewer redesign", () => {
  // Touch-enabled phone-size context. `isMobile` is left off on purpose: its
  // visual-viewport scaling makes geometry assertions read device pixels,
  // while the viewer itself is viewport-meta independent.
  test.use({
    viewport: { width: 393, height: 851 },
    hasTouch: true,
  });

  test("settings opens as a bottom sheet docked to the bottom edge", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(3));
    await page.locator(".redditp__settings-button").click();
    const sheet = await page.locator(".redditp__settings").evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return {
        bottom: box.bottom,
        width: box.width,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        radiusTop: parseFloat(style.borderTopLeftRadius),
        radiusBottom: parseFloat(style.borderBottomLeftRadius),
      };
    });
    expect(sheet.bottom).toBeCloseTo(sheet.viewportHeight, 0);
    expect(sheet.width).toBeCloseTo(sheet.viewportWidth, 0);
    expect(sheet.radiusTop).toBeGreaterThan(0);
    expect(sheet.radiusBottom).toBe(0);
    // The sheet keeps its own scroll: every setting stays reachable.
    const settings = page.locator(".redditp__setting");
    expect(await settings.count()).toBeGreaterThanOrEqual(6);
  });

  test("the active numbered chip is centered and the count stays visible", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(30));
    await page.locator(".redditp__number").nth(14).click();
    await expect(page.locator(".redditp__count")).toHaveText("15 / 30");
    await expect(page.locator(".redditp__title")).toHaveText("Post 15");
    // Smooth centering is asynchronous: wait for the track to settle (two
    // equal consecutive scrollLeft readings).
    await page.waitForFunction(() => {
      const bar = document.querySelector(".redditp__numbers");
      if (window.__mark === undefined) {
        window.__mark = bar.scrollLeft;
        return false;
      }
      const settled = window.__mark === bar.scrollLeft;
      window.__mark = bar.scrollLeft;
      return settled;
    });
    const geometry = await page.evaluate(() => {
      const bar = document.querySelector(".redditp__numbers");
      const active = bar.querySelector(".redditp__number--active");
      const a = active.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const count = document.querySelector(".redditp__count");
      return {
        activeCenterOffset: a.left + a.width / 2 - (b.left + b.width / 2),
        fullyVisible: a.left >= b.left - 0.5 && a.right <= b.right + 0.5,
        countText: count.textContent,
        countVisible: !!(count.offsetWidth || count.offsetHeight),
        touchAction: getComputedStyle(bar).touchAction,
      };
    });
    // The chip is centered (within half a chip of the track's center) and
    // never clipped at either edge.
    expect(Math.abs(geometry.activeCenterOffset)).toBeLessThanOrEqual(18);
    expect(geometry.fullyVisible).toBe(true);
    expect(geometry.countText).toBe("15 / 30");
    expect(geometry.countVisible).toBe(true);
    // The strip owns horizontal panning: native touch scrolling is allowed.
    expect(geometry.touchAction).toBe("pan-x");
  });

  test("a drag gesture born in the bottom bar never navigates media", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(30));
    await expect(page.locator(".redditp__title")).toHaveText("Post 1");
    // Start the drag on a numbered chip (an interactive part of the row):
    // the gesture belongs to the row, and the media swipe handler must stay
    // out of it. A mouse drag does not natively scroll the strip; the
    // assertion is that navigation never fires.
    const chip = page.locator(".redditp__number").nth(8);
    const box = await chip.boundingBox();
    const startY = box.y + box.height / 2;
    const startX = box.x + box.width / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 120, startY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await page.locator(".redditp__title").textContent()).toBe("Post 1");
    expect(await page.locator(".redditp__count").textContent()).toBe("1 / 30");
  });

  test("tap zones keep their semantics next to the redesigned bottom bar", async ({
    page,
  }) => {
    await openFeed(page, feedHtml(4));
    const size = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    // Tap right third: next post.
    await page.touchscreen.tap(size.width - 40, size.height / 2);
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
    // Tap left third: previous post.
    await page.touchscreen.tap(40, size.height / 2);
    await expect(page.locator(".redditp__title")).toHaveText("Post 1");
    // Tapping a number chip jumps without double-firing a media gesture.
    await page.locator(".redditp__number").nth(2).click();
    await expect(page.locator(".redditp__title")).toHaveText("Post 3");
    await expect(page.locator(".redditp__count")).toHaveText("3 / 4");
  });

  test("the title shares one row with the chips and truncates at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openFeed(page, feedHtml(3, "A very long titled post"));
    const layout = await page.evaluate(() => {
      const title = document.querySelector(".redditp__title");
      const style = getComputedStyle(title);
      const box = title.getBoundingClientRect();
      const chips = [
        ...document.querySelectorAll(
          "#redditp-presentation .redditp__control-item, #redditp-presentation .redditp__close",
        ),
      ].filter((chip) => !chip.hidden);
      const chipBoxes = chips.map((chip) => chip.getBoundingClientRect());
      const details = document
        .querySelector(".redditp__details")
        .getBoundingClientRect();
      return {
        lineHeight: parseFloat(style.lineHeight),
        height: box.height,
        clamp: style.webkitLineClamp,
        details,
        chipsLeft: Math.min(...chipBoxes.map((b) => b.left)),
        chipsTop: Math.min(...chipBoxes.map((b) => b.top)),
        chipsBottom: Math.max(...chipBoxes.map((b) => b.bottom)),
      };
    });
    // One ellipsized line: the title no longer wraps under the chips.
    expect(layout.clamp).toBe("1");
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight + 1);
    // Single-row header: the title panel sits in the chips' vertical band,
    // ends before the first chip, and shares no pixel with any chip box.
    expect(layout.details.top).toBeLessThanOrEqual(layout.chipsBottom - 1);
    expect(layout.details.bottom).toBeGreaterThanOrEqual(layout.chipsTop + 1);
    expect(layout.details.right).toBeLessThanOrEqual(layout.chipsLeft + 0.5);
  });
});

test.describe("landscape phones keep the touch-sized top bar", () => {
  test("landscape phone gets the mobile control set with tighter overlays", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.route("https://www.reddit.com/r/pics/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: Array.from(
          { length: 4 },
          (_, i) =>
            `<div class="thing link" data-fullname="t3_l${i}" data-url="https://i.redd.it/l${i}.jpg" data-permalink="/r/pics/comments/l${i}/post/" data-author="p1" data-subreddit="pics"><a class="title">Post ${i + 1}</a></div>`
        ).join(""),
      })
    );
    await page.route("https://i.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      })
    );
    await page.goto("https://www.reddit.com/r/pics/");
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await expect(page.locator("#redditp-presentation")).toBeVisible();
    await page.keyboard.press("a");
    const layout = await page.evaluate(() => {
      const chip = document.querySelector(".redditp__settings-button");
      const details = document.querySelector(".redditp__details");
      const chips = [
        ...document.querySelectorAll(
          "#redditp-presentation .redditp__control-item, #redditp-presentation .redditp__close",
        ),
      ].filter((el) => !el.hidden);
      const chipBoxes = chips.map((el) => el.getBoundingClientRect());
      const detailsBox = details
        ? details.getBoundingClientRect()
        : null;
      return {
        chipWidth: chip ? chip.getBoundingClientRect().width : null,
        detailsMaxHeight: details
          ? parseFloat(getComputedStyle(details).maxHeight)
          : null,
        detailsRight: detailsBox ? detailsBox.right : null,
        chipsLeft: Math.min(...chipBoxes.map((b) => b.left)),
        chipsTop: Math.min(...chipBoxes.map((b) => b.top)),
        detailsTop: detailsBox ? detailsBox.top : null,
      };
    });
    // The mobile block's 40px touch chips apply in landscape (the desktop
    // 34px chips would be the fallback), the title panel caps at 38dvh, and
    // title plus chips still share one row with no overlap.
    expect(layout.chipWidth).toBeCloseTo(40, 0);
    expect(layout.detailsMaxHeight).toBeCloseTo(0.38 * 390, 0);
    // Same flex row: the title panel starts on the chips' band (a stacked
    // header would push it below the whole chip row).
    expect(Math.abs(layout.detailsTop - layout.chipsTop)).toBeLessThanOrEqual(
      10,
    );
    expect(layout.detailsRight).toBeLessThanOrEqual(layout.chipsLeft + 0.5);
  });
});
