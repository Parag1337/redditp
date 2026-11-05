# RedditPix Privacy Policy

_Last updated: 2026-11-06. Applies to RedditPix v1.0.0 and later._

**Summary in one sentence:** RedditPix shows you the Reddit page you are already
browsing; it stores your presentation settings in your browser, sends nothing
anywhere of its own, collects nothing, and has no server of any kind.

## What the extension does

RedditPix turns the Reddit page currently open in your browser into an in-page
media slideshow. It reads the posts that your own browser has already rendered —
using your normal Reddit session, exactly as if you were looking at the page —
and presents them one slide at a time. If a slide is under-informative (for
example a search result that shows only a small thumbnail), the extension fetches
that post's own Reddit page from reddit.com in the background to recover the real
image, video, or gallery.

## What RedditPix collects

**Nothing.** RedditPix collects, transmits, or sells no personal data. There is:

- no analytics, telemetry, crash reporting, or tracking of any kind;
- no account system and no extension-side login;
- no advertising;
- no server-side component at all — RedditPix is a browser extension only;
- no browsing history, content, or browsing-activity data collected, stored, or
  transmitted off your device.

This is declared to Firefox at install time via the manifest
`data_collection_permissions` field, which requires the value `"none"`.

## What RedditPix stores locally

Your presentation preferences (slide duration, panels shown or hidden,
tap/swipe behavior, sound preference, auto-advance state, preloading choices)
are stored only in your own browser, using:

- `chrome.storage.local` under the settings key `redditpPresentationSettings`
  (the internal key name is historical and unchanged, so existing settings keep
  working); and
- a `localStorage` fallback in the Reddit page for cases where the storage API
  is not available.

Both are private to your browser profile and are never sent anywhere. You can
clear them at any time:

- Firefox: about:addons → RedditPix → gear → reset, or clear site data /
  storage for reddit.com (the fallback lives in that page's localStorage).
- Chrome: delete site data for reddit.com.

## Network requests the extension makes

RedditPix makes requests, and it is important to know to where and why. The
extension initiates (or lets the page initiate) only these kinds of requests,
all in the content of showing you Reddit media:

1. **reddit.com itself.** The feed's own requests are the browser's; beyond
   those, the extension fetches an individual post's reddit.com HTML page or
   its same-origin `.json` endpoint when the rendered page does not expose that
   post's media (small search thumbnails, collapsed galleries, lazy video
   cards). These requests are made with your normal Reddit session
   (`credentials: "include"`) so the results match what your account sees, but
   the extension never stores or forwards what it downloads.

2. **The media hosts of the posts you are viewing.** Loading a slide necessarily
   downloads the media it displays from wherever Reddit serves or embeds it —
   Reddit's own media hosts, and the standard embed/asset hosts of the link
   types Reddit posts commonly contain, such as Imgur image/video files and
   YouTube embed frames. RedGIFs-hosted media is resolved through RedGIFs'
   public API (`api.redgifs.com`) to obtain the media URL. Every RedGIFs request
   is anonymous (`credentials: "omit"`); only the media identifier from the post
   you are viewing is sent to them, never your Reddit session.

3. **Nothing else.** The extension makes no requests to any other domain, and
   even the above happen only while you are looking at a reddit.com page with
   the viewer open. Note that the pages themselves — Reddit and the embedded
   media frames — can make their own requests under their own policies; that is
   outside this extension's control and unchanged by it.

## Why the permissions are needed

- **activeTab** — lets the toolbar button and the `Alt+P` shortcut see the
  address of the tab you activated, to verify it is a reddit.com page before
  starting the slideshow.
- **scripting** — injects the slideshow into the Reddit tab you activated the
  viewer on.
- **storage** — saves your presentation settings locally in your browser.
- **Host permission for reddit.com** — the content script must run on Reddit
  listing and post pages to build the slideshow from the rendered posts, and to
  fetch individual post pages/JSON on demand to upgrade under-informative
  slides. Firefox treats such host permissions as optional and asks you to
  allow access; the `?redditp=1` deep-link launch needs that grant.
- **Content script on reddit.com** — one small script reads only your address's
  URL query on reddit.com pages to detect the opt-in `redditp=1` parameter;
  it does nothing on any other website and nothing else on Reddit pages.

## Children's privacy, and content ratings

RedditPix has no knowledge of who uses it: it collects nothing, so there is
nothing directed at children and no age gate of its own. It presents whatever
your own Reddit account shows you, including any mature content Reddit shows
you; parental controls should be set in Reddit itself.

## Changes

If a future version of RedditPix changes what it collects, this policy and the
stores' data-collection declarations will be updated with the release.

## Contact

This extension's home is its source repository:
<https://github.com/Parag1337/redditp>. Open an issue there with any privacy
question.
