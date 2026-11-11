# Changelog

All notable changes to RedditPix are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-11-10

Patch release with the numbered-bar anchoring and image-latency recording
fixes found during the 1.0.0→1.0.1 audit. Package: `RedditPix-v1.0.1-firefox.zip`
(SHA-256 `fb9c0aa6713e2c1c91202fa441e22b96ddaff9046a76e84b7e0295372e376ec7`).
`web-ext lint`: 0 errors, 0 notices, 0 warnings.

### Fixed — viewer

- Numbered-bar anchoring is no longer judged against a mid-flight smooth
  scroll: a resize or rapid reselect while an earlier anchor animation was
  still running could read the active number as visible right before the
  pending scroll carried it off-track, leaving the selected number out of
  view until the next navigation. Anchoring decisions now use the remembered
  resting target of the pending animation (content coordinates are
  scroll-invariant, an 800ms staleness guard covers engine timing).
- The resource-aware video pause ("slow network") no longer un-pauses
  because of cache-served image loads: a re-preload of an already held image
  URL completes without a network fetch (no new resource timing entry in
  both Chromium and Firefox), and such completions carry no congestion
  evidence — they are excluded from the latency window, so speculative
  video fetches stay paused until actual network latency recovers. Engines
  without resource timing keep the previous sampling behavior.

### Internal — test suite

- The numbered-bar settle helper waits for a scroll-quiet position before
  measuring (the padded end anchor animates through positions that look
  unclipped ~16px early), and the auto-toggle test pins the real 44×44
  desktop control box instead of a compact pill that never shipped; the
  congestion fixture sends `no-store` so every image fetch under test
  traverses the throttled route.

[1.0.1]: https://github.com/Parag1337/redditp

## [1.0.0] — 2026-11-06

First officially released version, published as **RedditPix** (previously
distributed as "Presentation Mode for Reddit", first public extension version
0.5.6).

### Added — viewer

- In-page, full-screen media slideshow for reddit.com listing, post, user, and
  search pages on both current and old Reddit, driven by the posts the page
  already renders — no cloned tab, no URL rewriting, no Reddit API key.
- Images (`jpg`, `jpeg`, `png`, `webp`, `gif`, `avif`, with `srcset`
  best-size selection), object-fit containment, and 90° media rotation.
- Galleries: every gallery image becomes its own slide, with an `(1/n)`
  counter, gallery extraction from cached, lazy-loaded, collapsed card HTML,
  and post JSON, `G` to skip the rest of the gallery, and slideshow
  continuation into the next post.
- Reddit-hosted video: DASH video + audio through Reddit's own `dash.js`
  player (lent via a page-world bridge so v.redd.it slides can play with
  sound), HLS fallback, packaged-media `mp4`, and reuse of Reddit's live
  adaptive player when present.
- Imgur `gifv`/`gif` → `mp4` and single images; YouTube/youtu.be embeds with
  start-time and sound parameters; generic `/watch/<id>` player frames
  rendered as `/ifr/<id>` embeds; link and self-text posts as title cards.
- Post enrichment: search thumbnails and other under-informative slides are
  upgraded in place by fetching the post's own Reddit HTML then JSON in the
  background, with the link card as fallback.

### Added — navigation and controls

- Numbered bottom bar with direct jump-to-post, previous/next side arrows,
  keyboard navigation (`←/→/↑/↓`, `Page Up/Down`), tap zones, and horizontal
  swipe; fullscreen toggle; hide-interface mode; title/bottom panels with
  per-panel toggles; per-session media rotation.
- Keyboard shortcuts: `Alt+P` (open/close), `F` fullscreen, `M` sound,
  `T`/`P` panels, `C` comments, `I` original media, `Esc` close, `G` gallery
  skip, `Space`/`A` auto-advance.
- Slideshow: configurable auto-advance interval (1–3600 s), media-aware
  timing (videos can play at least once; short clips can loop to the timer),
  and timer fallbacks so failed/paused media never stalls the show.

### Added — settings and resilience

- Persistent preferences in `chrome.storage.local` (key
  `redditpPresentationSettings`, with `localStorage` fallback), hot-readable
  by the in-page viewer, including legacy-setting migration.
- Predictive preloading: current-gallery first, then a configurable horizon
  of upcoming posts, bounded concurrency, duplicate-request prevention,
  retries with repriority, `image.decode()` reuse, eviction with resource
  release, hidden-tab deferral, and a small speculative-video budget.
- Pagination: DOM rescan for newly rendered posts, old Reddit `next ›`
  following (same origin only), infinite-scroll triggering on current Reddit,
  wrap-around at the end, and a `loading more` counter state.
- A pure-CSS loading indicator for images/videos with a render-identity
  token so stale frames cannot flash.

### Changed

- The extension is renamed to RedditPix everywhere user-facing (manifest
  name/action title, toolbar hints, store copy). Internal compatibility
  identifiers (storage keys, the `?redditp=1` deep-link parameter, event
  names, and the historical file/attribute naming) are intentionally
  unchanged, so existing users keep their saved settings and bookmarks.
- First Firefox Add-ons (AMO) targeted release: MV3 event-page background,
  static add-on id `{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}` (an independent
  fork identity — the upstream RedditP add-on keeps its own id and listing),
  `strict_min_version` 140.0 (142.0 on Android), and the
  `data_collection_permissions: none` declaration.

### Security / privacy posture

- No network activity other than Reddit pages/JSON needed to build slides and
  the media hosts of the media shown; RedGIFs API requests are anonymous
  (`credentials: "omit"`).
- No analytics, tracking, or extension-owned servers; a full privacy policy
  ships as `PRIVACY.md`.
- Every dynamic HTML parse in the viewer now goes through inert `DOMParser`
  parsing and static SVG icons go through the same parse path; AMO lint
  (`web-ext lint`) reports 0 errors, 0 notices, and 0 warnings for the package.
- iframe player sound control is deliberately not implemented because it
  would require cross-origin permissions; sound works for Reddit-hosted video
  and the supported embed protocols.

[1.0.0]: https://github.com/Parag1337/redditp
