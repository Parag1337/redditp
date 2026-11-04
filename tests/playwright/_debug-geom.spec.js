const { test, expect } = require("@playwright/test");
const path = require("path");

const extensionStyles = path.resolve(__dirname, "../../browser-extension/presentation.css");
const extensionScript = path.resolve(__dirname, "../../browser-extension/content.js");

test("debug test758 overlap", async ({ page }) => {
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
  await page.setContent(`<base href="https://www.reddit.com/">${galleryPost("one")}`);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  await page.keyboard.press("a");

  const overlapAt = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    return page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll("#redditp-presentation .redditp__control-item"),
      ).filter((button) => !button.hidden);
      const buttonBoxes = buttons.map((button) => {
        const r = button.getBoundingClientRect();
        const cs = getComputedStyle(button);
        return {
          cls: String(button.className),
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          pos: cs.position,
          pe: cs.pointerEvents,
        };
      });
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".redditp__title"));
      const lines = Array.from(range.getClientRects()).map((r) => ({
        x: r.x, y: r.y, w: r.width, h: r.height,
      }));
      const overlap = [];
      lines.forEach((line) =>
        buttonBoxes.forEach((b) => {
          if (
            line.x < b.rect.x + b.rect.w &&
            line.x + line.w > b.rect.x &&
            line.y < b.rect.y + b.rect.h &&
            line.y + line.h > b.rect.y
          )
            overlap.push({ line, button: b });
        }),
      );
      return { buttons: buttonBoxes, lines: lines.slice(0, 20), overlap };
    });
  };

  const info = await overlapAt(360, 780);
  console.log(JSON.stringify(info, null, 2));
  expect(info.overlap).toEqual([]); // will fail; we're dumping diagnostics
});
