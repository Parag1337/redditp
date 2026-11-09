# RedditPix v1.0.0 — release verification report

_Date of final verification: 2026-11-06. Environment: Linux host machine;
the automated suites run real Mozilla Firefox (Playwright Firefox project) and
Chromium (Playwright Chromium project)._

## 1. Build

- **Command:** `node nodejs/package-extension.js firefox`
- **Output:** `build/RedditPix-v1.0.0-firefox.zip` (289.9 KB on disk →
  296,902 bytes), staged from the single source tree `browser-extension/`
  (current working tree, including uncommitted work; the stale
  `build/redditp-extension-*-v0.5.6.zip` artifacts were ignored, not used).
- **Staged allow-list** (everything the packager copies):
  `manifest.json`, `background.js`, `content.js`, `page-bridge.js`,
  `auto-activate.js`, `presentation.css`, `favicon.png`,
  `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`.

## 2. Add-on identity — independent-fork decision

- **Gecko id: `{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}`** (braced random-UUID).
- The previous Firefox metadata used `presentation-mode@redditp.com` — that id
  still belongs to the upstream RedditP add-on. Confirmed live at the AMO
  public API on 2026-11-06:
  `GET https://addons.mozilla.org/api/v5/addons/addon/presentation-mode@redditp.com/`
  → **HTTP 200**, listing "Presentation Mode for Reddit", v0.5.6, author
  **ubershmekel**. Reusing it would make AMO treat RedditPix as an update to
  that listing, so it is out.
- **Format note:** web-ext/webapi schema rejects a bare-UUID form (`3 errors:
  JSON_INVALID … must match pattern`); the value is shipped with braces, as
  Firefox requires.
- **Availability of the new id:** the AMO public API returns **HTTP 404** for
  `941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2`
  (and for the braced form) — it is not in use by any *listed* add-on. AMO's
  API does not expose unlisted/self-distributed registrations, so the final
  availability confirmation happens at submission time in the Developer Hub.
  Until then, availability is verified only in this limited sense.
- No Chrome identifiers or storage keys were touched.

## 3. Archive integrity (automated)

- `unzip -t`: OK, no errors detected in compressed data.
- 11 entries, no duplicates (`len(set(namelist)) == len(namelist)`), no
  absolute or `..`-containing paths, `manifest.json` at the archive root.
- Full listing:

      background.js, content.js, page-bridge.js, auto-activate.js,
      presentation.css, favicon.png, icon-16.png, icon-32.png,
      icon-48.png, icon-128.png, manifest.json

- No `node_modules`, tests, fixtures, probes, git metadata, logs, or docs
  inside the ZIP. No `.innerHTML =` assignments remain in `content.js`
  (verified programmatically: count 0; `parseHtmlDocument`/`setSvgMarkup`
  present).

## 4. Manifest validation (automated)

Parsed from inside the ZIP:

| Field | Value |
| --- | --- |
| `manifest_version` | 3 |
| `name` | `RedditPix` |
| `version` | `1.0.0` |
| `background` | `{ "scripts": ["background.js"] }` (Firefox MV3 event page) |
| `permissions` | `activeTab`, `scripting`, `storage` |
| `host_permissions` | `https://reddit.com/*`, `https://*.reddit.com/*` |
| `icons` | 16/32/48 → `icon-16/32/48.png`, 128 → `icon-128.png`, 512 → `favicon.png` |
| `gecko` | id `{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}`, `strict_min_version` 140.0, `data_collection_permissions: ["none"]` |
| `gecko_android` | `strict_min_version` 142.0 |

Every referenced file exists in the archive. Icon files verified
dimensionally (PIL): each matches its declared slot (favicon.png is 512×512
RGBA as declared for 512).

## 5. Mozilla validation (automated)

- **Command:** `npx web-ext lint --source-dir build/firefox-extension`
- **Result: 0 errors, 0 notices, 0 warnings.**
- Previous runs reported 6 advisory `UNSAFE_VAR_ASSIGNMENT` warnings for
  dynamic `innerHTML` assignments in `content.js`. All ten such assignment
  sites (the six reported + four identical constructor sites) were converted
  to inert `DOMParser` parsing with `document.importNode`:
  - untrusted Reddit HTML (collapsed-gallery cache, embed `html` attribute) is
    parsed by `parseHtmlDocument()` — DOMParser never runs scripts or loads
    resources, and parsed markup is only queried, never mounted (same
    guarantees as the previous inert `<template>` use);
  - code-owned static SVG icons go through the identical parse path
    (`setSvgMarkup()`).
- Audit verdict per the six reported sites: **none was vulnerable** (two were
  inert parses of untrusted HTML; eight were static constant strings written
  by the code itself). Because no confirmed vulnerability existed, no new
  vulnerability-driven tests were required; the existing 391-test suite
  verifies the converted DOM output matches previous behavior.

## 6. Regression tests (automated)

All suites executed after every change in this release (innerHTML conversion,
new add-on id, instrumentation-test fix):

| Suite | Command | Result | Exit code |
| --- | --- | --- | --- |
| Full Playwright suite (Chromium + Firefox projects, includes the preload benchmark spec under Chromium) | `npx playwright test --workers=1` | **391 passed, 1 skipped, 0 failed** (12.8 min) | 0 |
| Phase 7 preload benchmarks, Firefox engine | `npx playwright test -c tests/playwright/_firefox-bench.config.js` | **10 passed** (1.5 min) | 0 |
| Instrumentation test stability check | `npx playwright test browser-extension.spec.js:7242 --workers=1 --repeat-each=3` (per engine) | 3/3 passed Firefox, 3/3 passed Chromium | 0 |
| Installed-Chrome extra run (legacy `playwright.chrome.config.js`, channel `chrome`) | `npx playwright test -c playwright.chrome.config.js` | **239 passed, 2 failed (4.5 min)**, both failures explained below | 1 |

The single skip is a by-design Chromium-only native-controls test skipped on
the Firefox project.

### 6.1 One test premise was corrected (not weakened)

`phase 5a instrumentation › navigation reuse classification distinguishes
prepared, inflight, and cold video starts` failed deterministically (both
engines, 6/6). Timing evidence (request timestamps vs station markers) showed
its comment miscomputed offsets: with `VIDEO_PRELOAD_WINDOW = 2`, station
"Image 3" is exactly 2 posts before the "cold" video, so the documented,
intended preload design (`offset <= window`) legitimately starts that
speculative fetch ~5 ms before the navigation arrives, making the observed
classification `"inflight"` factually correct. The test now obtains its cold
start the same way a user would see one — a direct numbered-bar jump from
station 0 to the target post (offset 4, outside every station's idle window) —
and gained a stricter assertion: zero plainc requests must exist *before* the
jump. Test strength is unchanged or higher; assertion still requires `"fresh"`
exactly.

### 6.2 Installed-Chrome extra run — the two failures explained

Both failures are unrelated to this release's changes; neither touches shipped
code paths in a way the default-config suites do not already cover:

1. `probe-4b.spec.js › probe bar mechanics` — a committed **diagnostic probe**
   spec that manually launches *both* `chromium` and `firefox` inside one
   test. Under `playwright.chrome.config.js` every launch inherits
   `channel: "chrome"`, and Playwright rejects `firefox.launch()` with that
   channel (`Unsupported firefox channel "chrome"`). Deterministic
   config/probe interaction (2/2 failed); passes under the default config.
   It is not part of the shipped extension.
2. `browser-extension.spec.js › a thumbnail-only search result upgrades again
   after reopening` — the test the earlier phase report already flagged as
   **timing-flaky**. It passed in the full default-config suite on both
   engines the same day, and split 2 passed / 2 failed across
   `--repeat-each=4` under the installed-Chrome config. No code path change in
   this release affects it; it is a pre-existing stability issue to address in
   a test-hardening pass, not a product regression.

Reported exactly as observed: the release-significant suites (rows 1–3) are
fully green on the final code; the legacy Chrome-channel row is included for
transparency.

## 7. Firefox installation

- **Automated:** the Playwright Firefox project loads the extension into real
  Firefox and drives 300+ interaction tests (viewer lifecycle, keyboard,
  tap/swipe, galleries, video, settings persistence, pagination) against this
  release's code.
- **Static validation:** `web-ext lint` validates the package against
  Firefox's manifest schema (as AMO's uploader does).
- **Temporary manual install (interactive):** *not performed by an agent.*
  Verify locally in under a minute:
  `npm run ext:firefox:run`, or `about:debugging#/runtime/this-firefox` →
  **Load Temporary Add-on** → pick
  `release/RedditPix-v1.0.0-firefox.zip` or `build/firefox-extension/manifest.json`.

## 8. Manual actions remaining before AMO submission

1. Web-host `PRIVACY.md` and fill the `[confirm/supply]` URLs in
   `FIREFOX-AMO-LISTING.md`.
2. Submit as a **new add-on** on your own AMO account — never as an update to
   the upstream listing. The Developer Hub will give the final id-availability
   verdict at upload.
3. Icon caution: the artwork includes Reddit's mascot styling; expect
   trademark scrutiny on a new listing (Mozilla evaluates case by case).
4. Firefox for Android is declared compatible (`gecko_android` ≥ 142) but has
   not been device-tested; select Android in the Developer Hub only after
   such testing.

## 9. Checksum

- **SHA-256 of `release/RedditPix-v1.0.0-firefox.zip`:**
  `94cc1050a4728d2b23200fce59ae1acc6400d40809377df0bf40094a92f857af`
  (bash `sha256sum` over the exact file bytes, 296,902 bytes; any repackage
  changes this).
