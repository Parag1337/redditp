# Firefox Add-ons (AMO) listing copy for RedditPix

Values below are ready to paste into the AMO submission form at
<https://addons.mozilla.org/developers/addon/submit/>. Items marked
**[confirm/supply]** are yours to set — they are yours, not pen names, and
this document does not invent them.

Submitted file: `RedditPix-v1.0.0-firefox.zip` (see `RELEASE-VERIFICATION.md`).

## Add-on identity

- **Gecko id:** `{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}`
  (random-UUID GUID form; verified not in use by any listed add-on via the
  AMO public API — see `RELEASE-VERIFICATION.md` for the exact check. Firefox
  requires the braces or an email-style address for this key.)
- RedditPix is an independent fork; the upstream RedditP add-on
  (`presentation-mode@redditp.com`, owned by its original developer on AMO)
  must never be referenced here, so submissions are never treated as updates
  to that listing.
- List it on your own AMO account as a **new add-on**, not an update.

## Add-on name

    RedditPix

Exact match with the `name` in `manifest.json`; AMO rejects mismatches.

## Summary (max 250 chars)

    Turn the Reddit page you are browsing into a full-screen media slideshow —
    images, galleries, and video from the posts already on your screen, with
    keyboard, tap, and swipe navigation and a built-in slideshow timer.

## Full description

You can use AMO's simple Markdown. Paste the following (same text as the store
listing, adjusted for Firefox phrasing):

RedditPix turns the Reddit page you already have open into a full-screen
slideshow — no new tab, no copied links, no API key.

Click the toolbar button or press **Alt+P** on any Reddit feed, subreddit,
search result, or post page. RedditPix reads the posts that are already on your
screen and shows their media one at a time, with the post title, community
link, and a way back to the comments.

It displays **images, galleries, and Reddit-hosted video**, including gallery
slides with an (n/total) counter, Imgur gifs served as mp4, Imgur images, and
YouTube embeds with start times. Search results that only show a small
thumbnail are upgraded automatically by reading that post's own Reddit page in
the background. When Reddit has no more media to show for a link, you still get
a title card with links to the media and the comments.

**Navigate** with the arrow keys, Page Up and Page Down, the side arrows, taps
in the left/right thirds of the screen, horizontal swipes, or the numbered bar
at the bottom. **Slideshow** auto-advance is one click away on the numbered
bar; the interval (1–3600 seconds per slide) is yours to set. Video can be
allowed to play through once past the timer, and short clips can loop until the
timer ends — failed or stalled media always falls back to the timer so the
slideshow never hangs.

Other controls: **F** browser fullscreen, **M** video sound, **T** title panel,
**P** bottom panel, **H** hide the interface, **R** rotate, **C** comments, **I**
original media, **G** skip the rest of the gallery, **Esc** close, **Alt+P**
open/close. All preferences persist between sessions. You can also add
`redditp=1` to any Reddit address (for example
`https://www.reddit.com/r/pics/?redditp=1`) and the page opens in RedditPix
by itself.

RedditPix runs only on reddit.com, uses your existing Reddit session, makes no
analytics or tracking requests of any kind, sends nothing to any extension
server, and has no server at all. Your settings are stored only in your
browser. Firefox install-time data collection declaration: none. Full privacy
policy: see the listing's Privacy policy field. RedditPix is independent and
not affiliated with Reddit.

## Feature highlights (for screenshots/gallery captions)

1. Full-screen slideshow of the Reddit feed you are already on.
2. Galleries become per-image slides with a counter.
3. Keyboard, tap-zone, and swipe navigation; numbered jump bar.
4. Auto-advance timer with video-aware behavior.
5. Thumbnails upgraded to real media in the background.
6. Fullscreen, hide-UI, rotate, sound controls.

## Category

    Photos, Music & Videos

## Tags / keywords (AMO keywords field, space-separated)

    reddit slideshow media viewer images galleries video fullscreen

(AMO recommends short descriptive tags; avoid trademark-loaders. Do not add
third-party site names — see `browser-extension/STORE-LISTING.md` for the
history behind that rule.)

## URLs

- **Homepage URL:** https://redditp.com/ — serves the viewer and links the
  extension **[confirm this is the URL you want; alternatives: the
  `redditp.com/extension` install page]**
- **Support URL:** https://github.com/Parag1337/redditp/issues
- **Support e-mail:** [confirm/supply]
- **Privacy policy URL:** host `PRIVACY.md` on a site you control
  (e.g. `https://redditp.com/privacy` or a repository page) **[confirm/supply —
  AMO requires a reachable URL for listed submissions]**
- **License field:** MIT (source is open at
  https://github.com/Parag1337/redditp)

## AMO form selections

- **Distribution channels:** listed on AMO (Firefox Add-ons) **plus**
  self-distribution is optional; at minimum choose "listed".
- **Platform:** Desktop (Firefox for Android is declared compatible in the
  manifest — `gecko_android` min 142 — but has not been device-tested; select
  Android only after such testing).
- **Data collection flags (Install page):** "Does the add-on collect or
  transmit user data?" → **No**. The manifest declares
  `data_collection_permissions: { required: ["none"] }`, so keep these in
  agreement.
- **Maturity rating:** the extension displays whatever the user's own Reddit
  account shows; answer the mature-content question accordingly (see
  `browser-extension/STORE-LISTING.md`).

## Permission explanations (AMO review notes field)

- `activeTab` — see the active tab's address when the user clicks the toolbar
  button or presses Alt+P, to verify it is a reddit.com page (shows a toolbar
  hint otherwise).
- `scripting` — inject the slideshow into the Reddit tab on activation.
- `storage` — persist the user's presentation settings locally.
- `https://reddit.com/*` and `https://*.reddit.com/*` host permissions — the
  content script reads the rendered posts on Reddit pages to build the
  slideshow, and fetches individual post pages/`.json` on demand to recover
  media for under-informative cards. Firefox treats these as optional
  install-time; the `?redditp=1` deep-link flow needs the grant. The
  auto-activation content script reads only the URL query on reddit.com
  (the `redditp=1` opt-in parameter) and does nothing else.
- `browser_specific_settings.gecko.id.{941a3bf7-8de6-4d3a-b7d3-a6f7b5220fd2}` /
  `strict_min_version 140.0` (Android 142.0) — 140 is the first release
  supporting the `data_collection_permissions` declaration; 142 the first
  Android release.
- Background MV3 event page (`background.scripts`) replaces the Chrome service
  worker; no other Firefox-specific behavior.

## Before you press Submit

1. Host the privacy policy and fill the URLs above (`[confirm/supply]`).
2. Note on the icon: the current artwork includes Reddit's mascot styling.
   Mozilla evaluates such imagery case by case; keep the "not affiliated with
   Reddit" wording consistent, and be prepared to re-theme the icon if the
   first review flags it.
3. Upload `RedditPix-v1.0.0-firefox.zip` from `release/` (verify the SHA-256).
4. Screenshots: 16:9 for desktop (and 600x600+ tiles), showing ordinary
   subreddits and the actual UI; nothing requiring a content rating.
5. Run `npx web-ext lint --source-dir build/firefox-extension` one last time
   (last run: 0 errors, 6 advisory `innerHTML` warnings).
6. Keep this file in sync with any future version bump.
