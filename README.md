# RedditPix — Reddit media slideshow browser extension

## Overview

RedditPix is an enhanced Reddit media-viewing browser extension designed to
provide an immersive, distraction-free experience for viewing Reddit images,
galleries, and videos. It turns the Reddit feed you are already browsing into a
full-screen, navigable media slideshow — no separate tab, no copied URLs, and no
Reddit API key. The extension reads the posts your browser has already rendered,
using your normal Reddit session.

This repository is a distinctly improved, extension-focused continuation of the
original Redditp project:

- **The original project**
  ([ubershmekel/redditp](https://github.com/ubershmekel/redditp)) combined the
  redditp.com website with an early extension that converted Reddit pages into
  slideshows.
- **This repository**
  ([Parag1337/redditp](https://github.com/Parag1337/redditp)) concentrates on
  the browser extension experience: a modern Manifest V3 extension named
  **RedditPix** with a rebuilt media viewer, gallery support,
  predictive preloading and caching, persistent settings, and a large automated
  test suite. The legacy website sources were removed from this repository and
  remain available in the upstream project.

The project's focus is improving the browser extension experience. The MIT
license and the original author's attribution are preserved (see
[Credits](#credits-and-attribution)).

## Features

Everything below is confirmed by the current implementation in
`browser-extension/`.

### Immersive media viewer

- Minimal, dark, distraction-free overlay injected directly into the Reddit page
  (black background, `color-scheme: dark`).
- Fullscreen media viewing via the Fullscreen API, with a toolbar button, the
  `F` key, and an optional "start in fullscreen" setting.
- Correct image fitting: media uses `object-fit: contain`, so images are never
  cropped; large images expand to fill the stage while small ones keep their
  natural size.
- Media rotation in 90° steps (`R` or the rotate button).
- Responsive layout: mobile breakpoints (≤600px, ≤969px), `100dvh` viewport
  handling with `100vh` fallback, safe-area insets, a reduced-motion media
  query, and a solid-background fallback where `backdrop-filter` is missing.

### Post navigation

- Numbered navigation bar along the bottom listing every loaded post; click a
  number to jump directly to that post, with the active post highlighted and
  kept in view.
- Previous/next arrow buttons on the sides of the stage.
- Keyboard navigation with the arrow keys, `Page Up`, and `Page Down`.
- Tap-based navigation (see [gestures](#keyboard-shortcuts-and-gestures)): tap
  the left or right third of the screen, or swipe horizontally.
- Gallery image counter shown as `(1/7)` on gallery slides, plus a post counter
  (`3 / 12`, with a `loading more` state while the feed is being extended).

### Gallery support

- Detects Reddit galleries on both current and old Reddit, including cached,
  lazy-loaded, and collapsed gallery HTML, and galleries recovered from Reddit's
  post JSON (`gallery_data` / `media_metadata`).
- Every gallery image becomes its own slide; move between them with the normal
  prev/next controls, keys, taps, or swipes.
- The slideshow advances through each image of a gallery and then continues to
  the next post.
- `G` (or the gallery button) skips the rest of the current gallery and moves to
  the next post.

### Slideshow

- Automatic slideshow with an **auto** toggle in the numbered bar.
- Default interval of **5 seconds** per slide, configurable from 1 to 3600
  seconds in the settings panel, and persisted between sessions.
- Correct timer lifecycle: the timer is re-armed on every slide change, cleared
  when the viewer closes, paused while auto-advance is off, and never left
  running by navigation.
- Media-aware timing: videos can be allowed to "play at least once" past the
  timer, short clips can loop until the timer ends, and failed, paused, or
  blocked media falls back to the slide timer so the slideshow never stalls.

### Media preloading and caching

- Predictive preload of upcoming media: the rest of the current gallery first,
  then the next posts within a configurable horizon (default 5 posts), plus the
  slides immediately behind so stepping back is instant.
- Reuse of cached resources: preloaded images (already decoded with
  `image.decode()`, where available) and metadata-first videos are handed
  straight to the viewer.
- Duplicate network requests are avoided: each media URL is fetched once per
  post identity, whether it is in the cache or already in flight.
- Bounded concurrency (default 3 parallel preloads, clamped 1–6) and a small
  budget for speculative video preloads.
- Failed media loads are retried (up to 2 retries with backoff-by-repriority),
  then parked without starving later media; revisiting a slide retries it.
- Resources are released when no longer needed: evicted entries drop their
  `src`, videos are paused and reloaded, and everything is cancelled when the
  viewer closes. Preloading pauses while the tab is hidden and resumes when it
  becomes visible again.

### Controls and user interface

- Top-right control stack: close, fullscreen toggle, hide/show interface,
  settings gear, rotate, and gallery skip.
- Side previous/next arrows, a bottom count panel, and the numbered bar with the
  auto-advance toggle.
- `H` hides the entire interface for a clean view; `P` toggles the bottom panel;
  `T` toggles the title panel.
- The obsolete legacy comments/media toolbar and the old mute
  button are gone: comments and the original media open in a new tab with `C`
  and `I`, and sound is toggled with `M`.
- Controls are styled for small screens (smaller arrows and panels below 600px,
  44×44px minimum targets for the numbered and auto buttons) and remain
  reachable at viewports from 360×780 up to 2560×1440.

### Settings

- Persistent user preferences stored in `chrome.storage.local` under the key
  `redditpPresentationSettings` (with a `localStorage` fallback); settings
  survive reloads and browser restarts.
- Settings panel ("Time per slide" plus checkboxes): let videos play at least
  once, loop short videos, show the title panel, show previous/next arrows, show
  the close button, **show the bottom panel (the bottom navigation/count bar)**,
  enable tap zones, enable swipe navigation, start with the interface hidden,
  and start in fullscreen where supported.
- Also persisted but toggled by keyboard/behavior rather than the panel: sound
  on/off (`M`), auto-advance on/off (`A`/`Space`), and the preload
  horizon/concurrency (defaults 5 and 3).
- Legacy settings are migrated automatically (for example the old
  `controlsCollapsed` value becomes `showControls`).
- With the bottom panel hidden, the numbered bar reduces to the auto toggle;
  only `H` (hide interface) removes the whole strip.

### Feed and Reddit integration

- Subreddit and author are detected from the post and displayed as links in the
  title panel (linking back to Reddit with `?redditp=1` so the viewer reopens
  there).
- Pagination: the viewer works from the posts already rendered in the page,
  rescans the live DOM for newly rendered posts, follows old Reddit's "next ›"
  listing/search links (same origin only), and triggers Reddit's infinite scroll
  when needed; reaching the end wraps around when there is nothing more to load,
  and the counter shows `loading more` meanwhile.
- Post enrichment: when a feed card does not expose its media (search
  thumbnails, collapsed galleries, lazy video cards), the extension fetches that
  post's own page (HTML, then JSON) in the background and upgrades the slide in
  place, with the link card as fallback.
- Content formats actually handled:
  - Images: `jpg`, `jpeg`, `png`, `webp`, `gif`, `avif` (including `srcset`
    best-size selection).
  - Galleries (see above).
  - Reddit-hosted video (`v.redd.it`): DASH video + audio via Reddit's own
    `dash.js` player lent in through `page-bridge.js`, HLS when the browser
    supports it, packaged-media `mp4`, and reuse of Reddit's live adaptive
    player (its low-frame-rate `CMAF_96` seek preview is never played).
  - Imgur links (`gifv`/`gif` → `mp4`, single images; albums fall back to a link
    card).
  - YouTube / youtu.be / youtube-nocookie embeds (with start time, referrer, and
    mute/sound parameters; mute command supported through the embed's message
    protocol).
  - Generic same-origin `/watch/<id>` player frames that Reddit link posts
    commonly use (rendered as `/ifr/<id>` embeds).
  - Link posts (title card with "Open linked post") and self/text posts (body
    rendered in the card).
- NSFW and spoiler media is shown directly; Reddit's blurred cover image is
  never presented as a slide.
- Unsupported content degrades gracefully to a title card linking to the media
  and comments — the slideshow keeps working.

## Browser compatibility

Based on the actual manifest and packaging configuration:

| Browser                                                                           | Support                    | Notes                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Chrome (desktop/Android)                                                   | Primary target             | Manifest V3 with a service worker; unpacked load for development, store packaging included.                                                                                                |
| Chromium-based browsers (Edge, Opera, Brave, Vivaldi, Samsung Internet, ChromeOS) | Expected to work           | Same MV3 manifest; not individually tested.                                                                                                                                                |
| Mozilla Firefox (desktop)                                                         | Supported                  | Packaged build converts the background to an MV3 event page and adds `browser_specific_settings` (add-on id, `strict_min_version` 140.0). Verified by the Playwright Firefox test project. |
| Firefox for Android                                                               | Declared, **not verified** | The Firefox manifest declares `gecko_android` `strict_min_version` 142.0, but installation and behavior on a physical Android device have **not** been tested.                             |
| Safari (macOS/iOS)                                                                | Not supported              | There is no Safari Web Extension build target in this repository.                                                                                                                          |

Chromium and Firefox differ in ways that matter:

- Firefox treats Manifest V3 `host_permissions` as optional: reddit.com access
  is not granted at install. The toolbar button and `Alt+P` work through
  `activeTab`; only the `?redditp=1` URL launch needs the host permission to
  have been granted.
- Firefox's native video controls consume clicks on the video surface first, so
  Firefox toggles playback itself; visible behavior is the same.
- `background.js` and `auto-activate.js` use a `globalThis.browser || chrome`
  handle because Firefox's `chrome` alias is callback-based.

Physical mobile-device behavior (touch on real phones, mobile browser chrome,
autoplay policies on iOS/Android) has **not** been verified; mobile coverage in
this repo is limited to Playwright viewport sizes.

## Installation and usage

### Obtain the extension

- Store installs: <https://redditp.com/extension> (opens the Firefox Add-ons
  listing in Firefox, the Chrome Web Store otherwise), or
- Run from source: clone this repository and install the dev dependencies:

  ```sh
  npm install
  ```

### Install in Chrome (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `browser-extension/` folder of this
   repository.
4. Pin **RedditPix** if you want its toolbar button visible.

### Install in Firefox

The manifest in `browser-extension/` is the Chrome one, so build the Firefox
variant first:

1. `npm run ext:package:firefox` — writes `build/firefox-extension/`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick
   `build/firefox-extension/manifest.json`.

`npm run ext:firefox:run` does the same in a throwaway profile. Temporary
installs disappear when Firefox restarts; release Firefox only keeps add-ons AMO
has signed. For a permanent self-installed build, run `npm run ext:firefox:sign`
with AMO API keys (`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`) to produce a signed
`.xpi` in `build/`, or use Firefox Developer Edition/Nightly/ESR with
`xpinstall.signatures.required` set to `false`. See
`browser-extension/README.md` for the full signing flow.

### Enable and open the viewer

- Click the extension toolbar button, or press **`Alt+P`** (changeable at
  `chrome://extensions/shortcuts` or about:addons → gear → **Manage Extension
  Shortcuts**). The same action closes the viewer if it is already open.
- Or add `?redditp=1` to any Reddit URL, e.g.
  `https://www.reddit.com/r/pics/?redditp=1`.

### Use it

- **Navigate**: arrow keys / `Page Up`·`Page Down`, the side arrows, taps in the
  left/right thirds, horizontal swipes, or click a number in the bottom numbered
  bar to jump to a loaded post.
- **Slideshow**: click **auto** in the numbered bar or press `A` (or `Space`) to
  start/stop auto-advance; set the interval in the gear panel.
- **Settings**: click the gear (top right) to change the time per slide, video
  behavior, which panels are visible, tap/swipe behavior, and startup options.
  Preferences are saved automatically.
- **Clean view**: `H` hides all controls; `F` toggles fullscreen; `R` rotates
  the media; `M` toggles sound.

## Keyboard shortcuts and gestures

All controls below are read from the current `browser-extension/content.js` key
handler. Keys are bare keys: any combination holding Ctrl/Cmd/Alt passes through
to the browser (that is how `Alt+P` reaches the extension).

| Action                                          | Control                              |
| ----------------------------------------------- | ------------------------------------ |
| Next slide                                      | `→`, `↓`, `Page Down`                |
| Previous slide                                  | `←`, `↑`, `Page Up`                  |
| Toggle auto-advance (slideshow)                 | `Space`, `A`, or the **auto** button |
| Skip rest of gallery / next post                | `G` or the gallery button            |
| Previous post (from the first slide of a post)  | left tap zone                        |
| Toggle fullscreen                               | `F` or the fullscreen button         |
| Hide / show the whole interface                 | `H` or the hide button               |
| Rotate media 90°                                | `R` or the rotate button             |
| Toggle video sound (muted by default)           | `M`                                  |
| Show / hide the title panel                     | `T`                                  |
| Show / hide the bottom panel                    | `P`                                  |
| Open the post's comments in a new tab           | `C`                                  |
| Open the original media in a new tab            | `I`                                  |
| Close settings / exit fullscreen / close viewer | `Esc`                                |
| Move focus inside the open dialog               | `Tab` / `Shift+Tab`                  |
| Open or close presentation mode                 | `Alt+P` (extension command)          |

Touch gestures (where enabled in settings):

| Gesture                       | Action                                       |
| ----------------------------- | -------------------------------------------- |
| Tap left third of the screen  | previous post                                |
| Tap right third of the screen | skip rest of gallery / next post             |
| Tap center                    | next slide — only while inside a gallery     |
| Swipe horizontally (>55px)    | previous / next slide                        |
| Tap the video surface         | play / pause (native control strip excluded) |

Notes:

- `Space` toggles auto-advance in the current code (the in-app help card still
  lists it as "Next slide" — see [Known limitations](#known-limitations)).
- Vertical swipes are intentionally left to the page (no action).
- Single-image posts do nothing on a center tap; only gallery slides advance.

## Project structure

```text
.
├── AGENTS.md                     # contributor/agent working agreement
├── LICENSE                       # MIT (original Redditp license)
├── README.md                     # this file
├── PRIVACY.md                    # privacy policy (also shipped in release/)
├── CHANGELOG.md                  # release notes (also shipped in release/)
├── FIREFOX-AMO-LISTING.md        # Firefox Add-ons listing copy
├── package.json                  # scripts and dev dependencies
├── playwright.config.js          # test projects: chromium + firefox
├── playwright.chrome.config.js   # optional run against installed Google Chrome
├── browser-extension/            # the extension source (single source tree)
│   ├── manifest.json             # MV3 manifest, version 1.0.0
│   ├── background.js             # toolbar / Alt+P launcher, injection
│   ├── auto-activate.js          # ?redditp=1 URL activation
│   ├── content.js                # viewer, extraction, navigation, preloading
│   ├── page-bridge.js            # MAIN-world bridge for v.redd.it DASH audio
│   ├── presentation.css          # isolated responsive viewer styles
│   ├── README.md                 # extension-specific documentation
│   ├── STORE-LISTING.md          # Chrome Web Store listing copy
│   └── favicon.png, icon-16/32/48/128.png
├── tests/
│   └── playwright/
│       ├── browser-extension.spec.js   # main suite
│       ├── preload-benchmarks.spec.js  # preloading benchmark suite
│       └── media-mode / pagination / animations specs, audit probes
├── test-data/                    # local HTML/video fixtures used by tests
├── nodejs/
│   ├── package-extension.js      # builds Chrome and Firefox packages
│   └── release-extension.js      # store upload/release automation
├── release/                      # official release: ZIP, docs, verification
├── build/                        # generated packages (gitignored)
├── .env.example                  # credential template for releases
└── .vscode/                      # editor settings (Prettier on save)
```

Tests, packages, and `node_modules/` are generated and gitignored. The extension
is fully self-contained in `browser-extension/`; nothing in the build or test
pipeline depends on the removed legacy website sources.

## Development and testing

### Requirements

- Node.js ≥ 20.12 (the release script uses `process.loadEnvFile`), npm.
- Playwright browsers: `npx playwright install` (Chromium and Firefox).
- Optional for real-Google-Chrome runs: an installed `google-chrome`.
- Optional for Firefox packaging/linting: `web-ext` (installed as a dev
  dependency).

### Commands

| Command                                                 | Purpose                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm install`                                           | Install development tools.                                                  |
| `npm test`                                              | Run the Playwright suite (Chromium + Firefox projects).                     |
| `npm run test:playwright` / `test:playwright:ui`        | Same suite / UI mode.                                                       |
| `npx playwright test -c playwright.chrome.config.js`    | Run the suite against installed Google Chrome.                              |
| `npm run ext:package`                                   | Package the Chrome zip → `build/RedditPix-v<version>.zip`.                  |
| `npm run ext:package:firefox`                           | Package the Firefox zip → `build/RedditPix-v<version>-firefox.zip`.         |
| `npm run ext:package:all`                               | Package both targets.                                                       |
| `npm run ext:firefox:run`                               | Build Firefox target and run it via `web-ext` in a throwaway profile.       |
| `npx web-ext lint --source-dir build/firefox-extension` | Run AMO's lint checks on the Firefox build.                                 |
| `npm run ext:firefox:sign`                              | Sign the Firefox build (unlisted) for self-distribution.                    |
| `npm run ext:release` / `ext:release:dry`               | Version-bump, package, and upload to both stores (dry run prints a review). |
| `npm run format`                                        | Format the repository with Prettier.                                        |

Packaging details:

- `nodejs/package-extension.js` stages exactly the runtime files listed in the
  script (keep it in sync with `manifest.json`) into `build/chrome-extension/`
  and `build/firefox-extension/`, then zips them.
- The Chrome build uses `manifest.json` as-is. The Firefox build patches in an
  MV3 event-page background (`background.scripts`) and
  `browser_specific_settings` (add-on id `{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}`,
  `strict_min_version` 140.0, `data_collection_permissions: none`, and
  `gecko_android` 142.0).
- `nodejs/release-extension.js` requires credentials in `.env` (see
  `.env.example`), a clean git tree, and bumps `browser-extension/manifest.json`
  before uploading; it resumes after partial failures.

### Test coverage

The suite (`tests/playwright/browser-extension.spec.js`, plus
`audit-probe.spec.js`) runs **offline by design**: every navigation is fulfilled
through `page.route`, media hosts are stubbed, and local fixtures in
`test-data/` are used, so no live Reddit access is needed. It covers, among
others:

- Old and current Reddit post extraction, text posts, search cards, and
  enrichment races (HTML → JSON fallback, challenge pages, late responses).
- Galleries (cached/expanded/lazy, JSON ordering, skip behavior) and the
  `(n/total)` counter.
- Image fitting/containment across six viewports (360×780 … 2560×1440).
- Video behavior: DASH/bridge attach and fallback, adaptive-player reuse,
  autoplay-muted fallback, and 16 clock-driven auto-advance scenarios.
- Preloading phases 2–3.1: cache reuse, duplicate-request prevention,
  concurrency caps, retries, eviction/release, decode-once, hidden-tab deferral,
  and unsupported-format exclusion.
- Settings persistence and migration, shortcut passthrough (Ctrl+F etc.), focus
  trapping, lifecycle races (close during load, stale-overlay retire),
  pagination/wrapping, and the legacy toolbar staying gone.
- Responsive overlap checks for long titles and controls at mobile viewports.

Test results for this revision (run locally against the committed tree):

- `npm test` (bundled Chromium + Firefox projects): **245 passed, 1 skipped, 0
  failed** (~3.4 min). The single skip is the Chromium-only native-controls
  test, which is skipped by design on Firefox.
- `npx playwright test -c playwright.chrome.config.js` (installed Google Chrome
  156): **125 passed, 0 failed**.
- `npx web-ext lint --source-dir build/firefox-extension`: **0 errors**, 0
  notices, 3 advisory `innerHTML` warnings in `content.js`.

Note: running two suites concurrently in this directory has previously made
timing-sensitive preloading tests flake; run suites sequentially.

## Known limitations

- **No physical mobile-device testing.** Mobile behavior is covered only by
  Playwright viewport sizes; Firefox for Android is declared in the manifest but
  unverified, and iOS/Safari are not supported at all.
- **Chromium vs Firefox differences** exist (optional host permissions on
  Firefox, native video-control click handling, event page vs service worker) —
  see [Browser compatibility](#browser-compatibility).
- **External media hosts** other than Reddit, Imgur, YouTube, and generic
  `/watch`→`/ifr` player frames are not specially handled; they appear as link
  cards. There is no crosspost-specific logic.
- **Live-Reddit verification** was not part of this documentation pass: the
  automated tests use local fixtures, and Reddit DOM changes can break
  extraction until the selectors are updated.
- **In-app help discrepancies**: the settings-panel shortcut card lists `Space`
  as "Next slide" although the code toggles auto-advance, and it does not list
  `R` (rotate). This README documents the actual behavior.
- **No digit-key jump to a post** — the numbered bar is click/tap only.
- **No vertical-swipe action and no volume slider** — swipes are horizontal
  only; sound is a muted/unmuted toggle (`M`).
- **Rotation is per-session** — it is not one of the persisted settings.
- Two preload smoke tests are log-only (no assertions) and cannot fail; they
  exist to surface duplicate-request warnings in the output.

## Roadmap

Current functionality is everything documented under [Features](#features). The
following are **future ideas, not implemented commitments**:

- Improved mobile experience and larger touch targets across the viewer.
- Better touch interactions (for example vertical or edge gestures).
- A standalone mobile application or PWA around the viewer.
- A dedicated RedditPix browser (kiosk-style Reddit media browsing).
- Additional feed customization (subreddit picking, filtering, ordering).
- Smaller polish items: correcting the in-app shortcut card, optional digit-key
  post jumping, and investigating a Safari build target.

## Credits and attribution

- Redditp was created by **Yuval Greenfield** and lives upstream at
  <https://github.com/ubershmekel/redditp>. RedditPix is an independent fork of
  that work, published as a separate add-on under its own Mozilla Add-ons
  identity, and is not affiliated with Reddit, Inc. or with the upstream
  project.
- This improved repository: <https://github.com/Parag1337/redditp>
- The extension is distributed as **RedditPix**; install
  link: <https://redditp.com/extension>
- Licensed under the MIT License — see [LICENSE](LICENSE). The original license
  and attribution are preserved as the MIT redistribution requires; please keep
  the `LICENSE` file and this attribution when redistributing.
