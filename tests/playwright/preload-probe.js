// Phase 7 measurement probe (investigation phases A–D).
//
// Standalone Playwright probe — NOT part of any test suite and never loaded
// by playwright.config. It drives the production extension script against
// deterministic routed fixtures and measures, per navigation, the time from
// the navigation action (keydown dispatch) to the first visible frame of
// the destination media:
//   - images: img.decode() completion (a real decode)
//   - real-byte videos (direct-MP4-style, preview-MP4-style, RedGIFs):
//     a real decode → first presented frame via requestVideoFrameCallback(),
//     falling back to readyState >= HAVE_CURRENT_DATA when rVCF is absent
//   - DASH: a logic-level dash.js STUB that simulates only the bridge
//     protocol timing (attach, manifest delay, init-segment delay). It
//     cannot prove anything about real dash.js buffering performance, so
//     its rows are labeled with the stub's timing knobs.
//
// Usage: node tests/playwright/preload-probe.js [output.json]
// Env: PROBE_SCENARIOS=warm,rapid-1000 (comma list; default: images only)
//
// IMPORTANT SAFETY NOTE (Phase 7, this machine): standalone-probe runs that
// decode video repeatedly coincided with whole-system instability here, so
// the default is strictly the images-only scenario, which ran stable in
// every attempt. Video scenarios remain selectable by name for machines
// that handle headless video decode safely, but video measurement on this
// system belongs in the regular Playwright spec harness instead (see
// tests/playwright/preload-benchmarks.spec.js).
const path = require("path");
const fs = require("fs");
const { chromium } = require("@playwright/test");

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

const listingUrl = "https://www.reddit.com/r/preloadprobe/?redditp=probe";
const redgifsUrl = "https://www.reddit.com/r/preloadproberg/?redditp=probe";
const imagesUrl = "https://www.reddit.com/r/preloadprobeimg/?redditp=probe";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- fixtures

const imagePost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://i.redd.it/${id}.jpg" data-permalink="/r/preloadprobe/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">Image ${id}</a></div>`;

const directVideoPost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}/DASH_480.mp4" data-permalink="/r/preloadprobe/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">Direct video ${id}</a></div>`;

const previewVideoPost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://preview.redd.it/${id}.mp4?format=mp4" data-permalink="/r/preloadprobe/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">Preview video ${id}</a></div>`;

const dashPost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://v.redd.it/${id}" data-permalink="/r/preloadprobe/comments/${id}/post/" data-author="p1" data-subreddit="videos"><a class="title">DASH video ${id}</a><div class="portrait" data-hls-url="https://v.redd.it/${id}/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/${id}/DASHPlaylist.mpd" data-seek-preview-url="https://v.redd.it/${id}/DASH_96.mp4"></div></div>`;

// One cycle of six slides: image, direct video, image, DASH, image,
// preview video; repeated once so every cadence has material
// (12 posts, 2 direct videos, 2 preview videos, 2 DASH).
const listingBody = `<html><body>${[
  imagePost("imga"),
  directVideoPost("dva"),
  imagePost("imgaa"),
  dashPost("dasha"),
  imagePost("imgaaa"),
  previewVideoPost("pva"),
  imagePost("imgb"),
  directVideoPost("dvb"),
  imagePost("imgbb"),
  dashPost("dashb"),
  imagePost("imgbbb"),
  previewVideoPost("pvb"),
].join("")}</body></html>`;

const redgifsPost = (id) =>
  `<div class="thing link" data-fullname="t3_${id}" data-url="https://www.redgifs.com/watch/${id}" data-permalink="/r/preloadproberg/comments/${id}/post/" data-author="p1" data-subreddit="pics"><a class="title">RedGIFs ${id}</a></div>`;

const redgifsBody = `<html><body>${[
  redgifsPost("rgone"),
  redgifsPost("rgtwo"),
  redgifsPost("rgthree"),
  redgifsPost("rgfour"),
].join("")}</body></html>`;

// Images-only feed: the lowest-load scenario, used first to prove the
// harness itself is safe before any video decode happens.
const imagesBody = `<html><body>${[
  "i1",
  "i2",
  "i3",
  "i4",
  "i5",
  "i6",
  "i7",
  "i8",
  "i9",
  "i10",
  "i11",
  "i12",
]
  .map((id) => imagePost(`img-${id}`))
  .join("")}</body></html>`;

// Delayed media delivery: each route handler records every request it sees
// (host, path, milliseconds since scenario start) and then waits before
// fulfilling, so duplicate requests, ordering, and concurrency are
// observable from the report's network log.
function installMediaRoutes(page, options = {}) {
  const log = [];
  const t0 = Date.now();
  const imageMs = options.imageMs || 80;
  const videoMs = options.videoMs || 150;
  const record = (url, host) => log.push({ t: Date.now() - t0, url, host });
  // The feed listings themselves, served instead of the real Reddit pages
  // (media routes only cover the media hosts; each listing must be routed
  // so page.goto never reaches the live web).
  const feedBodies = [
    [listingUrl, listingBody],
    [imagesUrl, imagesBody],
    [redgifsUrl, redgifsBody],
  ];
  for (const [feedUrl, body] of feedBodies) {
    page.route(
      new RegExp(`^${feedUrl.replace(/[.?]/g, "\\$&")}$`),
      async (route) => {
        record(route.request().url(), "listing");
        await route.fulfill({ status: 200, contentType: "text/html", body });
      },
    );
  }
  page.route("https://i.redd.it/**", async (route) => {
    record(route.request().url(), "i.redd.it");
    await wait(imageMs);
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    });
  });
  for (const pattern of [
    "https://v.redd.it/**",
    "https://preview.redd.it/**",
  ]) {
    page.route(pattern, async (route) => {
      record(route.request().url(), new URL(route.request().url()).host);
      await wait(videoMs);
      await route.fulfill({
        status: 200,
        contentType: "video/webm",
        body: webm,
      });
    });
  }
  let tokenServed = false;
  page.route("https://api.redgifs.com/**", async (route) => {
    const url = route.request().url();
    record(url, "api.redgifs.com");
    if (url.includes("/v2/auth/temporary")) {
      tokenServed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "fixture-token" }),
      });
      return;
    }
    if (!tokenServed) {
      await route.fulfill({ status: 401, body: "no token" });
      return;
    }
    const id = decodeURIComponent(url.split("/v2/gifs/")[1] || "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        gif: {
          urls: { hd: `https://media.redgifs.com/${id}-hd.mp4` },
          duration: 6,
          html: `https://www.redgifs.com/ifr/${id}`,
        },
      }),
    });
  });
  page.route("https://media.redgifs.com/**", async (route) => {
    record(route.request().url(), "media.redgifs.com");
    await wait(videoMs);
    await route.fulfill({ status: 200, contentType: "video/webm", body: webm });
  });
  return log;
}

// The DASH STUB: synchronous attach (exactly the bridge contract), then
// artificial manifest/init delays before it fakes metadata/data events.
async function installDashStub(page, { manifestMs = 400, initMs = 350 } = {}) {
  await page.evaluate(
    ([manifestDelay, initDelay]) => {
      window.__dashCalls = [];
      window.__dashResets = 0;
      const MediaPlayer = () => ({
        create() {
          return {
            on() {},
            initialize(video, url) {
              window.__dashCalls.push({ url });
              setTimeout(() => {
                video.dispatchEvent(new Event("loadedmetadata"));
                Object.defineProperty(video, "duration", {
                  configurable: true,
                  value: 12,
                });
                setTimeout(
                  () => video.dispatchEvent(new Event("loadeddata")),
                  initDelay,
                );
              }, manifestDelay);
            },
            reset() {
              window.__dashResets += 1;
            },
          };
        },
      });
      MediaPlayer.events = { ERROR: "error" };
      window.dashjs = { MediaPlayer };
    },
    [manifestMs, initMs],
  );
}

async function boot(page, url) {
  probeProgress(`[boot] goto ${url || listingUrl}\n`);
  await page.goto(url || listingUrl);
  probeProgress("[boot] storage\n");
  await page.evaluate(() => {
    localStorage.setItem("redditpDebug", "1");
    localStorage.removeItem("redditpPresentationSettings");
  });
  probeProgress("[boot] dash stub\n");
  await installDashStub(page);
  probeProgress("[boot] styles\n");
  await page.addStyleTag({ path: extensionStyles });
  probeProgress("[boot] content script\n");
  await page.addScriptTag({ path: extensionScript });
  probeProgress("[boot] manual mode\n");
  await page.evaluate(() => {
    const auto = document.querySelector(".redditp__auto");
    if (auto.getAttribute("aria-pressed") === "true") auto.click();
  });
  probeProgress("[boot] waiting first media\n");
  await page.waitForSelector(".redditp__media > *");
  probeProgress("[boot] done\n");
}

// Page-side failure capture: a thrown error during open()/render() or a
// doomed fetch would otherwise only show as a boot-timeout.
function installPageFailureLoggers(page, name) {
  page.on("pageerror", (error) =>
    probeProgress(`[pageerror:${name}] ${error}\n`),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      probeProgress(`[console:${name}] ${message.type()}: ${message.text()}\n`);
    }
  });
  page.on("requestfailed", (request) =>
    probeProgress(
      `[requestfailed:${name}] ${request.failure()?.errorText} ${request.url()}\n`,
    ),
  );
}

// ------------------------------------------------------- in-page measurement

// Marks the navigation action time and dispatches the key as a real event.
const navScript = (dir) => `
  window.__navMark = performance.now();
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ${JSON.stringify(dir)},
      bubbles: true,
      cancelable: true,
    }),
  );
`;

// Waits for the destination's first visible frame. Measured from the
// __navMark set by navScript.
const waitReadyImpl = ([timeout, realFrameExpected]) =>
  new Promise((resolve) => {
    const start = performance.now();
    const navKey = window.__navMark || start;
    const detail = {
      navToFirstFrameMs: null,
      source: "",
      rvcfSupported:
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
        "function",
    };
    const timer = setTimeout(() => finish("timeout"), timeout);
    // A render can replace the media element while we wait; the poll loop
    // keeps re-querying (and re-arming per element) so a discarded element
    // can never strand the wait.
    const armed = new WeakSet();
    function finish(source) {
      if (detail.navToFirstFrameMs === null && source) {
        detail.navToFirstFrameMs = Math.max(0, performance.now() - navKey);
        detail.source = source;
      }
      clearTimeout(timer);
      resolve(detail);
    }
    function presentVideo(video) {
      if (armed.has(video)) return;
      armed.add(video);
      if (
        HTMLVideoElement.prototype.requestVideoFrameCallback &&
        realFrameExpected
      ) {
        video.requestVideoFrameCallback(() => finish("video-frame-callback"));
      } else if (video.readyState >= 2) {
        finish("readyState-have-current-data");
      }
    }
    function settleImage(img) {
      const tryDecode = () =>
        typeof img.decode === "function"
          ? img
              .decode()
              .then(() => finish("image-decode"))
              .catch(() => finish("image-loaded"))
          : finish("image-loaded");
      if (img.complete && img.naturalWidth) tryDecode();
      else {
        img.addEventListener("load", tryDecode, { once: true });
        img.addEventListener("error", () => finish("image-error"), {
          once: true,
        });
      }
    }
    function poll() {
      const box = document.querySelector(".redditp__media");
      if (!box) {
        if (performance.now() - start > timeout) return finish("no-media-box");
        return setTimeout(poll, 25);
      }
      const card = box.querySelector(".redditp__link-card");
      if (card) return finish("failure-card");
      const video = box.querySelector("video");
      if (video) {
        if (video.error) return finish("video-error");
        if (
          realFrameExpected &&
          HTMLVideoElement.prototype.requestVideoFrameCallback
        ) {
          // Arm each element once; rVCF fires for a real presented frame.
          // If the render replaces the element, the next poll arms the
          // new one, so no replacement can strand the wait.
          presentVideo(video);
        } else if (video.readyState >= 2) {
          return finish("readyState-have-current-data");
        }
        setTimeout(poll, 25);
        return;
      }
      const img = box.querySelector("img");
      if (img) return settleImage(img);
      if (performance.now() - start > timeout)
        return finish("no-media-timeout");
      setTimeout(poll, 25);
    }
    poll();
  });

// Progress is written synchronously to stdout AND to a breadcrumb file so
// a hard crash or hang still shows exactly which step the system died on.
let probeScenarioWord = "";
const breadcrumbPath = "/tmp/opencode/probe-progress.log";
function probeProgress(line) {
  try {
    fs.writeSync(1, line);
  } catch (_writeError) {
    // Progress logging must never break the probe.
  }
  try {
    fs.appendFileSync(breadcrumbPath, `${new Date().toISOString()} ${line}`);
  } catch (_writeError) {
    // Ditto.
  }
}

// One navigation step: mark time, dispatch, wait for readiness, return the
// result plus the extension's own diagnostic context.
async function navStep(
  page,
  { dir = "ArrowRight", timeout = 9000, realFrames = true } = {},
) {
  await page.evaluate(navScript(dir));
  const detail = await page.evaluate(waitReadyImpl, [timeout, realFrames]);
  const navigation = await page.evaluate(() =>
    window.__redditpPresentation.debug.lastNavigation(),
  );
  const stats = await page.evaluate(() =>
    window.__redditpPresentation.debug.stats(),
  );
  const step = {
    index: navigation?.index ?? null,
    kind: navigation?.kind ?? "",
    reuse: navigation?.reuse || "cold",
    readyAfterMs: navigation?.readyAfterMs ?? null,
    navToFirstFrameMs:
      detail.navToFirstFrameMs === null
        ? null
        : Math.round(detail.navToFirstFrameMs),
    firstFrameSource: detail.source,
    rvcfSupported: detail.rvcfSupported,
    cacheSize: stats.cacheSize,
    inFlight: stats.inFlight,
  };
  probeProgress(
    `[${probeScenarioWord}] slide ${step.index} ${step.kind} ` +
      `reuse=${step.reuse} navToFirstFrame=${step.navToFirstFrameMs}ms ` +
      `(${step.firstFrameSource}) cache=${step.cacheSize}\n`,
  );
  return step;
}

// Like navStep, with an unmeasured settle pause after readiness (the pause
// gives the preload queue time to finish — the "patient user" condition).
async function navStepSettled(page, settleMs, opts) {
  const step = await navStep(page, opts);
  await wait(settleMs);
  return step;
}

// Rapid cadence: navigate every `cadenceMs` regardless of readiness.
async function rapid(page, count, cadenceMs) {
  const steps = [await navStepSettled(page, 2500)];
  for (let i = 0; i < count; i += 1) {
    const startedAt = Date.now();
    const step = await navStep(page);
    const elapsed = Date.now() - startedAt;
    if (elapsed < cadenceMs) await wait(cadenceMs - elapsed);
    steps.push({ cadenceMs, ...step });
  }
  return steps;
}

// ---------------------------------------------------------------- scenarios

const SCENARIOS = {
  // Images-only feed, the canary scenario: proves the harness is safe
  // before any video decode happens and measures the image pipeline
  // (Phase B) directly.
  async images(page) {
    await boot(page, imagesUrl);
    const steps = [await navStepSettled(page, 2500)];
    for (let i = 1; i < 8; i += 1) {
      steps.push(await navStepSettled(page, 2500));
    }
    return steps;
  },
  // Warm path: one slide every 2.5s so the preload queue settles between
  // steps. The "patient user" baseline.
  async warm(page) {
    const steps = [await navStepSettled(page, 2500)];
    for (let i = 1; i < 8; i += 1) {
      steps.push(await navStepSettled(page, 2500));
    }
    return steps;
  },
  async "rapid-2000"(page) {
    return rapid(page, 8, 2000);
  },
  async "rapid-1000"(page) {
    return rapid(page, 8, 1000);
  },
  async "rapid-500"(page) {
    return rapid(page, 10, 500);
  },
  async "rapid-250"(page) {
    return rapid(page, 10, 250);
  },
  // Forward then immediately backward, 1.4s between presses.
  async reversal(page) {
    const steps = [await navStepSettled(page, 2000)];
    for (let i = 0; i < 4; i += 1) {
      steps.push({ dir: "forward", ...(await navStepSettled(page, 1400)) });
    }
    for (let i = 0; i < 4; i += 1) {
      const back = await navStep(page, { dir: "ArrowLeft" });
      await wait(1400);
      steps.push({ dir: "backward", ...back });
    }
    return steps;
  },
  // RedGIFs feed on its own listing: metadata resolution + direct-media
  // preparation + display reuse.
  async redgifs(page) {
    await boot(page, redgifsUrl);
    const steps = [await navStepSettled(page, 2500)];
    for (let i = 1; i < 4; i += 1) {
      steps.push(await navStepSettled(page, 2500));
    }
    return steps;
  },
};

// ---------------------------------------------------------------- main loop

(async () => {
  const outPath =
    process.argv[2] ||
    path.join("/tmp/opencode", `preload-probe-${Date.now()}.json`);
  // Safe-by-default order: the images-only canary first, then the mixed
  // feeds from the lightest to the heaviest cadence. PROBE_SCENARIOS can
  // still select an exact list.
  const safeOrder = [
    "images",
    "warm",
    "rapid-2000",
    "rapid-1000",
    "rapid-500",
    "rapid-250",
    "reversal",
    "redgifs",
  ];
  const requested = (process.env.PROBE_SCENARIOS || "images")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const chosen =
    requested.includes("all") || requested[0] === "all" ? safeOrder : requested;

  const report = {};
  // One fresh browser per scenario: a decoder or memory blow-up in one
  // scenario can never poison the measurements (or the system) of the
  // next. Software rendering and hardware video decode are disabled so
  // nothing touches the GPU driver stack (the suspected crash trigger).
  for (const name of chosen) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario: ${name}`);
    probeScenarioWord = name;
    probeProgress(`=== scenario ${name}: booting fresh browser ===\n`);
    let browser;
    try {
      browser = await chromium.launch({
        args: [
          "--disable-gpu",
          "--disable-gpu-compositing",
          "--disable-accelerated-video-decode",
          "--disable-dev-shm-usage",
        ],
      });
      const page = await browser.newPage();
      installPageFailureLoggers(page, name);
      const networkLog = installMediaRoutes(page);
      const t0 = Date.now();
      await boot(page);
      if (process.env.PROBE_BOOT_ONLY) {
        // Boot-only diagnostic mode: stop before any navigation.
        report[name] = { bootOnly: true, wallMs: Date.now() - t0 };
        continue;
      }
      const steps = await scenario(page);
      const stats = await page.evaluate(() =>
        window.__redditpPresentation.debug.stats(),
      );
      const dashCalls = await page.evaluate(() => window.__dashCalls || []);
      // KEEP the debug log capture for the report (bounded ring buffer).
      const debugLog = await page.evaluate(() =>
        window.__redditpPresentation.debug.log(),
      );
      report[name] = {
        wallMs: Date.now() - t0,
        stats,
        steps,
        requests: networkLog,
        dashCalls,
        // Debug log is capped at 200 entries by content.js.
        debugLog,
      };
    } catch (error) {
      probeProgress(`!!! scenario ${name} FAILED: ${error}\n`);
      report[name] = { error: String(error) };
    } finally {
      if (browser) await browser.close().catch(() => {});
      probeProgress(`=== scenario ${name}: browser closed ===\n`);
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  probeProgress(`wrote ${outPath}\n`);
})();
