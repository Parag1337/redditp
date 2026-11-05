# RedditPix v1.0.0 — release verification report

_Date of verification: 2026-11-06. Environment: Linux (host machine),
Firefox used by the automated suite via Playwright; Chrome via Playwright
Chromium._

## 1. Build

- **Command:** `node nodejs/package-extension.js firefox`
- **Output:** `build/RedditPix-v1.0.0-firefox.zip` (289.6 KB), staged from the
  single source tree `browser-extension/` (the current working tree,
  including all uncommitted work; stale `build/redditp-extension-*-v0.5.6.zip`
  artifacts were ignored, not used as input).
- **Staged allow-list** (everything the packager copies):
  `manifest.json`, `background.js`, `content.js`, `page-bridge.js`,
  `auto-activate.js`, `presentation.css`, `favicon.png`,
  `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`.

## 2. Archive integrity (automated)

- `unzip -t`: **OK**, no errors detected in compressed data.
- `unzip -l`: 11 entries, no duplicates (verified via Python
  `zipfile.namelist()`: `len(set) == len(list)`), no absolute or `..`-containing
  paths, `manifest.json` **at the archive root**.
- Complete listing:

      background.js, content.js, page-bridge.js, auto-activate.js,
      presentation.css, favicon.png, icon-16.png, icon-32.png,
      icon-48.png, icon-128.png, manifest.json

- No `node_modules`, tests, fixtures, probes, git metadata, logs, or docs
  inside the ZIP.

## 3. Manifest validation (automated)

Parsed from inside the ZIP with Python `json`:

| Field | Value |
| --- | --- |
| `manifest_version` | 3 |
| `name` | `RedditPix` |
| `version` | `1.0.0` |
| `background` | `{ "scripts": ["background.js"] }` (Firefox MV3 event page) |
| `permissions` | `activeTab`, `scripting`, `storage` |
| `host_permissions` | `https://reddit.com/*`, `https://*.reddit.com/*` |
| `icons` | 16/32/48 → `icon-16/32/48.png`, 128 → `icon-128.png`, 512 → `favicon.png` |
| `browser_specific_settings.gecko` | id `presentation-mode@redditp.com`, `strict_min_version` `140.0`, `data_collection_permissions: ["none"]` |
| `browser_specific_settings.gecko_android` | `strict_min_version` `142.0` |

All referenced files exist in the archive (scripted check: none missing).
Icon dimensions verified with PIL: every file matches the size declared for
it (favicon.png is 512×512 RGBA, matching its declared slot).

## 4. AMO linting (automated)

- **Command:** `npx web-ext lint --source-dir build/firefox-extension`
- **Result:** `errors: 0, notices: 0, warnings: 6`.
- The 6 warnings are all `UNSAFE_VAR_ASSIGNMENT` (dynamic `innerHTML` values)
  in `content.js` — the same advisory class present in earlier releases
  (then 3 warnings; the count grew with the Phase-7 preloading additions).
  No blocker-level issues.

## 5. Regression tests (automated)

Full offline Playwright suite — every page navigation fulfilled by `page.route`
with local fixtures; no live Reddit access required.

- **Command:** `npx playwright test --workers=1`
- **Result:** see §5.1 below (filled in after the run).
- Suites exercised: the main `browser-extension.spec.js` under both the
  Chromium and Firefox projects plus `preload-benchmarks.spec.js` (run via its
  dedicated benchmark config on both engines).

### 5.1 Results

| Suite | Command | Result | Exit code |
| --- | --- | --- | --- |
| Full (Chromium + Firefox projects) | `npx playwright test --workers=1` | _finalized below_ | |
| Preload benchmarks (Firefox) | `npx playwright test -c tests/playwright/_firefox-bench.config.js` | _finalized below_ | |
| Preload benchmarks (Chromium) | `npx playwright test -c playwright.chrome.config.js tests/playwright/preload-benchmarks.spec.js` | _finalized below_ | |

> Known pre-existing flake (documented before this release, unrelated to
> branding changes): `browser-extension.spec.js` test
> `"a thumbnail-only search result upgrades again after reopening"` can flake
> under parallel load; suites are therefore run with `--workers=1`.

## 6. Firefox installation (automated + manual)

- **Automated:** the Playwright Firefox project loads the unpacked extension
  in a real Firefox instance and runs 300+ interaction tests against it
  (viewer open/close, keyboard, taps/swipes, galleries, video, settings
  persistence, pagination) — this exercises the same code the ZIP contains.
- **Static install check:** `web-ext lint` validates the package against
  Firefox's manifest schema (AMO applies the same validator family at upload).
- **Temporary manual install:** *not performed in this session by an agent* —
  it requires interactive confirmation (`about:debugging` → Load Temporary
  Add-on). Anyone can verify locally in under a minute:

      npm run ext:firefox:run     # or: about:debugging → load build/firefox-extension/manifest.json

  Or install `release/RedditPix-v1.0.0-firefox.zip` directly via
  `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**, open
  e.g. `https://www.reddit.com/r/pics/`, press the toolbar button.

## 7. Manual actions remaining before AMO submission

1. Web-host `PRIVACY.md` and fill the `[confirm/supply]` fields in
   `FIREFOX-AMO-LISTING.md` (homepage/privacy/support URLs, support e-mail).
2. Decide on the icon imagery: the icon artwork contains Reddit's mascot,
   which can attract trademark/impersonation scrutiny on a brand-new AMO
   listing (the listing copy sets the "not affiliated with Reddit" expectation;
   Mozilla evaluates icon/descriptor usage case by case).
3. Upload the ZIP in the AMO Developer Hub, paste the listing copy, select
   "Photos, Music & Videos" category, declare **no data collection**, and take
   screenshots.
4. Optional: a `web-ext run` interactive pass on live Reddit, plus
   Firefox-for-Android device testing before claiming Android availability.

## 8. Compatibility notes carried into the release

- Firefox treats MV3 `host_permissions` as optional; toolbar button and
  `Alt+P` work without the grant, the `?redditp=1` deep-link launch needs it,
  and the toolbar flash-hint guides the user (its copy is branded RedditPix
  now).
- Firefox for Android: declared via `gecko_android` but not device-tested; the
  AMO listing doc recommends selecting Android only after such testing.

## 9. Checksum

- **SHA-256 of `RedditPix-v1.0.0-firefox.zip`:**
  `8ba6cdb666ac297d5bae9a1027d855b6f2bf819d336199e1443e8304cb9e515b`
  (computed with Python `hashlib` over the exact file bytes; any repackage
  changes this value).
