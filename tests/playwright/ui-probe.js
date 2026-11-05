// Standalone UI/UX probe (not part of the test suite): renders a feed with
// the real content.js + presentation.css at the requested viewports and
// records control geometry, overlap checks, media fitting, and screenshots.
const path = require("path");
const fs = require("fs");
const { chromium, firefox } = require("@playwright/test");

const extensionScript = path.resolve(__dirname, "../../browser-extension/content.js");
const extensionStyles = path.resolve(__dirname, "../../browser-extension/presentation.css");

const VIEWPORTS = [
  [320, 640],
  [360, 800],
  [375, 667],
  [390, 844],
  [393, 852],
  [412, 915],
  [700, 800],
  [1280, 800],
  [1920, 1080],
];

const imagePost = (id, title) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="shooter" data-subreddit="pics"><a class="title" href="https://i.redd.it/${id}.jpg">${title}</a></div>`;

const galleryCard = (title) =>
  `<shreddit-post id="t3_gal" post-title="${title}" gallery post-type="gallery" content-href="https://www.reddit.com/gallery/gal" permalink="https://www.reddit.com/r/pics/comments/gal/post/" subreddit-prefixed-name="r/pics"><gallery-carousel><figure><img alt="g" src="https://i.redd.it/album-1.jpg"></figure><figure><img alt="g" src="https://i.redd.it/album-2.jpg"></figure><figure><img alt="g" src="https://i.redd.it/album-3.jpg"></figure></gallery-carousel></shreddit-post>`;

const longTitlePost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/pics/comments/${id}/post/" data-author="shooter" data-subreddit="pics"><a class="title" href="https://i.redd.it/${id}.jpg">A very long descriptive post title that keeps going and going and would certainly wrap across several lines on a narrow phone screen eventually</a></div>`;

const galleryJson = () => {
  const ids = ["g1", "g2", "g3"];
  const metadata = {};
  ids.forEach((mediaId) => {
    metadata[mediaId] = {
      status: "valid",
      e: "Image",
      m: "image/jpg",
      s: { u: `https://preview.redd.it/${mediaId}.jpg` },
      p: [],
    };
  });
  return {
    title: "Gallery post",
    post_hint: "gallery",
    is_gallery: true,
    url: "https://www.reddit.com/gallery/gal",
    gallery_data: { items: ids.map((media_id) => ({ media_id })) },
    media_metadata: metadata,
  };
};

async function openFeed(page, { gallery = false } = {}) {
  await page.route("https://*.redd.it/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  if (gallery) {
    await page.route(
      "https://www.reddit.com/r/pics/comments/gal/post/",
      (route) =>
        route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
    );
    await page.route(
      /comments\/gal\/post\/\.json$/,
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([{ data: { children: [{ kind: "t3", data: galleryJson() }] } }]),
        }),
    );
  }
  const body = [
    imagePost("a1", "Portrait first post"),
    gallery ? galleryCard("Gallery post") : "",
    longTitlePost("a9"),
    ...Array.from({ length: 20 }, (_, i) => imagePost(`b${i + 2}`, `Post ${i + 2}`)),
  ].join("");
  await page.setContent(`<base href="https://www.reddit.com/">${body}`);
  await page.addStyleTag({ path: extensionStyles });
  await page.addScriptTag({ path: extensionScript });
  // manual mode
  const auto = page.locator(".redditp__auto");
  if ((await auto.getAttribute("aria-pressed")) === "true") await auto.click();
}

async function measure(page) {
  return page.evaluate(() => {
    const grab = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const right = +box.right.toFixed(1);
      const left = +box.left.toFixed(1);
      const top = +box.top.toFixed(1);
      const bottom = +box.bottom.toFixed(1);
      return { left, right, top, bottom, width: +(right - left).toFixed(1), height: +(bottom - top).toFixed(1), hidden: !!(el.offsetWidth === 0 && el.offsetHeight === 0) };
    };
    const items = {
      close: grab(".redditp__close"),
      hide: grab(".redditp__hide"),
      fullscreen: grab(".redditp__fullscreen"),
      settings: grab(".redditp__settings-button"),
      rotate: grab(".redditp__rotate"),
      gallery: grab(".redditp__gallery"),
      details: grab(".redditp__details"),
      title: grab(".redditp__title"),
      count: grab(".redditp__count"),
      mode: grab(".redditp__media-mode"),
      numbers: grab(".redditp__numbers"),
      media: grab(".redditp__media"),
      image: grab(".redditp__image"),
      root: grab("#redditp-presentation"),
    };
    // pairwise overlap of visible top-row controls
    const chips = ["close", "hide", "fullscreen", "settings", "rotate", "gallery"]
      .filter((k) => items[k] && !items[k].hidden)
      .map((k) => [k, items[k]]);
    const overlaps = [];
    for (let i = 0; i < chips.length; i += 1) {
      for (let j = i + 1; j < chips.length; j += 1) {
        const a = chips[i][1];
        const b = chips[j][1];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 0 && h > 0) overlaps.push([chips[i][0], chips[j][0], +w.toFixed(1)]);
      }
    }
    // details vs chips overlap
    const details = items.details;
    if (details && !details.hidden) {
      for (const [k, box] of chips) {
        const w = Math.min(details.right, box.right) - Math.max(details.left, box.left);
        const h = Math.min(details.bottom, box.bottom) - Math.max(details.top, box.top);
        if (w > 0 && h > 0) overlaps.push(["details", k, +w.toFixed(1)]);
      }
    }
    return { items, overlaps, vw: window.innerWidth, vh: window.innerHeight };
  });
}

(async () => {
  const browsers = [["chrome", chromium], ["firefox", firefox]];
  const out = {};
  for (const [name, type] of browsers) {
    const browser = await type.launch({ channel: name === "chrome" ? "chrome" : undefined });
    for (const scene of ["plain", "gallery"]) {
      const page = await browser.newPage();
      await openFeed(page, { gallery: scene === "gallery" });
      const key = `${name}-${scene}`;
      out[key] = {};
      for (const [w, h] of VIEWPORTS) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(120);
        const shotDir = path.join(__dirname, "ui-probe-shots");
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: path.join(shotDir, `${key}-${w}x${h}.png`) });
        const m = await measure(page);
        // media-fit checks: image should sit inside the media box and be centered
        const imgFit = page.evaluate(() => {
          const img = document.querySelector(".redditp__image");
          if (!img) return null;
          const b = img.getBoundingClientRect();
          const rootB = document.getElementById("redditp-presentation").getBoundingClientRect();
          return {
            fitsX: b.left >= rootB.left - 1 && b.right <= rootB.right + 1,
            fitsY: b.top >= rootB.top - 1 && b.bottom <= rootB.bottom + 1,
            w: +b.width.toFixed(1),
            h: +b.height.toFixed(1),
          };
        });
        m.imageFit = await imgFit;
        await page.evaluate(() => {
          const el = document.querySelector(".redditp__gallery");
          if (el && !el.hidden) el.click();
        });
        await page.waitForTimeout(120);
        const m2 = await measure(page);
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(120);
        out[key][`${w}x${h}`] = { plain: m, skipGallery: m2 };
      }
      await page.close();
    }
    browser.close();
  }
  fs.writeFileSync(path.join(__dirname, "ui-probe-result.json"), JSON.stringify(out, null, 1));
  // print a compact summary of problems
  for (const [key, byVp] of Object.entries(out)) {
    for (const [vp, data] of Object.entries(byVp)) {
      for (const scene of ["plain", "skipGallery"]) {
        for (const o of data[scene].overlaps) {
          console.log(`${key} ${vp} ${scene}: OVERLAP ${o[0]} vs ${o[1]} width ${o[2]}`);
        }
        const items = data[scene].items;
        if (!items.root) console.log(`${key} ${vp} ${scene}: ROOT MISSING`);
      }
      console.log(
        `${key} ${vp}: detailsW=${data.plain.items.details ? data.plain.items.details.width : "-"} ` +
          `detailsR=${data.plain.items.details ? data.plain.items.details.right : "-"}` +
          ` titleR=${data.plain.items.title ? data.plain.items.title.right : "-"}` +
          ` imgFit=${JSON.stringify(data.plain.imageFit)}`,
      );
    }
  }
})();
