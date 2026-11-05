const path = require("path");
const fs = require("fs");
const { test, expect } = require("@playwright/test");

// Regression coverage for the independent audit fixes:
//   1. slideshow stall when the first listing holds a single post
//      (appendNewPosts never re-armed a stopped auto timer),
//   2. settings-close / initial focus landing on hidden buttons,
//   3. the numbered bar's O(posts) rebuild on every render was replaced by
//      an identity-sequence signature (navigation-only renders flip the
//      active mark instead of recreating every button).

const extensionScript = path.resolve(
  __dirname,
  "../../browser-extension/content.js",
);
const extensionStyles = path.resolve(
  __dirname,
  "../../browser-extension/presentation.css",
);

const listing = "https://www.reddit.com/r/audit-fixes/?redditp=audit-fixes";

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/audit-fixes/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">${title}</a></div>`;

// Posts to inject into the live document, standing in for Reddit's lazy
// listing appends that pagination sessions see in the field.
const appendPosts = (count, idPrefix, firstNumber) =>
  Array.from({ length: count }, (_, i) =>
    imagePost(`${idPrefix}${firstNumber + i}`, `Post ${firstNumber + i}`),
  ).join("");

async function openFeed(page, { seed = {}, pinAuto = false } = {}) {
  const posts = Array.from({ length: 30 }, (_, i) =>
    imagePost(`f${i + 1}`, `Post ${i + 1}`),
  ).join("");
  await page.route(listing, (route) =>
    route.fulfill({ contentType: "text/html", body: posts }),
  );
  await page.route("https://i.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  await page.goto(listing);
  await page.evaluate((seedValue) => {
    localStorage.removeItem("redditpPresentationSettings");
    localStorage.setItem(
      "redditpPresentationSettings",
      JSON.stringify(seedValue),
    );
  }, seed);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  const auto = page.locator(".redditp__auto");
  if (pinAuto) {
    if ((await auto.getAttribute("aria-pressed")) === "true") {
      await auto.click();
    }
    await expect(auto).toHaveAttribute("aria-pressed", "false");
  } else {
    await expect(auto).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.locator(".redditp__count")).toHaveText("1 / 30");
}

// The numbered-bar system only watches the row content, so the observed
// churn is what the old vs new implementation differs on.
async function installNumberBarObserver(page) {
  return page.evaluate(() => {
    window.__numberBarChurn = 0;
    const bar = document.querySelector(".redditp__numbers");
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.classList?.contains("redditp__number")) {
            window.__numberBarChurn += 1;
          }
        }
      }
    }).observe(bar, { childList: true });
    return true;
  });
}

test.describe("audit regression fixes", () => {
  test("slideshow starts moving after posts append to a single-post listing", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-01-01T09:00:00Z") });
    const posts = [imagePost("solo", "Post 1")].join("");
    await page.route(listing, (route) =>
      route.fulfill({ contentType: "text/html", body: posts }),
    );
    await page.route("https://i.redd.it/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
      }),
    );
    await page.goto(listing);
    await page.evaluate(() => {
      localStorage.removeItem("redditpPresentationSettings");
      localStorage.setItem(
        "redditpPresentationSettings",
        JSON.stringify({ autoAdvance: true, slideDurationSeconds: 1 }),
      );
    });
    await page.addStyleTag({ path: extensionStyles });
    await page.addScriptTag({ path: extensionScript });
    await expect(page.locator(".redditp__title")).toHaveText("Post 1");
    await expect(page.locator(".redditp__auto")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // With one slide the length guard keeps the timer off, which is correct
    // while there is nothing to advance to; it must not trap the slideshow
    // forever.
    await page.evaluate(
      (html) => {
        document.body.insertAdjacentHTML("beforeend", html);
      },
      appendPosts(24, "later", 2),
    );

    // The passive loader's scroll probes pick the appended posts up on its
    // next virtual wait; the appended batch then lifts the length guard and
    // the timer starts advancing on its own.
    await page.clock.runFor(1500);
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
    await expect(page.locator(".redditp__count")).toHaveText("2 / 25");
  });

  test("plain navigation does not recreate the numbered bar", async ({
    page,
  }) => {
    await openFeed(page);
    await installNumberBarObserver(page);

    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator(".redditp__title")).toHaveText("Post 6");
    await expect(page.locator(".redditp__count")).toHaveText("6 / 30");
    await expect(page.locator(".redditp__number")).toHaveCount(30);
    expect(await page.evaluate(() => window.__numberBarChurn)).toBe(0);
    await expect(page.locator(".redditp__number--active")).toHaveText("6");

    // The identity sequence changing (batch appended) is exactly the
    // case the rebuild must still cover.
    await page.locator(".redditp__number").nth(29).click();
    await expect(page.locator(".redditp__title")).toHaveText("Post 30");
    await installNumberBarObserver(page);
    await page.evaluate(
      (html) => {
        document.body.insertAdjacentHTML("beforeend", html);
      },
      appendPosts(25, "later2", 31),
    );
    await expect(page.locator(".redditp__count")).toHaveText("30 / 55");
    await expect(page.locator(".redditp__number")).toHaveCount(55);
    expect(await page.evaluate(() => window.__numberBarChurn)).toBeGreaterThan(
      0,
    );

    // Numbered navigation between appended and reloaded content keeps
    // working with the (reused or rebuilt) buttons.
    await page.locator(".redditp__number").nth(1).click();
    await expect(page.locator(".redditp__title")).toHaveText("Post 2");
  });

  test("closing settings focuses a visible control when the bottom panel is off", async ({
    page,
  }) => {
    await openFeed(page);
    await page
      .getByRole("button", { name: "Open presentation settings" })
      .click();
    await page.getByLabel("Show the bottom panel").uncheck();
    await page
      .getByRole("button", { name: "Close presentation settings" })
      .click();
    await expect(
      page.getByRole("button", { name: "Open presentation settings" }),
    ).toBeHidden();
    // With the settings chip hidden, focus falls back to the close chip
    // instead of dropping to <body>.
    await expect(page.locator(".redditp__close")).toBeFocused();
  });

  test("initial focus lands on settings when the close chip is disabled", async ({
    page,
  }) => {
    await openFeed(page, { seed: { showClose: false } });
    // closeButton.hidden with showControls on: settings chip takes focus.
    await expect(
      page.getByRole("button", { name: "Open presentation settings" }),
    ).toBeFocused();
  });
});
