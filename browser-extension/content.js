(function redditpContentScript() {
  "use strict";

  if (window.__redditpPresentation) {
    window.__redditpPresentation.toggle();
    return;
  }

  // Reloading or updating an unpacked extension creates a fresh isolated
  // JavaScript world, so the marker above is no longer visible even though an
  // older presentation can still be mounted in the page. Retire cooperating
  // versions first, then click older versions' close buttons so they restore
  // any live Reddit video they moved into their overlay.
  document.dispatchEvent(new Event("redditp:presentation-retire"));
  Array.from(
    document.querySelectorAll("#redditp-presentation.redditp"),
  ).forEach((staleRoot) => {
    const staleClose = staleRoot.querySelector(".redditp__close");
    if (staleClose && typeof staleClose.click === "function") {
      staleClose.click();
    }
    staleRoot.remove();
  });

  const SPECIFIC_POST_SELECTOR = [
    "shreddit-post",
    ".thing.link",
    ".search-result.search-result-link",
    "[data-id='search-media-post-unit']",
    "[data-testid='search-post-unit']",
    "[data-testid='post-container']",
  ].join(",");
  const POST_SELECTOR = `${SPECIFIC_POST_SELECTOR},article`;
  const FOCUSABLE_SELECTOR =
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), video[controls], iframe";
  const IMAGE_URL_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
  const VIDEO_URL_RE = /\.(?:m3u8|mp4|webm)(?:$|[?#])/i;
  const MIN_EXPAND_IMAGE_LONG_EDGE = 1000;
  const MIN_EXPAND_IMAGE_SHORT_EDGE = 600;
  // Videos cost decoders and buffers, so only this many speculative video
  // elements may sit in the cache or in flight at the same time. The video
  // window itself stays inside the ordinary preloadPosts horizon.
  const VIDEO_PRELOAD_LIMIT = 2;
  const VIDEO_PRELOAD_WINDOW = 2;
  // A preload that produces neither completion nor an error within this
  // budget is treated as failed (with the ordinary bounded retries): a hung
  // connection must not hold a concurrency slot forever, and a display that
  // joined the job must not sit on the loading indicator indefinitely.
  const PRELOAD_TIMEOUT_MS = 30000;
  // Same budget for the element on stage: media that shows no data event in
  // time gets one fresh retry before the failure card takes over, so the
  // loader can never outlive the truth by more than one bounded attempt.
  const DISPLAY_TIMEOUT_MS = 30000;
  // Image-first fairness: completed image loads feed a small rolling latency
  // window. While recent images average slower than this, the network reads
  // as congested and speculative video element fetches (plain and DASH) pause
  // entirely. RedGIFs metadata resolution keeps running: it is a few hundred
  // bytes of JSON that unlocks the ordinary video pipeline. The pause lifts
  // by itself once image latency recovers (or the image queue drains).
  const IMAGE_LATENCY_SAMPLES = 4;
  const IMAGE_SLOW_MS = 2500;
  // Duration eligibility (Phase 5A): a post whose media is exclusively video
  // with every duration KNOWN to exceed this limit is excluded from the
  // eligible navigation sequence. Images are never filtered, and an unknown
  // duration is an explicit unknown — provisionally eligible, not zero.
  const MAX_ELIGIBLE_VIDEO_SECONDS = 60;
  // Media mode (Part C): one cycling filter over the extracted slides.
  // `both` is the default so every user who never touched the control keeps
  // the exact behavior shipped before the mode existed.
  const MEDIA_MODE_KEYS = ["both", "images", "videos"];
  const SETTINGS_KEY = "redditpPresentationSettings";
  // Slide transitions: each value names the one animation used at every
  // media swap from a navigation. `random` is resolved per transition by an
  // injectable sampler (never "none") that avoids repeating its choice.
  const TRANSITION_ANIMATION_KEYS = [
    "none",
    "fade",
    "slide-right",
    "slide-left",
    "ken-burns",
    "random",
  ];
  const TRANSITION_ANIMATION_LABELS = {
    none: "None",
    fade: "Fade",
    "slide-right": "Slide Right",
    "slide-left": "Slide Left",
    "ken-burns": "Ken Burns",
    random: "Random",
  };
  const TRANSITION_ANIMATION_POOL = [
    "fade",
    "slide-right",
    "slide-left",
    "ken-burns",
  ];
  // The one embed origin that publishes a message protocol for controlling
  // its player. Every other player keeps its own sound control.
  const JS_API_EMBED_ORIGIN = "https://www.youtube.com";
  // RedGIFs player frames never publish a control protocol, but the bridge
  // content script reports one complete playback cycle through this one
  // versioned message. The parent validates the origin, source frame, and
  // media identity before treating it as a completion.
  const REDGIFS_EMBED_ORIGIN = "https://www.redgifs.com";
  const REDGIFS_BRIDGE_CHANNEL = "redditp-redgifs";
  const REDGIFS_BRIDGE_VERSION = 1;
  const REDGIFS_BRIDGE_COMPLETION = "completion";
  const DEFAULT_SETTINGS = {
    slideDurationSeconds: 5,
    finishMediaOnce: true,
    loopShortMedia: true,
    showDetails: true,
    showArrows: true,
    showClose: true,
    showControls: true,
    sound: false,
    autoAdvance: true,
    tapZones: true,
    swipeNavigation: true,
    startHidden: false,
    startFullscreen: false,
    preloadPosts: 5,
    preloadConcurrency: 3,
    mediaMode: "both",
    transitionAnimation: "none",
  };
  const state = {
    open: false,
    opening: false,
    slides: [],
    index: 0,
    autoTimer: null,
    autoPlaying: false,
    mediaPlayback: null,
    // The slide whose RedGIFs player frame is currently mounted, so its
    // completion bookkeeping can be released when that frame is torn down.
    redgifsEmbedSlide: null,
    loadingMore: false,
    advanceAfterLoad: false,
    loadRequest: 0,
    nextPageUrl: "",
    openRequest: 0,
    enrichments: new Map(),
    nativeRestores: new WeakMap(),
    oldOverflow: "",
    pointerStart: null,
    pendingTransition: null,
    transition: null,
    transitionToken: 0,
    randomSource: Math.random,
    lastRandomTransition: "",
    settings: Object.assign({}, DEFAULT_SETTINGS),
    settingsLoaded: false,
    settingsOpen: false,
    interfaceHidden: false,
    rotation: 0,
    preloadQueue: [],
    preloadInFlight: new Map(),
    preloadCache: new Map(),
    preloadRetry: new Map(),
    preloadRetryLimit: 2,
    // Rolling completion-latency window (ms) of the last few image loads,
    // read by the scheduler as a network-congestion signal.
    preloadImageLatencies: [],
    scanFailures: 0,
    preloadStats: {
      started: 0,
      loaded: 0,
      decoded: 0,
      decodeFailed: 0,
      failed: 0,
      evicted: 0,
      canceled: 0,
      hits: 0,
      misses: 0,
      // Phase 5A accounting: posts skipped for known long duration, and
      // v.redd.it DASH sources prepared ahead of navigation.
      longSkipped: 0,
      dashPrepared: 0,
      // RedGIFs direct-media accounting: metadata resolutions that produced a
      // playable URL, and ones that ended in the embed fallback.
      redgifsPrepared: 0,
      redgifsFailed: 0,
      // Phase 7 accounting: prepared DASH entries invalidated because their
      // bridge mark was released on the way out of the display. A released
      // element can never be recognized as prepared again, so keeping the
      // entry would both fake reuse and permanently occupy a video-budget
      // slot.
      dashReleased: 0,
      // Video preparation depth accounting: preloaded videos that actually
      // reached initial media data (first frame), not just metadata.
      videoFirstFrames: 0,
    },
    lastNavigation: null,
    debugLog: [],
  };

  function absoluteUrl(value) {
    if (!value || value === "#") return "";
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function redditPageUrl(label, kind) {
    if (!label) return "";
    const prefix = kind === "user" ? "u/" : "r/";
    const name = label.startsWith(prefix) ? label.slice(prefix.length) : label;
    if (!name) return "";
    const path = kind === "user" ? "user" : "r";
    return `https://www.reddit.com/${path}/${encodeURIComponent(name)}/?redditp=1`;
  }

  function textOf(element) {
    return element
      ? (element.textContent || "").replace(/\s+/g, " ").trim()
      : "";
  }

  function bestSrcFromSet(srcset) {
    if (!srcset) return "";
    const choices = srcset.split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      const score = parseFloat(bits[1]) || 0;
      return { url: bits[0], score };
    });
    choices.sort((a, b) => b.score - a.score);
    return choices.length ? choices[0].url : "";
  }

  function trackingData(node) {
    const tracked =
      node.closest("[data-faceplate-tracking-context]") ||
      node.querySelector("[data-faceplate-tracking-context]");
    if (!tracked) return {};
    try {
      return JSON.parse(
        tracked.getAttribute("data-faceplate-tracking-context"),
      );
    } catch (_error) {
      return {};
    }
  }

  function usefulImage(image) {
    // Blurred or spoiler images are covers, not additional media slides.
    if (
      !image ||
      image.closest(
        "[aria-hidden='true'], shreddit-blurred-container [slot='blurred']",
      )
    )
      return false;
    const description =
      `${image.getAttribute("alt") || ""} ${image.className || ""}`.toLowerCase();
    if (/avatar|award|emoji|icon|snoo/.test(description)) return false;
    const width =
      Number(image.getAttribute("width")) || image.naturalWidth || 0;
    const height =
      Number(image.getAttribute("height")) || image.naturalHeight || 0;
    return !(width && height && width <= 96 && height <= 96);
  }

  function imageUrl(image) {
    const raw =
      bestSrcFromSet(image.getAttribute("srcset")) ||
      bestSrcFromSet(image.getAttribute("data-lazy-srcset")) ||
      image.currentSrc ||
      image.getAttribute("src") ||
      image.getAttribute("data-lazy-src");
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
    return absoluteUrl(raw.replace(/&amp;/g, "&"));
  }

  function isBlurredImageUrl(url) {
    try {
      const parsed = new URL(url);
      return (
        /(^|\.)redd\.it$/i.test(parsed.hostname) &&
        Number(parsed.searchParams.get("blur")) > 0
      );
    } catch (_error) {
      return false;
    }
  }

  function firstHref(node, selectors) {
    for (const selector of selectors) {
      const link = node.querySelector(selector);
      if (link) {
        const href = absoluteUrl(link.getAttribute("href") || link.href);
        if (href) return href;
      }
    }
    return "";
  }

  function commentsUrl(node) {
    const permalink =
      node.getAttribute("permalink") || node.getAttribute("data-permalink");
    return (
      absoluteUrl(permalink) ||
      firstHref(node, [
        "a[data-click-id='comments']",
        "a.comments",
        "a[href*='/comments/']",
      ])
    );
  }

  function postTitle(node) {
    const attributeTitle = node.getAttribute("post-title");
    if (attributeTitle) return attributeTitle.trim();
    const trackedTitle = trackingData(node).post?.title;
    if (trackedTitle) return trackedTitle.trim();
    return (
      textOf(node.querySelector("[slot='title']")) ||
      textOf(node.querySelector("a.title")) ||
      textOf(node.querySelector("a.search-title")) ||
      textOf(node.querySelector("h1, h2, h3")) ||
      textOf(
        node.querySelector(
          "a[href*='/comments/']:not([aria-label*='thumbnail']):not([aria-label='media poster'])",
        ),
      ) ||
      "Reddit post"
    );
  }

  // innerText only lays out paragraphs for rendered elements. A post fetched
  // with DOMParser is never rendered, so mark the block breaks by hand.
  function readableText(element) {
    if (element.isConnected && element.ownerDocument === document) {
      return element.innerText || element.textContent || "";
    }
    const copy = element.cloneNode(true);
    copy.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    copy.querySelectorAll("li, tr").forEach((block) => block.append("\n"));
    copy
      .querySelectorAll("p, h1, h2, h3, h4, h5, h6, blockquote, pre")
      .forEach((block) => block.append("\n\n"));
    return copy.textContent || "";
  }

  function postBodyText(node) {
    const body = node.querySelector(
      "[slot='text-body'] .md, .usertext-body .md, [data-click-id='text'] .md, [data-post-click-location='text-body']",
    );
    if (!body) return "";
    return readableText(body)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function postAuthor(node) {
    const value =
      node.getAttribute("author") || node.getAttribute("data-author");
    if (value) return value.startsWith("u/") ? value : `u/${value}`;
    const author = textOf(node.querySelector("a.author, a[href*='/user/']"));
    return author ? (author.startsWith("u/") ? author : `u/${author}`) : "";
  }

  function postCommunity(node) {
    const value =
      node.getAttribute("subreddit-prefixed-name") ||
      node.getAttribute("data-subreddit-prefixed") ||
      node.getAttribute("data-subreddit");
    if (value) return value.startsWith("r/") ? value : `r/${value}`;
    const trackedCommunity = trackingData(node).subreddit?.name;
    if (trackedCommunity) return `r/${trackedCommunity}`;
    const explicitCommunity = textOf(
      node.querySelector("a.subreddit, a.search-subreddit-link"),
    );
    if (explicitCommunity.startsWith("r/")) return explicitCommunity;
    const community = textOf(
      node.querySelector("a[href^='/r/'], a[href*='reddit.com/r/']"),
    );
    return community.startsWith("r/") ? community : "";
  }

  function isVideoUrl(url) {
    if (VIDEO_URL_RE.test(url)) return true;
    try {
      return new URL(url).searchParams.get("format") === "mp4";
    } catch (_error) {
      return false;
    }
  }

  // Safari and Android browsers play HLS in a plain <video>. Most desktop
  // browsers need a script player for it.
  let hlsSupport = null;
  function canPlayHls() {
    if (hlsSupport === null) {
      hlsSupport = Boolean(
        document
          .createElement("video")
          .canPlayType("application/vnd.apple.mpegurl"),
      );
    }
    return hlsSupport;
  }

  function canonicalMediaKey(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    } catch (_error) {
      return url;
    }
  }

  function externalMedia(sourceUrl) {
    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch (_error) {
      return null;
    }
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    // RedGIFs watch links already travel to an /ifr player frame through the
    // generic convention below; carrying the media id along is what lets the
    // direct-media resolver skip the embed player entirely when it can.
    if (hostname === "redgifs.com" || hostname.endsWith(".redgifs.com")) {
      const id = redgifsMediaId(parsed);
      if (id) {
        return {
          kind: "embed",
          url: `https://www.redgifs.com/ifr/${id}`,
          redgifsId: id,
        };
      }
      return null;
    }
    if (hostname === "imgur.com" || hostname === "i.imgur.com") {
      const match = parsed.pathname.match(
        /(?:\/gallery|\/a)?\/([\w]+)(?:\.(\w+))?$/i,
      );
      if (!match || /\/gallery\/|\/a\//.test(parsed.pathname)) return null;
      const extension = (match[2] || "").toLowerCase();
      if (extension === "gifv" || extension === "gif") {
        return { kind: "video", url: `https://i.imgur.com/${match[1]}.mp4` };
      }
      return {
        kind: "image",
        url: `https://i.imgur.com/${match[1]}.${extension || "jpg"}`,
      };
    }
    if (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube-nocookie.com" ||
      hostname.endsWith(".youtube-nocookie.com")
    ) {
      const pathId = parsed.pathname.match(
        /^\/(?:embed|shorts|live)\/([\w-]+)/i,
      );
      const id =
        hostname === "youtu.be"
          ? parsed.pathname.split("/").filter(Boolean)[0]
          : parsed.searchParams.get("v") || pathId?.[1];
      if (id && /^[\w-]+$/.test(id)) {
        const embedParams = new URLSearchParams();
        const start = youtubeStartSeconds(
          parsed.searchParams.get("start") || parsed.searchParams.get("t"),
        );
        if (start) embedParams.set("start", String(start));
        if (parsed.searchParams.get("list")) {
          embedParams.set("list", parsed.searchParams.get("list"));
        }
        // Asking for the player's message protocol is what lets the sound
        // toggle reach this frame later without any extra browser access.
        embedParams.set("enablejsapi", "1");
        const query = embedParams.toString();
        return {
          kind: "embed",
          url: `https://www.youtube.com/embed/${id}${query ? `?${query}` : ""}`,
        };
      }
    }
    // Several video hosts linked from Reddit publish a watch page at
    // /watch/<id> and the matching player frame at /ifr/<id> on the same
    // origin. Follow that convention instead of naming individual sites.
    const framed = parsed.pathname.match(/^\/(?:watch|ifr)\/([\w-]+)\/?$/i);
    if (framed) {
      return { kind: "embed", url: `${parsed.origin}/ifr/${framed[1]}` };
    }
    return null;
  }

  // A slide is meant to start playing on its own, and to start silent unless
  // the viewer asked for sound. Both have to be requested in the URL, because
  // the frame cannot be scripted before it exists. Hosts spell the mute
  // request differently and ignore parameters they do not recognise, so send
  // the common variants. Players that ignore the lot keep their own control.
  function embedUrl(url, muted) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("autoplay", "1");
      if (muted) {
        parsed.searchParams.set("muted", "1");
        parsed.searchParams.set("mute", "1");
        parsed.searchParams.set("sound", "false");
      } else {
        // Some players default to muted and expose the inverse setting rather
        // than a mute parameter. Unknown parameters are ignored by hosts that
        // use their own controls.
        parsed.searchParams.set("sound", "true");
      }
      return parsed.toString();
    } catch (_error) {
      return url;
    }
  }

  function youtubeStartSeconds(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value);
    const match = String(value).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!match) return 0;
    return (
      (Number(match[1]) || 0) * 3600 +
      (Number(match[2]) || 0) * 60 +
      (Number(match[3]) || 0)
    );
  }

  // ---------------------------------------------------------------------------
  // RedGIFs direct-media resolution (Part B)
  //
  // RedGIFs posts traditionally display through the host's /ifr embed player,
  // which resolves its own metadata and streams inside a cross-origin frame.
  // The v2 JSON API is reachable cross-origin from this script (it answers
  // preflights for reddit.com origins), hands out an anonymous short-lived
  // token, and returns direct MP4 renditions that play through a plain video
  // element. Resolution upgrades slide kinds from `embed` to `video` so every
  // existing piece of the pipeline (duration policy, preloader, prepared
  // element reuse) keeps working unchanged; when direct resolution or
  // playback fails the slide stays an embed and the old behavior applies.
  // ---------------------------------------------------------------------------

  const REDGIFS_API_ORIGIN = "https://api.redgifs.com";
  // The temporary token outlives this viewer but is anonymous and unbound to
  // any user credential; refreshing is cheap, so cache it well under its life.
  const REDGIFS_TOKEN_TTL_MS = 55 * 60 * 1000;
  // Bounded re-resolution: a media id that failed returns to the network at
  // most this many times per page load.
  const REDGIFS_FAILURE_LIMIT = 2;
  const redgifsResolutions = new Map();
  const redgifsFailures = new Map();
  let redgifsToken = null;
  let redgifsTokenRequest = null;

  // RedGIFs publishes the same media under several URL shapes; the watch page,
  // the player frame, and the direct thumbnails link all carry the bare id.
  function redgifsMediaId(parsedUrl) {
    const path = parsedUrl.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    const match = path.match(/^(?:watch|ifr|g|gallerys?)\//);
    if (match) {
      const id = path.slice(match[0].length).split("/")[0];
      return /^[\w-]+$/.test(id) ? id.toLowerCase() : "";
    }
    // i.redgifs.com/i/<id> and thumbs2.redgifs.com/Thumbs/<id>.mp4 forms.
    if (path.startsWith("i/")) {
      const id = path.slice(2).split(".")[0];
      return /^[\w-]+$/.test(id) && !/\//.test(id) ? id.toLowerCase() : "";
    }
    return "";
  }

  async function redgifsTokenValue(forceNew) {
    if (!forceNew && redgifsToken && Date.now() < redgifsToken.expiresAt) {
      return redgifsToken.value;
    }
    if (!redgifsTokenRequest) {
      redgifsTokenRequest = (async () => {
        try {
          const response = await fetch(
            `${REDGIFS_API_ORIGIN}/v2/auth/temporary`,
            { credentials: "omit", headers: { Accept: "application/json" } },
          );
          if (!response.ok) {
            throw new Error(`RedGIFs auth returned ${response.status}`);
          }
          const data = await response.json();
          if (!data?.token) throw new Error("RedGIFs auth gave no token");
          redgifsToken = {
            value: data.token,
            expiresAt: Date.now() + REDGIFS_TOKEN_TTL_MS,
          };
          return data.token;
        } finally {
          redgifsTokenRequest = null;
        }
      })();
    }
    return redgifsTokenRequest;
  }

  async function redgifsApiGet(path, refreshed) {
    const token = await redgifsTokenValue(Boolean(refreshed) && true);
    const response = await fetch(`${REDGIFS_API_ORIGIN}${path}`, {
      credentials: "omit",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    // A 401 can mean the anonymous token aged out between calls; one fresh
    // token (and only one per request) is the recovery.
    if (response.status === 401 && !refreshed) return redgifsApiGet(path, true);
    if (!response.ok) {
      let code = String(response.status);
      try {
        const body = await response.json();
        if (body?.error?.code) code = String(body.error.code);
      } catch (_parseError) {
        // A non-JSON error body keeps the status as the reason.
      }
      throw new Error(`RedGIFs ${code}`);
    }
    return response.json();
  }

  // One in-flight resolution per media id: concurrent previews of the same
  // RedGIFs post share a single API request. The promise settles with
  // { ok, ... } and never rejects, so callers do not need their own handlers.
  // Each id may hit the network at most REDGIFS_FAILURE_LIMIT times per page
  // load; after that only the embed fallback remains. A success stays cached,
  // a failure clears its cache slot but keeps its counted attempt.
  function resolveRedgifsMedia(id, forceNew) {
    if (!id) return Promise.resolve({ ok: false, reason: "no-media-id" });
    const failure = redgifsFailures.get(id);
    if (failure && failure.attempts >= REDGIFS_FAILURE_LIMIT) {
      return Promise.resolve({ ok: false, reason: "redgifs-cooldown" });
    }
    if (forceNew !== true) {
      const pending = redgifsResolutions.get(id);
      if (pending) return pending;
    }
    const promise = (async () => {
      try {
        const payload = await redgifsApiGet(
          `/v2/gifs/${encodeURIComponent(id)}`,
        );
        const gif = payload?.gif || payload || {};
        const urls = gif.urls || {};
        // hd always carries the sound track, so an unmuted viewer is never
        // stuck with a silent rendition; sd/mobile and silent are the
        // progressively smaller fallbacks.
        const url = absoluteUrl(urls.hd || urls.sd || urls.silent || "");
        if (!url) {
          return { ok: false, reason: "no-playable-variant" };
        }
        const duration = Number(gif.duration);
        return {
          ok: true,
          url,
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
          poster: absoluteUrl(urls.poster || "") || "",
          embedUrl: absoluteUrl(urls.html || "") || "",
        };
      } catch (error) {
        const failure = redgifsFailures.get(id) || { attempts: 0, lastAt: 0 };
        failure.attempts += 1;
        failure.lastAt = Date.now();
        redgifsFailures.set(id, failure);
        debugLogEvent("redgifs-resolve-failed", {
          id,
          attempts: failure.attempts,
          reason: String(error?.message || error),
        });
        return { ok: false, reason: "resolution-failed" };
      }
    })();
    redgifsResolutions.set(id, promise);
    // Bounded memory: entries are tiny strings but the map must not grow
    // with the feed's every RedGIFs post over a long session.
    while (redgifsResolutions.size > 300) {
      redgifsResolutions.delete(redgifsResolutions.keys().next().value);
    }
    while (redgifsFailures.size > 300) {
      redgifsFailures.delete(redgifsFailures.keys().next().value);
    }
    promise.then((result) => {
      // A settled failure frees its cache slot (bounded re-attempt); a
      // success is worth reusing for every later look of the same id.
      if (!result.ok) redgifsResolutions.delete(id);
    });
    return promise;
  }

  function packagedVideoUrl(player) {
    const raw = player.getAttribute("packaged-media-json");
    if (!raw) return "";
    try {
      const permutations = JSON.parse(raw).playbackMp4s?.permutations || [];
      permutations.sort((a, b) => {
        const aSize =
          (a.source?.dimensions?.width || 0) *
          (a.source?.dimensions?.height || 0);
        const bSize =
          (b.source?.dimensions?.width || 0) *
          (b.source?.dimensions?.height || 0);
        return bSize - aSize;
      });
      return permutations[0]?.source?.url || "";
    } catch (_error) {
      return "";
    }
  }

  function contentUrl(node, fallbackCommentsUrl) {
    const attributeNames = ["content-href", "data-url", "url", "data-href-url"];
    for (const name of attributeNames) {
      const result = absoluteUrl(node.getAttribute(name));
      if (
        result &&
        result !== fallbackCommentsUrl &&
        !isBlurredImageUrl(result)
      )
        return result;
    }
    const result = firstHref(node, [
      "a.search-link",
      "a[data-click-id='body']",
      "a[data-click-id='media']",
      "a.thumbnail",
      "a.title",
      "a[href*='i.redd.it']",
      "a[href*='v.redd.it']",
    ]);
    return result && !isBlurredImageUrl(result) ? result : fallbackCommentsUrl;
  }

  function elementsIncludingOpenShadows(root, selector) {
    const results = Array.from(root.querySelectorAll(selector));
    if (root.shadowRoot) {
      results.push(...elementsIncludingOpenShadows(root.shadowRoot, selector));
    }
    root.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) {
        results.push(
          ...elementsIncludingOpenShadows(element.shadowRoot, selector),
        );
      }
    });
    return results;
  }

  function isSinglePostPage() {
    return /\/comments\/[^/]+/i.test(location.pathname);
  }

  function unresolvedAdaptivePlayerExists() {
    return Array.from(
      document.querySelectorAll(
        "shreddit-player[preview]:not([packaged-media-json])",
      ),
    ).some(
      (player) =>
        Boolean(player.getAttribute("preview")) &&
        !elementsIncludingOpenShadows(player, "video").some((video) =>
          (video.currentSrc || video.getAttribute("src") || "").startsWith(
            "blob:",
          ),
        ),
    );
  }

  function adaptiveBlobVideo(root) {
    return elementsIncludingOpenShadows(root, "video").find((video) =>
      (video.currentSrc || video.getAttribute("src") || "").startsWith("blob:"),
    );
  }

  function requestPlayerStart(player) {
    if (!player?.getAttribute("preview")) return false;
    const video = elementsIncludingOpenShadows(player, "video").find(
      (candidate) =>
        !(candidate.currentSrc || candidate.getAttribute("src") || ""),
    );
    if (!video || typeof video.click !== "function") return false;
    video.click();
    return true;
  }

  function requestAdaptivePlayerStart() {
    document
      .querySelectorAll("shreddit-player[preview]:not([packaged-media-json])")
      .forEach(requestPlayerStart);
  }

  async function waitForAdaptivePlayer(request) {
    if (!isSinglePostPage() || !unresolvedAdaptivePlayerExists()) return;
    requestAdaptivePlayerStart();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(100);
      if (!state.open || request !== state.openRequest) return;
      if (!unresolvedAdaptivePlayerExists()) return;
    }
  }

  function isGalleryPost(node) {
    return (
      node.hasAttribute("gallery") ||
      node.getAttribute("post-type") === "gallery" ||
      node.getAttribute("data-is-gallery") === "true" ||
      Boolean(node.querySelector("gallery-carousel, .media-gallery"))
    );
  }

  function oldRedditGalleryLinks(node) {
    const selector = ".media-gallery .gallery-item-thumbnail-link";
    const liveLinks = Array.from(node.querySelectorAll(selector));
    if (liveLinks.length) return liveLinks;

    const links = [];
    node.querySelectorAll(".expando[data-cachedhtml]").forEach((expando) => {
      // Collapsed old-Reddit galleries live in escaped HTML, not child nodes.
      // DOMParser parses inertly: scripts cannot run and no resources load,
      // so only the link elements are read out of the markup, and that
      // markup is never mounted into the live document.
      const cached = parseHtmlDocument(
        expando.getAttribute("data-cachedhtml") || "",
      );
      links.push(...cached.querySelectorAll(selector));
    });
    return links;
  }

  function mediaFromNode(node, sourceUrl) {
    const media = [];
    const seen = new Set();
    // postMedia marks the post's own media, as opposed to a preview image
    // scraped out of a listing card for a post that links somewhere else.
    function add(kind, url, poster, postMedia, source) {
      const normalized = absoluteUrl(url);
      const key = canonicalMediaKey(normalized);
      if (!normalized || seen.has(key)) return;
      if (kind === "image" && isBlurredImageUrl(normalized)) return;
      seen.add(key);
      const item = {
        kind,
        url: normalized,
        poster: absoluteUrl(poster),
        postMedia: Boolean(postMedia),
      };
      media.push(item);
      // RedGIFs ids ride along so the resolver can find them later.
      if (source && source.redgifsId) {
        item.redgifsId = source.redgifsId;
        item.embedUrl = source.url;
      }
      return item;
    }

    // On old Reddit post pages the real adaptive player is already attached
    // to a MediaSource blob. A second video element is only a muted, low-frame
    // rate seek preview, so preserve and reuse the live player when available.
    const nativeVideo = adaptiveBlobVideo(node);
    if (nativeVideo) {
      media.push({
        kind: "native-video",
        url: sourceUrl,
        poster: absoluteUrl(nativeVideo.getAttribute("poster")),
        nativeElement: nativeVideo,
      });
      return media;
    }

    oldRedditGalleryLinks(node).forEach((link) => {
      // The anchor is the full-size image; grid tiles and nested previews are
      // smaller renditions of the same item, not additional gallery slides.
      const url = absoluteUrl(link.getAttribute("href"));
      if (IMAGE_URL_RE.test(url)) add("image", url, "", true);
    });
    if (media.length) return media;

    const galleryFigures = Array.from(
      node.querySelectorAll("gallery-carousel figure"),
    );
    if (galleryFigures.length) {
      galleryFigures.forEach((figure) => {
        const player = figure.querySelector("shreddit-player");
        if (player) {
          add(
            "video",
            packagedVideoUrl(player) ||
              player.getAttribute("preview") ||
              player.getAttribute("src"),
            player.getAttribute("poster"),
          );
          return;
        }
        const image = figure.querySelector("img:not([role='presentation'])");
        if (image && usefulImage(image))
          add("image", imageUrl(image), "", true);
      });
      if (media.length) return media;
    }

    node.querySelectorAll("shreddit-player").forEach((player) => {
      const preview = player.getAttribute("preview") || "";
      // A 96p, silent clip for the seek bar's thumbnails, not the video.
      const isSeekPreview = /\/(?:CMAF|DASH)_96\.mp4(?:$|[?#])/i.test(preview);
      const packagedUrl = packagedVideoUrl(player);
      if (!packagedUrl && isSeekPreview && player.ownerDocument === document) {
        media.push({
          kind: "pending-native-video",
          url: absoluteUrl(player.getAttribute("src")) || sourceUrl,
          poster: absoluteUrl(player.getAttribute("poster")),
          playerElement: player,
        });
        return;
      }
      const hlsUrl = absoluteUrl(player.getAttribute("src"));
      // Fall back to the seek preview only where this browser cannot play
      // the HLS source by itself; a silent clip still beats a failed slide.
      const playerUrl =
        packagedUrl ||
        (isSeekPreview
          ? (canPlayHls() && hlsUrl) || absoluteUrl(preview) || hlsUrl
          : absoluteUrl(preview) || hlsUrl) ||
        firstHref(player, ["source"]);
      add("video", playerUrl, player.getAttribute("poster"));
    });
    // A shreddit-player may also contain its HLS source element. That is an
    // alternate rendition of the same post, not a second slide (and Chromium
    // cannot play the HLS URL directly).
    if (
      media.some(
        (item) => item.kind === "video" || item.kind === "pending-native-video",
      )
    )
      return media;
    node.querySelectorAll("video").forEach((video) => {
      const source =
        video.currentSrc ||
        video.getAttribute("src") ||
        (video.querySelector("source") &&
          video.querySelector("source").getAttribute("src"));
      add("video", source, video.getAttribute("poster"));
    });
    node.querySelectorAll("source").forEach((source) => {
      const elementSource = source.getAttribute("src");
      if (isVideoUrl(elementSource)) add("video", elementSource);
    });

    // A player poster is not a separate slide. Prefer the actual video when
    // Reddit has exposed any playable source in the listing card.
    if (media.some((item) => item.kind === "video")) return media;

    // Old Reddit leaves its v.redd.it player as data attributes for its own
    // script to build, so a fetched post page has these URLs but no <video>.
    const oldRedditPlayer = node.querySelector(
      "[data-mpd-url], [data-hls-url]",
    );
    if (oldRedditPlayer) {
      const mpdUrl = absoluteUrl(oldRedditPlayer.getAttribute("data-mpd-url"));
      const hlsUrl = absoluteUrl(oldRedditPlayer.getAttribute("data-hls-url"));
      const seekPreviewUrl = absoluteUrl(
        oldRedditPlayer.getAttribute("data-seek-preview-url"),
      );
      // The MPD (with sound) needs the page's dash.js; see page-bridge.js.
      // url is what plays without it: native HLS keeps the sound, otherwise
      // the silent seek preview still beats a link card.
      const url =
        (canPlayHls() && hlsUrl) || seekPreviewUrl || hlsUrl || mpdUrl;
      const before = media.length;
      add("video", url, "", true);
      if (media.length > before && mpdUrl && mpdUrl !== url) {
        media[before].mpdUrl = mpdUrl;
      }
      if (media.length) return media;
    }

    // Prefer actual linked media to a listing thumbnail. Revealed embeds may
    // still be escaped markup when Reddit has not loaded its player component.
    if (isVideoUrl(sourceUrl)) add("video", sourceUrl, "", true);
    const external = externalMedia(sourceUrl);
    if (external) add(external.kind, external.url, "", true, external);
    function addFrame(iframe) {
      const url = absoluteUrl(iframe.getAttribute("src"));
      if (!/^https?:\/\//i.test(url)) return;
      const iframeMedia = externalMedia(url);
      if (iframeMedia)
        add(iframeMedia.kind, iframeMedia.url, "", true, iframeMedia);
    }
    node.querySelectorAll("iframe[src]").forEach(addFrame);
    node.querySelectorAll("shreddit-embed[html]").forEach((embed) => {
      // Read URLs only. Never mount Reddit's supplied HTML or run its scripts.
      const embedded = parseHtmlDocument(embed.getAttribute("html") || "");
      embedded.querySelectorAll("iframe[src]").forEach(addFrame);
    });
    if (media.length) return media;

    if (IMAGE_URL_RE.test(sourceUrl)) {
      // Prefer the post's original image over a second, lower-resolution
      // preview of the same image found inside the listing card.
      add("image", sourceUrl, "", true);
    } else {
      node
        .querySelectorAll(
          "gallery-carousel figure img:not([role='presentation']), faceplate-img[data-testid='search_post_thumbnail'], faceplate-img[src], faceplate-img[data-lazy-src], img[data-post-media-primary], img.preview-image, img:not([role='presentation'])",
        )
        .forEach((image) => {
          if (usefulImage(image)) add("image", imageUrl(image));
        });
    }

    return media;
  }

  function selectPostNodes(root) {
    const candidates = Array.from(root.querySelectorAll(POST_SELECTOR)).filter(
      (node) => {
        // Current Reddit wraps shreddit-post in a generic article. Prefer the
        // element that carries the actual post identity and metadata. In the
        // inverse shape (a specific search container wrapping an article), keep
        // the specific outer container.
        if (
          node.matches("article") &&
          node.querySelector(SPECIFIC_POST_SELECTOR)
        )
          return false;
        const specificParent = node.parentElement?.closest(
          SPECIFIC_POST_SELECTOR,
        );
        return !specificParent;
      },
    );
    if (candidates.length) return candidates;

    const nodes = [];
    const seen = new Set();
    root.querySelectorAll("a[href*='/comments/']").forEach((link) => {
      const node = link.closest("div, li");
      if (node && !seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    });
    return nodes;
  }

  function extractSlides(root) {
    const slides = [];
    const seenPostMedia = new Set();
    const seenPosts = new Set();
    selectPostNodes(root).forEach((node) => {
      if (node.closest("#redditp-presentation")) return;
      const comments = commentsUrl(node);
      const postKey =
        node.id ||
        node.getAttribute("data-fullname") ||
        trackingData(node).post?.id ||
        (comments.match(/\/comments\/([^/]+)/) || [])[1] ||
        "";
      // `article` is only a last-resort compatibility selector. Current
      // Reddit also uses it for unrelated sidebar cards and placeholders; do
      // not turn those into repeated generic "Reddit post" slides.
      const explicitPostNode = node.matches(
        "shreddit-post, .thing.link, .search-result.search-result-link, [data-id='search-media-post-unit'], [data-testid='search-post-unit'], [data-testid='post-container']",
      );
      if (!explicitPostNode && !postKey && !comments) return;
      if (postKey && seenPosts.has(postKey)) return;
      if (postKey) seenPosts.add(postKey);
      const source = contentUrl(node, comments);
      const base = {
        title: postTitle(node),
        body: postBodyText(node),
        author: postAuthor(node),
        community: postCommunity(node),
        commentsUrl: comments,
        sourceUrl: source,
        postKey,
        postNode: node,
      };
      const media = mediaFromNode(node, source);
      if (!media.length)
        media.push({ kind: "link", url: source || comments, poster: "" });
      const isGallery = isGalleryPost(node);
      const needsEnrichment =
        Boolean(comments) &&
        media.length <= 1 &&
        !isSinglePostPage() &&
        (Boolean(
          node.matches(
            "[data-testid='search-post-unit'], .search-result.search-result-link",
          ) &&
          (node.querySelector(
            "faceplate-img[data-testid='search_post_thumbnail']",
          ) ||
            media[0]?.kind === "link"),
        ) ||
          Boolean(
            node.getAttribute("post-type") === "link" &&
            media[0]?.kind === "image",
          ) ||
          // A card that carries no playable media at all may still have some:
          // Reddit's feed lazy-loads its players and gallery carousels, so
          // hosted-video and gallery posts can arrive without either. The
          // post page holds the real media; a genuine external link stays a
          // card after enrichment comes back empty.
          media[0]?.kind === "link");
      media.forEach((item, mediaIndex) => {
        const key = `${comments || base.title}|${item.url}`;
        if (!seenPostMedia.has(key)) {
          seenPostMedia.add(key);
          slides.push(
            Object.assign({}, base, item, {
              galleryItem: isGallery ? mediaIndex + 1 : 0,
              galleryTotal: isGallery ? media.length : 0,
              needsEnrichment,
            }),
          );
        }
      });
    });
    return slides;
  }

  async function fetchRedditDocument(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`Reddit returned ${response.status}`);
    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  // The HTML fetch is not guaranteed to describe the post: Reddit serves
  // challenge pages and hydration-only shells with a 200 status. Its JSON
  // endpoint answers with the same post's media fields instead, so it backs
  // up the DOM path for link, hosted-video, and gallery cards.
  function redditJsonUrl(url) {
    const [pathPart, queryPart = ""] = url.split("?");
    const base = pathPart.endsWith("/") ? pathPart : `${pathPart}/`;
    return `${base}.json${queryPart ? `?${queryPart}` : ""}`;
  }

  async function fetchRedditJson(url) {
    const response = await fetch(redditJsonUrl(url), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Reddit returned ${response.status}`);
    // A challenge page is still a 200 but HTML; parsing it rejects here.
    return await response.json();
  }

  // Reddit escapes ampersands in URLs stored in its JSON payloads.
  function unescapedUrl(value) {
    if (!value) return "";
    return absoluteUrl(String(value).replace(/&amp;/g, "&"));
  }

  function redditPostFromJson(payload) {
    const listings = Array.isArray(payload) ? payload : [payload];
    for (const listing of listings) {
      for (const child of listing?.data?.children || []) {
        if (child?.kind === "t3" && child.data) return child.data;
      }
    }
    return null;
  }

  function redditJsonPoster(data) {
    const images = data?.preview?.images;
    if (!images?.length) return "";
    const resolutions = images[0].resolutions || [];
    return unescapedUrl(
      resolutions[resolutions.length - 1]?.url || images[0].source?.url,
    );
  }

  function redditJsonVideoItem(data) {
    const video =
      data?.secure_media?.reddit_video ||
      data?.media?.reddit_video ||
      data?.preview?.reddit_video_preview;
    if (!video) return null;
    const dashUrl = unescapedUrl(video.dash_url);
    const hlsUrl = unescapedUrl(video.hls_url);
    const fallbackUrl = unescapedUrl(video.fallback_url);
    // Native HLS keeps the sound where it plays at all; elsewhere the DASH
    // fallback only offers a video track, so the page's dash.js (via
    // page-bridge.js) must join video and audio whenever the MPD is there.
    const url = (canPlayHls() && hlsUrl) || fallbackUrl || hlsUrl;
    if (!url) return null;
    return {
      kind: "video",
      url,
      poster: redditJsonPoster(data),
      postMedia: true,
      mpdUrl: dashUrl && dashUrl !== url ? dashUrl : "",
    };
  }

  // One media_metadata entry for one gallery item, in gallery_data order.
  function redditJsonGalleryItem(entry) {
    if (!entry || entry.status !== "valid") return null;
    const source = entry.s || {};
    if (entry.e === "Image" || entry.e === "AnimatedImage") {
      // Animated images publish an mp4 variant that actually loops in every
      // browser; a plain gif may crawl in Chromium and Safari shows it fine
      // either way, so mp4 first, source image second.
      const animated = unescapedUrl(source.mp4 || source.gif);
      if (animated)
        return { kind: "video", url: animated, poster: "", postMedia: true };
      const url = unescapedUrl(source.u);
      return url ? { kind: "image", url, poster: "", postMedia: true } : null;
    }
    if (entry.e === "Video") {
      const dashUrl = unescapedUrl(source.dash_url);
      const hlsUrl = unescapedUrl(source.hls_url);
      const fallbackUrl = unescapedUrl(source.fallback_url);
      const url = (canPlayHls() && hlsUrl) || fallbackUrl || hlsUrl;
      return url
        ? {
            kind: "video",
            url,
            poster: "",
            postMedia: true,
            mpdUrl: dashUrl && dashUrl !== url ? dashUrl : "",
          }
        : null;
    }
    return null;
  }

  function redditJsonGalleryItems(data) {
    const items = data?.gallery_data?.items;
    const metadata = data?.media_metadata;
    if (!items?.length || !metadata) return null;
    const media = [];
    for (const item of items) {
      const resolved = redditJsonGalleryItem(metadata[item.media_id]);
      if (resolved) media.push(resolved);
    }
    return media.length ? media : null;
  }

  function redditJsonImageItem(data) {
    const dest = unescapedUrl(data?.url_overridden_by_dest || data?.url);
    if (!dest) return null;
    if (/\.gif(?:$|[?#])/i.test(dest)) {
      // A gif synthesised from a still image; Reddit publishes its playing
      // mp4 rendition beside it.
      const mp4 = unescapedUrl(
        data?.preview?.images?.[0]?.variants?.mp4?.source?.url,
      );
      return mp4
        ? { kind: "video", url: mp4, poster: "", postMedia: true }
        : null;
    }
    if (IMAGE_URL_RE.test(dest)) {
      return { kind: "image", url: dest, poster: "", postMedia: true };
    }
    if ((data?.post_hint || "").toLowerCase() === "image") {
      // No extension to check on, but Reddit says this post is an image; its
      // preview carries the original resolution.
      const source = unescapedUrl(data?.preview?.images?.[0]?.source?.url);
      return source
        ? { kind: "image", url: source, poster: "", postMedia: true }
        : null;
    }
    return null;
  }

  // Media and body from a post listing's JSON. Returns null when the post is
  // not recognised; an empty items list with a body stands for a text post.
  function mediaFromRedditJson(payload) {
    const post = redditPostFromJson(payload);
    if (!post) return null;
    const items = [];
    const galleryItems = redditJsonGalleryItems(post);
    if (galleryItems) items.push(...galleryItems);
    else {
      const videoItem = redditJsonVideoItem(post);
      if (videoItem) items.push(videoItem);
      const imageItem = redditJsonImageItem(post);
      if (imageItem) items.push(imageItem);
    }
    const body = String(post.selftext || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    const sourceUrl = unescapedUrl(post.url_overridden_by_dest || post.url);
    if (!items.length && !body) return null;
    return {
      items: items.length ? items : [{}],
      body,
      sourceUrl: sourceUrl || "",
      isGallery: Boolean(galleryItems && galleryItems.length),
    };
  }

  // Old Reddit listings and search results page with a "next ›" link instead
  // of infinite scroll. Listings wrap the link in .next-button and search
  // results do not, so match on rel. A search page can list communities above
  // the posts, so the posts' link is the last one.
  function nextPageUrl(root) {
    const links = root.querySelectorAll(".nav-buttons a[rel~='next'][href]");
    const link = links[links.length - 1];
    if (!link) return "";
    // The page is fetched with the user's session, so never follow it off the
    // Reddit origin being presented.
    const url = absoluteUrl(link.getAttribute("href"));
    return url && new URL(url).origin === location.origin ? url : "";
  }

  function finishEnrichment(slide, key, detail) {
    const replacements = detail.items.map((item, index) =>
      Object.assign({}, slide, item, {
        body: detail.body || slide.body,
        sourceUrl: detail.sourceUrl || slide.sourceUrl,
        galleryItem: detail.isGallery ? index + 1 : 0,
        galleryTotal: detail.isGallery ? detail.items.length : 0,
        needsEnrichment: false,
      }),
    );

    const slideIndex = state.slides.findIndex(
      (candidate) =>
        candidate.needsEnrichment &&
        (candidate.postKey || candidate.commentsUrl) === key,
    );
    if (slideIndex < 0) return;
    const wasCurrent = state.index === slideIndex;
    if (slideIndex < state.index) {
      state.index += replacements.length - 1;
    }
    state.slides.splice(slideIndex, 1, ...replacements);
    state.enrichments.set(key, "done");
    if (wasCurrent && state.open) {
      state.index = slideIndex;
      render();
    }
  }

  async function enrichSlide(slide) {
    if (!slide.needsEnrichment || !slide.commentsUrl) return;
    const key = slide.postKey || slide.commentsUrl;
    if (state.enrichments.has(key)) return;
    state.enrichments.set(key, "pending");

    try {
      let detail;
      try {
        const doc = await fetchRedditDocument(slide.commentsUrl);
        const safePostKey = /^[\w-]+$/.test(slide.postKey || "")
          ? slide.postKey
          : "";
        const detailNode =
          (safePostKey &&
            doc.querySelector(`shreddit-post[id="${safePostKey}"]`)) ||
          doc.querySelector("shreddit-post, .thing.link");
        if (!detailNode)
          throw new Error("Post media was not present in the response");

        const detailSource = contentUrl(detailNode, slide.commentsUrl);
        const detailMedia = mediaFromNode(detailNode, detailSource);
        // Search cards carry only a title, so a text post's body is worth the
        // fetch even when the post has no media; it then stays a link card.
        const detailBody = postBodyText(detailNode);
        if (!detailMedia.length && !detailBody)
          throw new Error("Post had no supported media");
        detail = {
          items: detailMedia.length ? detailMedia : [{}],
          body: detailBody,
          sourceUrl: detailSource || slide.sourceUrl,
          isGallery: isGalleryPost(detailNode),
        };
      } catch (htmlError) {
        // The HTML fetch can succeed with a 200 and still hold nothing:
        // Reddit serves challenges and hydration-only shells that way. The
        // JSON endpoint answers for the same post from the same origin.
        let jsonDetail = null;
        try {
          jsonDetail = mediaFromRedditJson(
            await fetchRedditJson(slide.commentsUrl),
          );
        } catch (_jsonError) {
          // A challenge page can come back over JSON too; treat it as no
          // detail so the HTML error decides the outcome.
          jsonDetail = null;
        }
        if (!jsonDetail) throw htmlError;
        detail = jsonDetail;
      }
      finishEnrichment(slide, key, detail);
    } catch (_error) {
      // Keep the visible thumbnail/link card and allow another attempt if the
      // user revisits this slide. Reddit may return a challenge or gated page.
      state.enrichments.delete(key);
      // Swap the card in place: a render() would start another fetch at once.
      const current = state.slides[state.index];
      const loadingCard = mediaBox.querySelector(
        ".redditp__link-card--loading",
      );
      if (
        state.open &&
        loadingCard &&
        current &&
        (current.postKey || current.commentsUrl) === key
      ) {
        loadingCard.replaceWith(linkCard(current, false, false));
      }
    }
  }

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text) result.textContent = text;
    return result;
  }

  // Inert HTML parsing: DOMParser never runs scripts and never loads
  // resources, so untrusted markup can be queried safely without ever
  // mounting it into the live document. Used instead of assigning to a
  // detached element's innerHTML, which AMO lint flags as advisory risk.
  function parseHtmlDocument(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Replaces the target's content with the root element of static SVG
  // markup. Identical DOM to the innerHTML assignment it replaces. The
  // markup must come from the code's own constants, never from Reddit or
  // the page; untrusted HTML only ever goes through parseHtmlDocument.
  function setSvgMarkup(target, markup) {
    const doc = parseHtmlDocument(markup);
    const imported = document.importNode(doc.body.firstElementChild, true);
    target.replaceChildren(imported);
  }

  function normalizedSettings(value) {
    const result = Object.assign({}, DEFAULT_SETTINGS);
    if (!value || typeof value !== "object") return result;
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      if (key === "slideDurationSeconds") {
        const seconds = Number(value[key]);
        if (Number.isFinite(seconds)) {
          result[key] = Math.min(3600, Math.max(1, Math.round(seconds)));
        }
      } else if (typeof value[key] === "boolean") {
        result[key] = value[key];
      } else if (key === "preloadPosts" || key === "preloadConcurrency") {
        const numeric = Number(value[key]);
        if (Number.isFinite(numeric)) {
          result[key] = Math.min(
            key === "preloadPosts" ? 10 : 6,
            Math.max(1, Math.round(numeric)),
          );
        }
      } else if (key === "mediaMode") {
        // An outdated or corrupt stored value must not strand the viewer in
        // a mode it cannot reason about; fall back to the default instead.
        if (MEDIA_MODE_KEYS.includes(value[key])) result[key] = value[key];
      } else if (key === "transitionAnimation") {
        // Same rule for the transition setting: an unknown stored name (an
        // older version, a future rename, corrupt data) falls back to the
        // shipped default of an immediate media swap without animation.
        if (TRANSITION_ANIMATION_KEYS.includes(value[key])) {
          result[key] = value[key];
        }
      }
    });
    // Before 2026-09 this was stored inverted as `controlsCollapsed`.
    if (
      typeof value.showControls !== "boolean" &&
      typeof value.controlsCollapsed === "boolean"
    ) {
      result.showControls = !value.controlsCollapsed;
    }
    return result;
  }

  function loadSettings() {
    if (state.settingsLoaded) return Promise.resolve();
    return new Promise((resolve) => {
      function finish(value) {
        state.settings = normalizedSettings(value);
        state.settingsLoaded = true;
        resolve();
      }
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          chrome.storage.local.get(SETTINGS_KEY, (stored) => {
            if (chrome.runtime?.lastError) finish(null);
            else finish(stored?.[SETTINGS_KEY]);
          });
          return;
        }
        finish(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"));
      } catch (_error) {
        finish(null);
      }
    });
  }

  function saveSettings() {
    const stored = Object.assign({}, state.settings);
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ [SETTINGS_KEY]: stored }, () => {
          void chrome.runtime?.lastError;
        });
      } else {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
      }
    } catch (_error) {
      // Settings remain active for this presentation if storage is blocked.
    }
  }

  const root = element("section", "redditp", "");
  root.id = "redditp-presentation";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "RedditPix presentation mode");
  root.hidden = true;

  const stage = element("div", "redditp__stage", "");
  const mediaBox = element("div", "redditp__media", "");
  // Slide transitions (new): during a transition the outgoing media has to
  // outlive the immediate media swap, so the previous image is parked here
  // with its exact on-screen geometry until its exit animation ends. The
  // real element moves, not a copy — no duplicate requests, no reload —
  // and its inline style attribute is restored when the bar is released.
  const transitionGhost = element("div", "redditp__ghost", "");
  transitionGhost.setAttribute("aria-hidden", "true");
  const empty = element("div", "redditp__empty", "");
  const emptyTitle = element("h2", "", "No posts found on this page");
  const emptyText = element(
    "p",
    "",
    "Scroll Reddit to load some posts, then try presentation mode again.",
  );
  empty.append(emptyTitle, emptyText);
  stage.append(mediaBox, empty, transitionGhost);

  const count = element("div", "redditp__count", "");
  const numberBar = element("nav", "redditp__numbers", "");
  numberBar.setAttribute("aria-label", "Post navigation");
  // Media mode (Part C): one compact cycling control in the bottom control
  // row. The cycle is images+videos → images → videos → back.
  const mediaModeButton = element(
    "button",
    "redditp__button redditp__media-mode",
    "",
  );
  mediaModeButton.type = "button";
  const closeButton = element("button", "redditp__button redditp__close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close presentation mode");
  closeButton.title = "Close presentation mode (Esc)";
  const settingsButton = element(
    "button",
    "redditp__button redditp__settings-button redditp__control-item",
    "",
  );
  settingsButton.type = "button";
  setSvgMarkup(
    settingsButton,
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  );
  settingsButton.setAttribute("aria-label", "Open presentation settings");
  settingsButton.title = "Settings";
  const rotateButton = element(
    "button",
    "redditp__button redditp__rotate redditp__control-item",
    "",
  );
  rotateButton.type = "button";
  rotateButton.setAttribute("aria-label", "Rotate viewer");
  rotateButton.title = "Rotate viewer (R)";
  setSvgMarkup(
    rotateButton,
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  );
  const hideButton = element(
    "button",
    "redditp__button redditp__hide redditp__control-item",
    "",
  );
  hideButton.type = "button";
  hideButton.setAttribute("aria-label", "Hide interface");
  hideButton.title = "Hide interface (H)";
  setSvgMarkup(
    hideButton,
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.442 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>',
  );
  const fullscreenButton = element(
    "button",
    "redditp__button redditp__fullscreen redditp__control-item",
    "",
  );
  setSvgMarkup(
    fullscreenButton,
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  );
  fullscreenButton.type = "button";
  fullscreenButton.setAttribute("aria-label", "Enter fullscreen");
  fullscreenButton.title = "Toggle fullscreen (F)";
  const details = element("div", "redditp__details", "");
  const title = element("h1", "redditp__title", "");
  const meta = element("div", "redditp__meta", "");
  details.append(title, meta);

  // Phase 4 header redesign: one viewer header groups the title panel and
  // the action chips into a single component (title/metadata on the left,
  // buttons in one cluster on the right). This is a DOM move only — every
  // element keeps its class, its event handlers, and its hidden-state
  // toggles, so syncPresentationUi, the keyboard handler, and every test
  // selector keep working unchanged; all layout and states are CSS.
  const headerActions = element("div", "redditp__header-actions", "");
  // The order is the product UI order and is identical at every breakpoint:
  // exit → rotate/reload → settings → fullscreen → hide. The close chip
  // leads so the shared DOM order needs no CSS `order` overrides; each
  // breakpoint styles the same one row.
  headerActions.append(
    closeButton,
    rotateButton,
    settingsButton,
    fullscreenButton,
    hideButton,
  );
  const header = element("header", "redditp__header", "");
  header.append(details, headerActions);

  const controls = element("nav", "redditp__controls", "");
  controls.setAttribute("aria-label", "Slideshow controls");
  const prevButton = element("button", "redditp__arrow redditp__prev", "‹");
  prevButton.setAttribute("aria-label", "Previous slide");
  prevButton.title = "Previous slide (←)";
  const autoButton = element("button", "redditp__auto", "");
  autoButton.title = "Advance slides automatically (A)";
  // Insert a play SVG icon for the stopped state.
  const playSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const pauseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  setSvgMarkup(autoButton, playSvg);
  // Accessible name is set when state changes; initial text hidden but accessible.
  autoButton.setAttribute("aria-label", "Start slideshow");
  const nextButton = element("button", "redditp__arrow redditp__next", "›");

  nextButton.setAttribute("aria-label", "Next slide");
  nextButton.title = "Next slide (→)";
  prevButton.type =
    settingsButton.type =
    autoButton.type =
    hideButton.type =
    fullscreenButton.type =
      "button";
  // The bottom navigation is one row: the count chip stays fixed on the
  // left while the auto toggle and the numbered post buttons scroll inside
  // the numbered track. Sliding the track into the controls nav keeps the
  // row's children on a shared flex line without overlapping the media.
  controls.append(count, numberBar);

  const settingsOverlay = element("div", "redditp__settings-overlay", "");
  settingsOverlay.hidden = true;
  const settingsPanel = element("section", "redditp__settings", "");
  settingsPanel.setAttribute("role", "dialog");
  settingsPanel.setAttribute("aria-modal", "true");
  settingsPanel.setAttribute("aria-labelledby", "redditp-settings-title");
  const settingsTitle = element("h2", "", "Presentation settings");
  settingsTitle.id = "redditp-settings-title";
  const settingsClose = element("button", "redditp__settings-close", "Done");
  settingsClose.type = "button";
  settingsClose.setAttribute("aria-label", "Close presentation settings");
  const durationLabel = element(
    "label",
    "redditp__setting redditp__setting--duration",
    "",
  );
  const durationText = element("span", "", "Time per slide");
  const durationControl = element("span", "redditp__duration-control", "");
  const durationInput = element("input", "", "");
  durationInput.type = "number";
  durationInput.min = "1";
  durationInput.max = "3600";
  durationInput.step = "1";
  durationInput.setAttribute("aria-label", "Seconds per slide");
  durationControl.append(durationInput, element("span", "", "seconds"));
  durationLabel.append(durationText, durationControl);

  // Slide transition animation (new): one select in the settings panel,
  // persisted like every other setting. A native select keeps keyboard and
  // touch behavior free of custom code, and the viewer's arrow-key handler
  // already ignores focus inside settings, so a focused select never
  // navigates the slideshow.
  const transitionLabel = element(
    "label",
    "redditp__setting redditp__setting--transition",
    "",
  );
  const transitionText = element("span", "", "Transition animation");
  const transitionControl = element("span", "redditp__transition-control", "");
  const transitionSelect = element("select", "", "");
  transitionSelect.setAttribute("aria-label", "Slide transition animation");
  transitionSelect.dataset.setting = "transitionAnimation";
  TRANSITION_ANIMATION_KEYS.forEach((key) => {
    const option = element("option", "", "");
    option.value = key;
    option.textContent = TRANSITION_ANIMATION_LABELS[key];
    transitionSelect.append(option);
  });
  transitionControl.append(transitionSelect);
  transitionLabel.append(transitionText, transitionControl);

  const settingCheckboxes = {};
  function checkboxSetting(key, labelText) {
    const label = element("label", "redditp__setting", "");
    const input = element("input", "", "");
    input.type = "checkbox";
    input.dataset.setting = key;
    settingCheckboxes[key] = input;
    label.append(input, element("span", "", labelText));
    return label;
  }

  const shortcutHelp = element("section", "redditp__shortcuts", "");
  shortcutHelp.setAttribute("aria-labelledby", "redditp-shortcuts-title");
  const shortcutTitle = element("h3", "", "Keyboard shortcuts");
  shortcutTitle.id = "redditp-shortcuts-title";
  const shortcutList = element("dl", "", "");
  [
    [["→", "PgDn", "Space"], "Next slide"],
    [["←", "PgUp"], "Previous slide"],
    [["F"], "Toggle fullscreen (if available)"],
    [["H"], "Hide / show the interface"],
    [["M"], "Toggle video sound"],
    [["T"], "Show / hide the title panel"],
    [["P"], "Show / hide the bottom-left controls"],
    [["C"], "Open comments in a new tab"],
    [["I"], "Open the original media in a new tab"],
    [["A"], "Toggle auto-advance"],
    [["Esc"], "Close settings / slideshow"],
    [["Tab", "Shift+Tab"], "Next / previous control"],
    [["Alt+P"], "Toggle presentation (default)"],
  ].forEach(([keys, description]) => {
    const keyGroup = element("dt", "", "");
    keys.forEach((key) => keyGroup.append(element("kbd", "", key)));
    shortcutList.append(keyGroup, element("dd", "", description));
  });
  shortcutHelp.append(
    shortcutTitle,
    shortcutList,
    element(
      "p",
      "",
      "Close settings to use slide shortcuts. Your browser’s shortcuts still work.",
    ),
  );

  settingsPanel.append(
    settingsTitle,
    settingsClose,
    durationLabel,
    transitionLabel,
    checkboxSetting("finishMediaOnce", "Let videos play at least once"),
    checkboxSetting("loopShortMedia", "Loop short videos until the timer ends"),
    element(
      "p",
      "redditp__setting-hint",
      "Includes GIFs played as videos. Animated images and other embedded players use the slide timer.",
    ),
    checkboxSetting("showDetails", "Show the title panel"),
    checkboxSetting("showArrows", "Show previous and next arrows"),
    checkboxSetting(
      "showClose",
      "Show the close button (press Esc instead when hidden)",
    ),
    checkboxSetting("showControls", "Show the bottom panel"),
    checkboxSetting("tapZones", "Enable tap zones"),
    checkboxSetting("swipeNavigation", "Enable swipe navigation"),
    checkboxSetting("startHidden", "Start with interface hidden"),
    checkboxSetting("startFullscreen", "Start in fullscreen where supported"),
    shortcutHelp,
  );
  settingsOverlay.append(settingsPanel);
  root.append(
    stage,
    prevButton,
    nextButton,
    header,
    controls,
    settingsOverlay,
  );
  controls.insertBefore(mediaModeButton, count);

  // Drops the preload-cache entry for a video whose DASH player was just
  // released on the way out of the display (stopMedia). The displayed
  // element IS the cached element, and once the bridge mark is gone the
  // entry can never be recognized as prepared again — while still holding
  // a video-budget slot. Dropping it keeps the budget honest and lets the
  // scheduler re-prepare the slide while it stays within range, so a step
  // back finds a live attached player instead of a fresh attach.
  function dropPreparedDashEntry(video) {
    for (const [key, entry] of Array.from(state.preloadCache)) {
      if (entry !== video) continue;
      state.preloadCache.delete(key);
      state.preloadRetry.delete(key);
      state.preloadStats.dashReleased += 1;
      debugLogEvent("preload-invalidated", { key, reason: "dash-released" });
      break;
    }
    schedulePreloadQueue();
  }

  function stopMedia() {
    untrackMedia();
    const redgifsSlide = state.redgifsEmbedSlide;
    state.redgifsEmbedSlide = null;
    if (redgifsSlide) resetRedgifsCompletion(redgifsSlide);
    mediaBox.querySelectorAll("video").forEach((video) => {
      const wasPreparedDASH =
        video.getAttribute("data-redditp-dash") === "attached";
      releaseRedditDash(video);
      if (wasPreparedDASH) dropPreparedDashEntry(video);
      video.pause();
      const restore = state.nativeRestores.get(video);
      if (!restore) return;
      if (restore.className === null) video.removeAttribute("class");
      else video.setAttribute("class", restore.className);
      if (restore.style === null) video.removeAttribute("style");
      else video.setAttribute("style", restore.style);
      video.controls = restore.controls;
      video.muted = restore.muted;
      video.loop = restore.loop;
      video.autoplay = restore.autoplay;
      if (restore.placeholder.isConnected) {
        restore.placeholder.replaceWith(video);
      }
      state.nativeRestores.delete(video);
    });
    mediaBox.replaceChildren();
  }

  // loading: the post page is being fetched for this card's real media or
  // text, so say so instead of looking like a dead end.
  function linkCard(slide, failed, loading) {
    const card = element("a", "redditp__link-card", "");
    card.href = slide.sourceUrl || slide.commentsUrl;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    if (loading) {
      card.classList.add("redditp__link-card--loading");
      card.setAttribute("aria-busy", "true");
    }
    card.append(
      element(
        "span",
        "redditp__link-icon",
        failed
          ? "Image unavailable"
          : loading
            ? /^https:\/\/v\.redd\.it\//i.test(slide.sourceUrl || "")
              ? "Loading video…"
              : "Loading post…"
            : slide.body
              ? "Text post"
              : "Open linked post",
      ),
      element("strong", "", slide.title),
    );
    if (slide.body) {
      card.append(element("div", "redditp__post-body", slide.body));
    }
    card.append(element("span", "", slide.sourceUrl || slide.commentsUrl));
    return card;
  }

  async function upgradePendingAdaptiveSlide(slide) {
    if (
      slide.kind !== "pending-native-video" ||
      !slide.playerElement ||
      slide.adaptiveUpgrade === "pending"
    )
      return;
    slide.adaptiveUpgrade = "pending";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!slide.adaptiveStartRequested) {
        slide.adaptiveStartRequested = requestPlayerStart(slide.playerElement);
      }
      const nativeVideo = adaptiveBlobVideo(slide.playerElement);
      if (nativeVideo) {
        slide.kind = "native-video";
        slide.nativeElement = nativeVideo;
        slide.adaptiveUpgrade = "done";
        if (state.open && state.slides[state.index] === slide) render();
        return;
      }
      await wait(100);
    }
    slide.kind = "link";
    slide.adaptiveUpgrade = "failed";
    if (state.open && state.slides[state.index] === slide) render();
  }

  // The page's bridge runs in the page world and answers a handshake only
  // through DOM events that travel along the DOM tree. An element detached
  // from the document propagates nothing, so a speculatively prepared video
  // briefly joins a hidden container for the synchronous attach (and for
  // the later reset) and then returns to the cache detached.
  let dashHandshakeBox = null;

  // Bumped at the start of every render. Late media events (a superseded
  // video's loadeddata, an abort error arriving after the stage already
  // moved on) carry the generation they belong to, so they can only clear
  // the loading state that render created — never a newer one's loader.
  let renderGeneration = 0;

  // Single-slot watchdog for the element currently on stage; cleared at
  // every render and on every readiness signal (see armDisplayWatchdog).
  let displayWatchdog = null;

  function clearDisplayWatchdog() {
    if (displayWatchdog) {
      clearTimeout(displayWatchdog);
      displayWatchdog = null;
    }
  }

  function dispatchRedditDashEvent(video, type) {
    if (video.isConnected) {
      video.dispatchEvent(new Event(type, { bubbles: true }));
      return;
    }
    // The handshake is synchronous; the element needs to be connected only
    // for the duration of the dispatch. Hidden, source-free, so nothing is
    // fetched, laid out, or played while it is in the container.
    if (!dashHandshakeBox || !dashHandshakeBox.isConnected) {
      dashHandshakeBox = document.createElement("div");
      dashHandshakeBox.hidden = true;
      document.documentElement.append(dashHandshakeBox);
    }
    dashHandshakeBox.append(video);
    video.dispatchEvent(new Event(type, { bubbles: true }));
    video.remove();
  }

  // The bridge protocol core (see page-bridge.js). Dispatches the attach
  // event and reports whether the page's dash.js claimed the element.
  function attachRedditDashSource(video, mpdUrl) {
    video.setAttribute("data-redditp-mpd", mpdUrl);
    dispatchRedditDashEvent(video, "redditp:dash-attach");
    return video.getAttribute("data-redditp-dash") === "attached";
  }

  // v.redd.it serves video and audio as separate DASH tracks. Old Reddit
  // already loads dash.js to join them, and page-bridge.js (running in the
  // page's world) attaches it to our element. DOM events reach the bridge
  // synchronously, so its answer is on the element when dispatchEvent returns.
  function attachRedditDash(video, slide) {
    if (!attachRedditDashSource(video, slide.mpdUrl)) return false;
    video.addEventListener(
      "redditp:dash-failed",
      () => playVideoFallback(video, slide),
      { once: true },
    );
    video.addEventListener("loadedmetadata", () => playVideo(video), {
      once: true,
    });
    return true;
  }

  function releaseRedditDash(video) {
    if (video.getAttribute("data-redditp-dash") !== "attached") return;
    dispatchRedditDashEvent(video, "redditp:dash-reset");
    video.removeAttribute("data-redditp-dash");
  }

  function playVideoFallback(video, slide) {
    if (video.parentNode !== mediaBox) return;
    // RedGIFs video failed with its resolved URL. One bounded re-resolution
    // is allowed; beyond that the host's embed player (the pre-existing
    // display for these posts) takes over for this display.
    if (slide?.redgifsId) {
      void redgifsDisplayRecovery(video, slide);
      return;
    }
    if (video.redditpPlayingFallback) {
      showMediaFailure(video, slide);
      return;
    }
    video.redditpPlayingFallback = true;
    releaseRedditDash(video);
    video.src = slide.url;
    playVideo(video);
  }

  // Bounded RedGIFs play-failure recovery: re-resolve once per display, then
  // commit to the embed fallback. A resolution that answers the same URL the
  // element already failed with cannot produce pixels either, so it counts
  // as the failure it is. Stale navigations never act on the old media box.
  function redgifsDisplayRecovery(video, slide) {
    if (slide.redgifsRefreshed) {
      showRedgifsEmbedFallback(video, slide);
      return;
    }
    slide.redgifsRefreshed = true;
    void resolveRedgifsMedia(slide.redgifsId, true).then((result) => {
      if (
        video.parentNode !== mediaBox ||
        state.slides[state.index] !== slide
      ) {
        return;
      }
      if (!result.ok || result.url === slide.url) {
        showRedgifsEmbedFallback(video, slide);
        return;
      }
      slide.url = result.url;
      video.src = result.url;
      playVideo(video);
    });
  }

  function showRedgifsEmbedFallback(video, slide) {
    slide.redgifsFallback = true;
    debugLogEvent("redgifs-fallback", mediaPreloadKey(slide));
    if (
      state.open &&
      state.slides[state.index] === slide &&
      video.parentNode === mediaBox
    ) {
      mediaBox.replaceChildren(embedElement(slide));
    }
  }

  // One place builds the host's player frame, so the embed slide and the
  // RedGIFs fallback below cannot drift apart.
  function embedElement(slide) {
    if (slide.redgifsId) {
      resetRedgifsCompletion(slide);
      state.redgifsEmbedSlide = slide;
    }
    const iframe = element("iframe", "redditp__embed", "");
    iframe.title = slide.title;
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.addEventListener("load", () => initializeEmbed(iframe));
    // An upgraded RedGIFs slide keeps its original /ifr player URL beside
    // the resolved direct one; the fallback must use it, not the stream.
    iframe.src = embedUrl(
      slide.redgifsEmbedUrl || slide.url,
      !state.settings.sound,
    );
    return iframe;
  }

  function showMediaFailure(mediaElement, slide) {
    if (
      state.open &&
      state.slides[state.index] === slide &&
      mediaElement.parentNode === mediaBox
    ) {
      mediaBox.replaceChildren(linkCard(slide, true));
      slide.mediaFailed = true;
      scheduleAuto();
    }
  }

  function expandLargeImage(image, slide) {
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    const shortEdge = Math.min(image.naturalWidth, image.naturalHeight);
    // The post's own image is the whole point of the slide, so it fills the
    // stage at any size. The size gate only holds back preview images scraped
    // from a card for a post that links elsewhere, which are often far smaller
    // than the media they stand in for.
    image.classList.toggle(
      "redditp__image--expand",
      Boolean(slide?.postMedia) ||
        (longEdge >= MIN_EXPAND_IMAGE_LONG_EDGE &&
          shortEdge >= MIN_EXPAND_IMAGE_SHORT_EDGE),
    );
  }

  // Bring the active number button into view by scrolling ONLY the numbered
  // track. Element.scrollIntoView() scrolls *every* scrollable ancestor, and
  // an ancestor with `overflow: hidden` still counts as programmatically
  // scrollable — so a wide numbered bar used to drag the whole viewer
  // sideways with every rapid Arrow key press. Setting the track's own
  // scroll position keeps the viewer anchored to the viewport no matter how
  // the track is laid out.  //
  // Narrow (mobile) screens center the active chip so navigation reads as a
  // carousel; desktop keeps the original edge-anchoring, which only moves
  // the track when the button would otherwise clip. Smooth scrolling is
  // skipped when the OS asks for reduced motion.
  let numberTrackAnchor = null; // { track, target, startedAt }
  function scrollNumberTrackTo(button) {
    const track = button.parentElement;
    if (!track) return;
    const maxScroll = track.scrollWidth - track.clientWidth;
    if (maxScroll <= 0) return;
    const trackLeft = track.getBoundingClientRect().left;
    const rect = button.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    const padRight = parseFloat(getComputedStyle(track).paddingRight) || 0;
    // The chip's offsets in track-content coordinates are scroll-invariant
    // (rect deltas cancel the live scroll position), so they are exact even
    // while a smooth scroll is mid-flight. The clip decision, though, must
    // judge where the track will COME TO REST: a smooth scroll started by an
    // earlier resize or navigation may still be running, and judging its
    // transient scrollLeft can read the active chip as visible right before
    // that animation carries it off-track (a rapid resize + reselect could
    // then leave the active number permanently out of view). The bookkeeping
    // below remembers the last issued target per track, which is exactly the
    // resting position the pending animation converges to.
    const contentLeft = rect.left - trackLeft + track.scrollLeft;
    const contentRight = rect.right - trackLeft + track.scrollLeft;
    const center = window.matchMedia("(max-width: 600px)").matches;
    let left;
    if (center) {
      left = contentLeft - (track.clientWidth - rect.width) / 2;
    } else {
      const pending =
        numberTrackAnchor &&
        numberTrackAnchor.track === track &&
        performance.now() - numberTrackAnchor.startedAt < 800
          ? numberTrackAnchor.target
          : track.scrollLeft;
      if (contentLeft < pending) {
        left = contentLeft - padLeft;
      } else if (contentRight > pending + track.clientWidth) {
        left = contentRight - track.clientWidth + padRight;
      } else {
        return;
      }
    }
    left = Math.max(0, Math.min(maxScroll, left));
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // Both anchoring modes share the same smooth scroll now: mobile centers
    // the active chip, desktop only scrolls far enough to unclip it, but a
    // repositioning that does happen glides instead of jumping. Reduced
    // motion (or engines without scrollTo options) keeps the instant jump.
    if (!reduceMotion && typeof track.scrollTo === "function") {
      numberTrackAnchor = {
        track,
        target: left,
        startedAt: performance.now(),
      };
      track.scrollTo({ left, behavior: "smooth" });
    } else {
      numberTrackAnchor = null;
      track.scrollLeft = left;
    }
  }

  function syncPresentationUi() {
    const hasSlides = state.slides.length > 0;
    const hasVisible = hasSlides && hasVisibleSlides();
    if (hasSlides && !hasVisible) {
      // The current mode matches nothing the feed currently holds: an
      // explicit no-matching-media state instead of a stale frame.
      const mode = currentMediaMode();
      emptyTitle.textContent =
        mode === "videos"
          ? "No videos match the media filter"
          : mode === "images"
            ? "No images match the media filter"
            : "No media matches the current filter";
      emptyText.textContent =
        "No picture slides to show for the current media mode. Switch modes or keep scrolling; posts that arrive later appear here.";
    }
    empty.hidden = !hasSlides || hasVisible;
    // The title panel intentionally stays in the header layout while the
    // interface is hidden: the `.redditp__interface-hidden` CSS rules
    // reclaim it invisibly (opacity + visibility), while removing it here
    // would collapse its flex space and slide the chip cluster — including
    // the eye toggle — across the screen on every hide/show flip.
    details.hidden = !hasSlides || !hasVisible || !state.settings.showDetails;
    meta.hidden = true;
    // The bottom-nav row itself follows the interface's visibility. In the
    // no-matching-media stage the row survives with only the media-mode
    // chip visible: the chip is the way back to a workable mode, hiding it
    // would strand the viewer in a state only a restart could fix. The
    // count chip specifically also keeps the compact-controls behavior of
    // old (`P` hides the count and the numbered buttons but never the auto
    // toggle, which stays reachable).
    controls.hidden = !hasSlides || state.interfaceHidden;
    count.hidden =
      !hasSlides ||
      !hasVisible ||
      state.interfaceHidden ||
      !state.settings.showControls;
    settingsButton.hidden = !state.settings.showControls;
    prevButton.hidden = nextButton.hidden =
      !hasSlides || !hasVisible || !state.settings.showArrows;
    prevButton.disabled = !hasSlides || state.index === 0;
    nextButton.disabled =
      !hasSlides ||
      (isSinglePostPage() && state.index === state.slides.length - 1);
    closeButton.hidden = !state.settings.showClose;
    updateCount(state.loadingMore && isOnLastEligiblePost());
    const starts = [];
    let previous = null;
    state.slides.forEach((item, index) => {
      // Numbering follows the count chip: duration-excluded posts keep their
      // number (5A feed semantics) while media-mode-excluded kinds take none.
      if (!slideMediaModeEligible(item)) return;
      const identity = postIdentity(item);
      if (identity !== previous) starts.push(index);
      previous = identity;
    });
    let currentPost = 1;
    starts.forEach((startIndex, i) => {
      if (state.index >= startIndex) currentPost = i + 1;
    });
    // The numbered bar rebuild was the only O(posts) DOM churn on every
    // render (every navigation, resize, settings update). The buttons only
    // change when the identity sequence of starts changes — plain post
    // navigation, mode syncs, and resizes merely move the active mark —
    // so reuse the row and flip classes in that case. Entries appended at
    // the end (or an enrichment expansion) change the starts sequence and
    // trigger a real rebuild, keeping every closure's startIndex exact.
    const startsSignature = starts.join("|");
    if (numberBar.dataset.redditpStarts !== startsSignature) {
      numberBar.dataset.redditpStarts = startsSignature;
      numberBar.replaceChildren();
      // The auto-advance toggle lives in the same bottom strip as the
      // numbered post buttons, ahead of them.
      numberBar.append(autoButton);
      starts.forEach((startIndex, i) => {
        const button = element("button", "redditp__number", String(i + 1));
        button.type = "button";
        button.setAttribute("aria-label", `Post ${i + 1}`);
        // Numbered navigation keeps the feed-based numbering but honours the
        // duration policy: an excluded post is skipped in the same direction
        // a next-navigation would travel.
        button.addEventListener("click", () => {
          const dest = forwardEligibleSlide(startIndex);
          if (dest === null) {
            noteDurationSkips(
              "navigation-skipped-long",
              state.index,
              startIndex,
            );
            return;
          }
          // Clicking the number of the already-displayed post re-renders the
          // same slide; only real hops take a transition, so the viewer
          // never fades a slide into itself.
          if (dest !== state.index) requestTransition(dest - state.index);
          state.index = dest;
          render();
        });
        numberBar.append(button);
      });
    }
    if (currentPost >= 1 && starts.length) {
      const target =
        numberBar.querySelectorAll(".redditp__number")[currentPost - 1];
      if (target && !target.classList.contains("redditp__number--active")) {
        numberBar
          .querySelectorAll(".redditp__number--active")
          .forEach((button) =>
            button.classList.remove("redditp__number--active"),
          );
        target.classList.add("redditp__number--active");
      }
    }
    const activeButton = numberBar.querySelector(".redditp__number--active");
    if (activeButton) scrollNumberTrackTo(activeButton);
    // The auto-advance toggle stays reachable even when the rest of the
    // numbered bar is hidden with the other controls (P). Only a hidden
    // interface (H) takes the whole strip away.
    numberBar.classList.toggle(
      "redditp__numbers--manual",
      !state.settings.showControls,
    );
    numberBar.hidden = !hasSlides || !hasVisible || state.interfaceHidden;
    root.classList.toggle("redditp__interface-hidden", state.interfaceHidden);
    root.classList.toggle("redditp__rotated", state.rotation % 180 !== 0);

    const viewportWidth = Math.max(
      root.clientWidth || window.innerWidth || 0,
      1,
    );
    const viewportHeight = Math.max(
      root.clientHeight || window.innerHeight || 0,
      1,
    );
    const rotated = state.rotation % 180 !== 0;
    const mediaWidth = rotated ? viewportHeight : viewportWidth;
    const mediaHeight = rotated ? viewportWidth : viewportHeight;
    const mediaElement = mediaBox.firstElementChild;
    const shouldSizeDirectMedia =
      mediaElement &&
      mediaElement.matches(".redditp__image, .redditp__video, .redditp__embed");
    if (rotated) {
      mediaBox.style.left = "50%";
      mediaBox.style.top = "50%";
      mediaBox.style.width = `${mediaWidth}px`;
      mediaBox.style.height = `${mediaHeight}px`;
      mediaBox.style.transform = `translate(-50%, -50%) rotate(${state.rotation}deg)`;
      if (shouldSizeDirectMedia) {
        mediaElement.style.width = `${mediaWidth}px`;
        mediaElement.style.height = `${mediaHeight}px`;
        mediaElement.style.maxWidth = "none";
        mediaElement.style.maxHeight = "none";
      }
    } else {
      mediaBox.style.left = "0";
      mediaBox.style.top = "0";
      mediaBox.style.width = "100%";
      mediaBox.style.height = "100%";
      mediaBox.style.transform = "none";
      if (shouldSizeDirectMedia) {
        mediaElement.style.width = "";
        mediaElement.style.height = "";
        mediaElement.style.maxWidth = "";
        mediaElement.style.maxHeight = "";
      }
    }
    if (state.interfaceHidden) settingsOverlay.hidden = true;
    hideButton.setAttribute(
      "aria-label",
      state.interfaceHidden ? "Show interface" : "Hide interface",
    );
    hideButton.title = state.interfaceHidden
      ? "Show interface (H)"
      : "Hide interface (H)";
    const fullscreenActive = document.fullscreenElement === root;
    fullscreenButton.setAttribute(
      "aria-label",
      fullscreenActive ? "Exit fullscreen" : "Enter fullscreen",
    );
    fullscreenButton.title = fullscreenActive
      ? "Exit fullscreen (F)"
      : "Toggle fullscreen (F)";
    fullscreenButton.setAttribute("aria-pressed", String(fullscreenActive));
    setSvgMarkup(
      fullscreenButton,
      fullscreenActive
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    );
  }

  // Counts posts rather than slides, so a gallery advances only its own
  // "(2/7)" counter while the post number stays put.
  function updateCount(loading) {
    const previousText = count.textContent;
    if (!state.slides.length) {
      count.textContent = "0 posts";
      return;
    }
    let current = 0;
    let total = 0;
    let previous = null;
    state.slides.forEach((slide, index) => {
      // Duration-excluded posts keep their numbers (Phase 5A: the counters
      // stay feed-based; exclusion is a navigation filter, not a rewrite).
      // Only the media-mode filter renumbers: an excluded kind claims
      // neither a post number nor the current position.
      if (!slideMediaModeEligible(slide)) return;
      const identity = postIdentity(slide);
      if (identity !== previous) total += 1;
      previous = identity;
      if (index === state.index) current = total;
    });
    count.textContent = `${current} / ${total}${loading ? " · loading more" : ""}`;
    // The chip shares its row with the numbered track, so a width change
    // (the " · loading more" suffix appears exactly when a scan starts)
    // narrows the track after `scrollNumberTrackTo` already ran for this
    // navigation and leaves the active button clipped. Re-anchor it.
    if (count.textContent !== previousText) {
      const activeButton = numberBar.querySelector(".redditp__number--active");
      if (activeButton) scrollNumberTrackTo(activeButton);
    }
  }

  function mediaPreloadKey(slide) {
    if (!slide) return "";
    const url = slide.url || slide.sourceUrl || slide.commentsUrl || "";
    const identity = slide.postKey || slide.commentsUrl || slide.title || "";
    return `${identity}|${slide.galleryItem || 0}|${url}`;
  }

  function preloadReadyImage(slide) {
    if (!slide || slide.kind !== "image") return null;
    const cached =
      slide.preloadedImage || state.preloadCache.get(mediaPreloadKey(slide));
    if (!cached || !(cached instanceof Image)) return null;
    if (!cached.complete || !cached.naturalWidth || !cached.naturalHeight)
      return null;
    return cached;
  }

  // Releases the browser resources a preloaded media object holds (decoded
  // image data, video buffers) so eviction actually frees memory.
  function releasePreloadResource(cached) {
    if (!cached) return;
    try {
      if (cached instanceof Image) {
        cached.removeAttribute("src");
        return;
      }
      if (
        typeof HTMLVideoElement !== "undefined" &&
        cached instanceof HTMLVideoElement
      ) {
        // A prepared DASH element still holds a live dash.js player; the
        // bridge must reset it before the element's stream is freed.
        if (cached.hasAttribute("data-redditp-dash")) {
          releaseRedditDash(cached);
        }
        cached.pause();
        cached.removeAttribute("src");
        if (typeof cached.load === "function") cached.load();
        return;
      }
    } catch (_error) {
      // Eviction is best-effort and must never break the preload queue.
    }
  }

  function debugLogEvent(event, detail) {
    try {
      if (!localStorage.getItem("redditpDebug")) return;
    } catch (_error) {
      return;
    }
    try {
      state.debugLog.push({
        t: Date.now(),
        event,
        detail: detail === undefined ? null : detail,
      });
      if (state.debugLog.length > 200) state.debugLog.splice(0, 100);
    } catch (_error) {
      // Diagnostics must not affect playback.
    }
  }

  // A cache entry is kept while its slide is on screen, worth showing on a
  // step back, or inside the preload horizon (including a dangling gallery).
  function activePreloadKeys() {
    const keys = new Set();
    if (!state.slides.length) return keys;
    const current = state.slides[state.index];
    const identity = postIdentity(current);
    for (let offset = -2; offset <= state.settings.preloadPosts; offset += 1) {
      const index = state.index + offset;
      if (index < 0) continue;
      const slide = state.slides[index];
      if (slide) keys.add(mediaPreloadKey(slide));
    }
    // A dangling gallery keeps its cache alive past the offset horizon.
    let tail = state.index + state.settings.preloadPosts;
    while (tail >= 0 && tail < state.slides.length) {
      const slide = state.slides[tail];
      if (!slide || postIdentity(slide) !== identity) break;
      keys.add(mediaPreloadKey(slide));
      tail += 1;
    }
    return keys;
  }

  function evictPreloadCache() {
    const activeKeys = activePreloadKeys();
    for (const key of Array.from(state.preloadCache.keys())) {
      if (activeKeys.has(key)) continue;
      releasePreloadResource(state.preloadCache.get(key));
      state.preloadCache.delete(key);
      state.preloadRetry.delete(key);
      state.preloadStats.evicted += 1;
      debugLogEvent("preload-evict", { key, reason: "horizon" });
    }
    // Drop per-slide shortcuts to released entries so a stale revisit cannot
    // re-use media whose resources were freed.
    for (const slide of state.slides) {
      if (slide.preloadedImage && !activeKeys.has(mediaPreloadKey(slide))) {
        slide.preloadedImage = null;
      }
    }
  }

  // "" when a video slide can be speculatively prepared; otherwise the
  // diagnostic reason it was excluded. Why nothing was fetched matters when
  // such a slide later fails to play, so the answer is recorded once — the
  // flag rides on the slide object and leaves nothing to clean up.
  function videoPreloadExclusionReason(slide) {
    // A slide the current media mode excludes is never worth network work;
    // the scheduler re-asks this on every pass so a mode change stops the
    // speculative fetches at the next boundary without touching the cache.
    if (!slideMediaModeEligible(slide)) return "filtered-media-mode";
    // Known long videos never enter the eager-preparation queues (5G).
    const duration = slideVideoDuration(slide);
    if (duration !== null && duration > MAX_ELIGIBLE_VIDEO_SECONDS)
      return "long-video";
    // DASH slides delegate playback to the page's dash.js. That same page
    // capability is also what makes the stream resolvable ahead of
    // navigation, so the delegation is only an exclusion where the bridge
    // mediation is absent.
    if (slide.mpdUrl) return dashPreloadAvailable() ? "" : "dash-delegated";
    if (!canPlayHls() && /\.m3u8(?:$|[?#])/i.test(slide.url))
      return "unsupported-hls";
    return "";
  }

  // Same availability question the page bridge answers when asked to attach
  // ("window.dashjs"? see page-bridge.js). Cheap to ask, so the scheduler
  // consults it directly instead of guessing around the bridge protocol.
  function dashPreloadAvailable() {
    return Boolean(
      window.dashjs && typeof window.dashjs.MediaPlayer === "function",
    );
  }

  // A video slide's duration in seconds, or null while it is explicitly
  // unknown. A duration once learned rides on the slide: any media element
  // that ever opened the slide's URL reports it, and the prepared element in
  // the cache is consulted as a fallback so eviction cannot falsify a
  // settled answer.
  function slideVideoDuration(slide) {
    if (!slide) return null;
    // A RedGIFs slide keeps its embed player until it resolves; once
    // metadata came back the duration is real knowledge and rides on the
    // slide even before the kind upgrade happens.
    if (
      slide.kind === "embed" &&
      slide.redgifsId &&
      Number.isFinite(slide.videoDuration) &&
      slide.videoDuration > 0
    ) {
      return slide.videoDuration;
    }
    if (slide.kind !== "video") return null;
    if (Number.isFinite(slide.videoDuration) && slide.videoDuration > 0)
      return slide.videoDuration;
    const cached = state.preloadCache.get(mediaPreloadKey(slide));
    if (
      typeof HTMLVideoElement !== "undefined" &&
      cached instanceof HTMLVideoElement &&
      Number.isFinite(cached.duration) &&
      cached.duration > 0
    )
      return cached.duration;
    const inflight = inflightVideoFor(slide);
    if (inflight && Number.isFinite(inflight.duration) && inflight.duration > 0)
      return inflight.duration;
    return null;
  }

  // Learned duration: never invent 0 for loud failures or live streams —
  // those stay unknown. Recording also re-runs the scheduler so the long
  // duration its brand-new knowledge implies takes effect immediately.
  function noteVideoDuration(slide, video) {
    if (!slide || slide.kind !== "video" || !video) return;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const rounded = Math.round(duration * 100) / 100;
    if (slide.videoDuration === rounded) return;
    slide.videoDuration = rounded;
    debugLogEvent("video-duration", {
      key: mediaPreloadKey(slide),
      duration: rounded,
    });
    if (state.open) schedulePreloadQueue();
  }

  // The centralized duration-eligibility decision (5B). A post is excluded
  // only when every slide grouped under this identity is a video whose
  // duration is both known and beyond the limit. Any image in the group
  // keeps the post (5.1: the rule must never skip between a gallery's
  // images), any unknown duration leaves it provisionally eligible (5.3),
  // and short media keeps it eligible outright.
  function postDurationExclusionReason(identity) {
    let videoOnly = false;
    let knownLong = false;
    for (const slide of state.slides) {
      if (!slide || postIdentity(slide) !== identity) continue;
      // A RedGIFs embed whose metadata resolved is a known-duration video
      // for policy purposes (4C): the duration rule must survive the host
      // Player's frame. Other embeds have no duration knowledge and stay
      // provisionally eligible, exactly as before.
      const isDurationVideo =
        slide.kind === "video" ||
        (slide.kind === "embed" && Boolean(slide.redgifsId));
      if (!isDurationVideo) return "";
      videoOnly = true;
      const duration = slideVideoDuration(slide);
      if (duration === null) return "";
      if (duration > MAX_ELIGIBLE_VIDEO_SECONDS) {
        knownLong = true;
      } else {
        return "";
      }
    }
    return videoOnly && knownLong ? "long-video" : "";
  }

  // Skips get counted once per resolved navigation so the diagnostics can
  // say how often the filter moved a request, not how often it was asked.
  function noteDurationSkips(slug, fromIndex, destIndex) {
    state.preloadStats.longSkipped += 1;
    debugLogEvent(slug, { from: fromIndex, to: destIndex });
  }

  // Media classification (Part C): every playable slide reduces to image or
  // video, everything of unknown type (link cards, text posts) stays outside
  // the filter. RedGIFs slides are video hosts from the moment they are
  // recognized, whether or not a direct rendition has been resolved yet.
  function slideMediaType(slide) {
    if (!slide) return "";
    if (slide.kind === "image") return "image";
    if (
      slide.kind === "video" ||
      slide.kind === "native-video" ||
      slide.kind === "pending-native-video" ||
      slide.kind === "embed"
    ) {
      return "video";
    }
    return "";
  }

  // The single media-mode eligibility decision used by navigation, counters,
  // the numbered bar, and the preload scheduler alike. `both` keeps every
  // media kind (the pre-existing behavior); `images`/`videos` keep their one
  // kind, and unknown types never disappear because of the mode.
  function slideMediaModeEligible(slide) {
    const type = slideMediaType(slide);
    if (!type) return true;
    const mode = MEDIA_MODE_KEYS.includes(state.settings.mediaMode)
      ? state.settings.mediaMode
      : "both";
    // The mode keys are plural ("images"/"videos") while the media type is
    // singular ("image"/"video"); compare by meaning, not by string.
    return (
      mode === "both" ||
      (mode === "images" && type === "image") ||
      (mode === "videos" && type === "video")
    );
  }

  // The full slide-level exclusion answer: the media mode first, then the
  // Phase 5A duration policy, which is applied at post granularity exactly
  // as before and is never bypassed by the mode.
  function slideEligibilityReason(slide) {
    if (!slideMediaModeEligible(slide)) return "filtered-media-mode";
    return postDurationExclusionReason(postIdentity(slide));
  }

  function hasVisibleSlides() {
    return state.slides.some((slide) => !slideEligibilityReason(slide));
  }

  // The first slide at or after `index` that the viewer may show: the whole
  // duration-excluded post is stepped over in the travelled direction
  // (bounded by the feed length), and within a partially filtered group the
  // scan walks single slides while media-mode filtering hides some types.
  // null means nothing eligible lies in that direction (5.2).
  function forwardEligibleSlide(index) {
    while (index >= 0 && index < state.slides.length) {
      const slide = state.slides[index];
      const identity = postIdentity(slide);
      if (postDurationExclusionReason(identity)) {
        let next = index;
        while (
          next < state.slides.length &&
          postIdentity(state.slides[next]) === identity
        ) {
          next += 1;
        }
        index = next;
        continue;
      }
      if (slideMediaModeEligible(slide)) return index;
      index += 1;
    }
    return null;
  }

  // First slide strictly behind `index` whose post and media type pass, in
  // the same bounded whole-post / single-slide pattern as forward.
  function backwardEligibleSlide(index) {
    while (index >= 0 && index < state.slides.length) {
      const slide = state.slides[index];
      const identity = postIdentity(slide);
      if (postDurationExclusionReason(identity)) {
        let start = index;
        while (
          start > 0 &&
          postIdentity(state.slides[start - 1]) === identity
        ) {
          start -= 1;
        }
        if (start === 0) return null;
        index = start - 1;
        continue;
      }
      if (slideMediaModeEligible(slide)) return index;
      if (index === 0) return null;
      index -= 1;
    }
    return null;
  }

  // previousPost lands on the first slide of the previous eligible post.
  function previousEligiblePostStart(index) {
    const dest = backwardEligibleSlide(index);
    if (dest === null) return null;
    const identity = postIdentity(state.slides[dest]);
    let start = dest;
    while (start > 0 && postIdentity(state.slides[start - 1]) === identity) {
      start -= 1;
    }
    return start;
  }

  // previousPostLast lands on the last slide of the previous eligible post.
  function eligiblePostLastSlide(index) {
    const dest = backwardEligibleSlide(index);
    if (dest === null) return null;
    const identity = postIdentity(state.slides[dest]);
    let last = dest;
    while (
      last + 1 < state.slides.length &&
      postIdentity(state.slides[last + 1]) === identity
    ) {
      last += 1;
    }
    return last;
  }

  function notePreloadSkip(slide, reason) {
    if (!slide || !reason || slide.redditpPreloadSkip === reason) return;
    slide.redditpPreloadSkip = reason;
    debugLogEvent("preload-skip", {
      key: mediaPreloadKey(slide),
      reason,
    });
  }

  // A slide is worth preparing at metadata depth when this browser could
  // accept its URL: an HLS playlist a browser cannot play natively would
  // only churn failed metadata attempts, and DASH slides keep the MPD path
  // that must not share a src-tagged element.
  function preloadableVideoSlide(slide) {
    return (
      slide.kind === "video" &&
      Boolean(slide.url) &&
      !videoPreloadExclusionReason(slide)
    );
  }

  // The rolling preload window, ordered by how soon the user is likely to
  // see the media (lower priority = fetched sooner):
  //   0        remaining images of the gallery currently on screen
  //   1..horizon  the near posts' primary media; videos only in the first
  //            window positions, and subject to the video budget
  //   5..6     the slides just left behind, so stepping back is free
  function preloadCandidateEntries() {
    if (!state.slides.length) return [];
    const entries = [];
    const push = (slide, priority, kind) => {
      // Media the mode excludes never enters the speculative pipeline; its
      // cached resource stays put for when the mode turns back.
      if (slide && slide.url && slideMediaModeEligible(slide)) {
        entries.push({ slide, priority, kind });
      }
    };
    const current = state.slides[state.index];
    const currentIdentity = postIdentity(current);
    if (current?.galleryItem) {
      for (let i = state.index + 1; i < state.slides.length; i += 1) {
        const candidate = state.slides[i];
        if (postIdentity(candidate) !== currentIdentity) break;
        if (candidate.kind === "image") {
          push(candidate, 0, "gallery");
        }
      }
    }
    for (let offset = 1; offset <= state.settings.preloadPosts; offset += 1) {
      const index = state.index + offset;
      if (index >= state.slides.length) break;
      const candidate = state.slides[index];
      const candidateIdentity = postIdentity(candidate);
      if (candidateIdentity === currentIdentity) continue;
      if (candidate.kind === "image" && candidate.url) {
        push(candidate, offset, "post");
      } else if (
        candidate.redgifsId &&
        candidate.kind === "embed" &&
        !candidate.redditpRedgifsSkip
      ) {
        // RedGIFs metadata resolution: a tiny JSON fetch that upgrades the
        // slide into a plain video slide when it succeeds, so the ordinary
        // video path (with its own budget) does the heavy work afterwards.
        // A slide whose earlier resolution failed stops being queued until
        // it is displayed again (one bounded retry per revisit).
        push(candidate, offset, "redgifs");
      } else if (
        offset <= VIDEO_PRELOAD_WINDOW &&
        preloadableVideoSlide(candidate)
      ) {
        // The +0.5 priority bias keeps same-distance images ahead of video
        // element fetches: with the sort's priority-then-order tiebreak, a
        // video would otherwise win (or lose) by pure queue insertion order
        // against the image it shares a distance with. Images stay first;
        // the biased video still outranks images one step farther away.
        push(candidate, offset + 0.5, "post-video");
      } else if (
        offset <= VIDEO_PRELOAD_WINDOW &&
        candidate.kind === "video" &&
        candidate.url
      ) {
        // Inside the window but never queued: say why in the diagnostics.
        notePreloadSkip(candidate, videoPreloadExclusionReason(candidate));
      }
    }
    // Keep the slides just behind the current ones cached so stepping back
    // reuses the network responses instead of refetching the media.
    for (let offset = 2; offset >= 1; offset -= 1) {
      const index = state.index - offset;
      if (index < 0) break;
      const candidate = state.slides[index];
      if (candidate.kind === "image" && candidate.url) {
        push(candidate, 4 + offset, "revisit");
      } else if (preloadableVideoSlide(candidate)) {
        // Same image-first bias as the forward window: a revisit video must
        // not leapfrog a not-yet-fetched forward image.
        push(candidate, 4 + offset + 0.5, "revisit-video");
      }
    }
    return entries;
  }

  // The preload job that is still fetching this slide's media, if any.
  // Its element can serve the display directly, so a navigation that races
  // the preload never issues a second request for the same identity.
  function inflightPreloadJob(slide) {
    if (!slide) return null;
    const job = state.preloadInFlight.get(mediaPreloadKey(slide));
    return job && !job.canceled && job.slide === slide ? job : null;
  }

  function inflightImageFor(slide) {
    const job = inflightPreloadJob(slide);
    return job && job.media instanceof Image ? job.media : null;
  }

  function inflightVideoFor(slide) {
    const job = inflightPreloadJob(slide);
    return job &&
      typeof HTMLVideoElement !== "undefined" &&
      job.media instanceof HTMLVideoElement
      ? job.media
      : null;
  }

  function videoPreloadReady(video) {
    return Boolean(
      video &&
      typeof HTMLVideoElement !== "undefined" &&
      video instanceof HTMLVideoElement &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      !video.error,
    );
  }

  // How many video resources in an expensive state exist right now, across
  // the cache and still-running jobs. The one being displayed counts when
  // it was prepared by the preloader, so it still occupies its budget slot.
  // This is a decoder/playback budget, not a metadata-element budget: a
  // video element that only holds metadata (HAVE_METADATA, no data, no
  // attached DASH player) costs no media pipeline. Charging it for merely
  // holding metadata starved near-priority video re-preparation while a
  // distant forward slide's shell sat in the cache (measured in the
  // Phase 7 benchmarks: a one-step-back video refetched fresh because of
  // exactly that accounting). Expensive states are:
  //   - readyState >= HAVE_CURRENT_DATA (buffered samples/frames), or
  //   - an attached dash.js player (data-redditp-dash "attached").
  function heldVideoPreloads() {
    let count = 0;
    const expensive = (video) =>
      video.readyState >= (HTMLMediaElement.HAVE_CURRENT_DATA || 2) ||
      video.getAttribute("data-redditp-dash") === "attached";
    for (const value of state.preloadCache.values()) {
      if (
        typeof HTMLVideoElement !== "undefined" &&
        value instanceof HTMLVideoElement &&
        expensive(value)
      ) {
        count += 1;
      }
    }
    for (const job of state.preloadInFlight.values()) {
      if (job.slide?.kind === "video") count += 1;
    }
    return count;
  }

  // Cache outcomes for the displayed media, one per navigation render.
  function noteCacheRead(usedCache, slide) {
    if (usedCache) {
      state.preloadStats.hits += 1;
      debugLogEvent("cache-hit", mediaPreloadKey(slide));
    } else {
      state.preloadStats.misses += 1;
      debugLogEvent("cache-miss", mediaPreloadKey(slide));
    }
  }

  // Single-slot navigation diagnostics: what the navigation ended on,
  // whether it reused prepared media, and how long fresh media took from
  // the navigation input to being usable. One object keeps this O(1) no
  // matter how navigation spins, while the ring buffer records the events.
  // `reuse` distinguishes a prepared resource, an in-flight resolution the
  // display joined, and a cold fetch ("", images).
  function recordNavigation(slide, ready, reuse) {
    const nowMs = performance.now();
    state.lastNavigation = {
      index: state.index,
      key: mediaPreloadKey(slide),
      kind: slide ? slide.kind : "",
      ready,
      reuse: reuse || "",
      readyAfterMs: ready ? 0 : null,
      startedAt: nowMs,
      // Wall-clock twin of startedAt: the only clock shared by debug
      // log entries, so later events (playback start, first frame) can
      // report their navigation-relative delays without clock mixing.
      startedAtMs: Date.now(),
    };
    debugLogEvent("navigate", {
      to: state.index,
      key: state.lastNavigation.key,
      ready,
      reuse: state.lastNavigation.reuse,
    });
  }

  // Called by a displayed-but-still-loading media element's own readiness
  // event, so navigation-to-display time is measured once per navigation.
  function noteMediaReady(key) {
    const navigation = state.lastNavigation;
    if (
      navigation &&
      !navigation.ready &&
      navigation.key === key &&
      navigation.readyAfterMs === null
    ) {
      navigation.readyAfterMs = Math.max(
        0,
        Math.round(performance.now() - navigation.startedAt),
      );
      debugLogEvent("navigate-ready", {
        key,
        ms: navigation.readyAfterMs,
      });
    }
  }

  // A re-entrancy guard around the scheduler: a job can complete
  // synchronously (a tightened exclusion, a failed DASH handshake) and
  // re-run the scheduler from inside `runPreload`. Recomputing the queue
  // from within that pass recurses endlessly when the exclusion stays
  // volatile, so nested passes defer and the outermost pass drains.
  schedulePreloadQueue.running = false;
  schedulePreloadQueue.pending = false;

  function schedulePreloadQueue() {
    if (schedulePreloadQueue.running) {
      schedulePreloadQueue.pending = true;
      return;
    }
    schedulePreloadQueue.running = true;
    try {
      do {
        schedulePreloadQueue.pending = false;
        schedulePreloadQueuePass();
      } while (schedulePreloadQueue.pending);
    } finally {
      schedulePreloadQueue.running = false;
    }
  }

  function schedulePreloadQueuePass() {
    if (!state.open) return;
    evictPreloadCache();
    // Speculative work steps aside while the tab is hidden; a later render
    // or explicit refresh re-runs the scheduler.
    if (document.hidden) return;
    const currentKey = state.slides.length
      ? mediaPreloadKey(state.slides[state.index])
      : "";
    const seen = new Set();
    const queue = [];
    for (const entry of preloadCandidateEntries()) {
      const slide = entry.slide;
      if (!slide || !slide.url || slide.kind === "link") continue;
      const key = mediaPreloadKey(slide);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // The slide being displayed fetches itself; a queued twin would only
      // duplicate that request.
      if (key === currentKey) continue;
      if (slide.preloadFailed || state.preloadInFlight.has(key)) continue;
      if (state.preloadCache.has(key)) continue;
      queue.push({
        key,
        slide,
        priority: entry.priority,
        jobKind: entry.kind,
      });
      debugLogEvent("preload-scheduled", {
        key,
        priority: entry.priority,
      });
    }

    // Drop queued jobs that left the horizon. Jobs that are already running
    // keep their own callbacks; releasing their in-flight markers here would
    // let a second job start for the same key.
    state.preloadQueue = state.preloadQueue.filter((job) => seen.has(job.key));
    for (const job of queue) {
      const existing = state.preloadQueue.find(
        (candidate) => candidate.key === job.key,
      );
      if (!existing) state.preloadQueue.push(job);
    }

    const capacity = Math.max(
      0,
      state.settings.preloadConcurrency - state.preloadInFlight.size,
    );
    for (let i = 0; i < capacity && state.preloadQueue.length; i += 1) {
      const choices = state.preloadQueue
        .map((job, index) => ({ job, index }))
        .sort((a, b) => a.job.priority - b.job.priority || a.index - b.index);
      // Dispatch the highest-priority job that is allowed to start. Video
      // element jobs (plain or DASH) face extra gates that image and RedGIFs
      // metadata jobs never see, so speculative videos can never crowd the
      // image pipeline or create extra decoders. A gated video defers but
      // does not block the lower-priority image behind it, so the scan
      // continues past it instead of breaking.
      let eligible = null;
      for (const choice of choices) {
        if (choice.job.slide.kind !== "video") {
          eligible = choice;
          break;
        }
        // Gate 1 — congested network: while recent image loads averaged
        // slow, no new speculative video fetch starts. The job stays queued
        // and runs when image latency recovers.
        if (imageNetworkSlow()) {
          logVideoDeferred("slow-network");
          continue;
        }
        // Gate 2 — a reserved slot for images: while any image job waits in
        // the queue, video may only fill the pool up to concurrency - 1, so
        // a freed slot always goes to an image first. When no images wait
        // (end of feed, everything cached), video may use the whole pool.
        const imageJobsWaiting = state.preloadQueue.some(
          (queued) => queued.slide.kind === "image",
        );
        if (
          imageJobsWaiting &&
          state.preloadInFlight.size >=
            state.settings.preloadConcurrency - 1
        ) {
          logVideoDeferred("image-priority");
          continue;
        }
        // Gate 3 — the video decoder budget. When the budget is full and
        // the closest waiting video is nearer than a cached video resource,
        // making room wins: release the farthest cached video (a Phase 7
        // measured case — a distant forward video's frames kept the slot a
        // one-step-back video needed, so the step back refetched fresh over
        // the network).
        if (heldVideoPreloads() < VIDEO_PRELOAD_LIMIT) {
          eligible = choice;
          break;
        }
        if (evictFartherVideoResource(videoDistance(choice.job.slide))) {
          if (heldVideoPreloads() < VIDEO_PRELOAD_LIMIT) {
            eligible = choice;
            break;
          }
        }
      }
      if (!eligible) break;
      state.preloadQueue.splice(eligible.index, 1);
      runPreload(eligible.job);
    }
  }

  // A video job's distance from the displayed slide, used to compare it
  // against held video resources when the budget is contested.
  function videoDistance(slide) {
    const index = state.slides.indexOf(slide);
    return index === -1 ? Infinity : Math.abs(index - state.index);
  }

  // Image-first fairness, part 1: record how long a completed image load
  // took. The window stays tiny on purpose — a few samples let the signal
  // track changing network conditions within a couple of preloads.
  function noteImageLoadLatency(latencyMs) {
    const samples = state.preloadImageLatencies;
    samples.push(latencyMs);
    while (samples.length > IMAGE_LATENCY_SAMPLES) samples.shift();
  }

  // Baseline for cache-hit detection in the latency window (only image jobs
  // call it). The browser's image cache serves a repeat load of a URL the
  // document already holds without a network fetch in both Chromium and
  // Firefox, and such a load records no NEW resource timing entry — while an
  // entry from the original fetch stays buffered. Counting the entries for
  // the URL around the src assignment therefore separates real fetches
  // (baseline grows) from cache-served completions (baseline unchanged).
  // Feature-detected; engines without resource timing keep the old behavior.
  let resourceTimingBufferEnlarged = false;
  function resourceTimingBaseline(url) {
    if (
      typeof performance === "undefined" ||
      typeof performance.getEntriesByName !== "function"
    ) {
      return -1;
    }
    if (!resourceTimingBufferEnlarged) {
      resourceTimingBufferEnlarged = true;
      if (typeof performance.setResourceTimingBufferSize === "function") {
        try {
          // A default-sized buffer fills on long feeds, after which new
          // fetches record no entry and would read as cache hits.
          performance.setResourceTimingBufferSize(20000);
        } catch (error) {
          /* keep the engine's default buffer */
        }
      }
    }
    return performance.getEntriesByName(url, "resource").length;
  }

  // Image-first fairness, part 2: true while recently completed images were
  // consistently slow. With fewer samples than the window there is no
  // evidence of congestion, so the answer is no — a fresh session never
  // starts in the paused state.
  function imageNetworkSlow() {
    const samples = state.preloadImageLatencies;
    if (samples.length < IMAGE_LATENCY_SAMPLES) return false;
    const total = samples.reduce((sum, value) => sum + value, 0);
    return total / samples.length > IMAGE_SLOW_MS;
  }

  // Deferral diagnostics, time-throttled: the scheduler re-runs on every
  // preload terminal event, and an unchanged deferral state would flood the
  // debug ring with repeats of the same fact.
  let lastVideoDeferLogAt = 0;
  function logVideoDeferred(reason) {
    const now = Date.now();
    if (now - lastVideoDeferLogAt < 2000) return;
    lastVideoDeferLogAt = now;
    debugLogEvent("preload-video-deferred", { reason });
  }

  // Shared failure tail for a preload job: the bounded retry requeue, stats,
  // diagnostics, and scheduler restart. `reason` distinguishes real errors
  // from watchdog timeouts in the log. A slide is only parked with
  // `preloadFailed` once its retries are spent, so a one-off failure can
  // still be retried by the requeue (and by a later revisit) instead of the
  // retry job being dropped by the scheduler's failed-slide filter.
  function failPreloadJob(job, key, reason) {
    const retries = (state.preloadRetry.get(key) || 0) + 1;
    state.preloadRetry.set(key, retries);
    state.preloadStats.failed += 1;
    state.preloadInFlight.delete(key);
    if (retries <= state.preloadRetryLimit) {
      state.preloadQueue.push({
        key,
        slide: job.slide,
        priority: job.priority + 1,
        // The requeued job keeps its kind so a RedGIFs metadata job retries
        // as metadata (the runPreload branches read slide.kind for media).
        jobKind: job.jobKind,
      });
      debugLogEvent("preload-retry", { key, retries, reason });
    } else {
      job.slide.preloadFailed = true;
    }
    debugLogEvent("preload-failed", { key, retries, reason });
    schedulePreloadQueue();
  }

  // Watchdog helpers: a job that neither completes nor errors within the
  // budget is failed through the ordinary bounded-retry path above. The
  // callback re-checks every condition because the timer can fire after a
  // cancel, a close, or a superseding job for the same key.
  function clearPreloadTimeout(job) {
    if (job && job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
  }

  function armPreloadTimeout(job) {
    clearPreloadTimeout(job);
    job.timeoutId = setTimeout(() => {
      job.timeoutId = null;
      if (job.canceled || !state.open) return;
      if (state.preloadInFlight.get(job.key) !== job) return;
      releasePreloadResource(job.media);
      job.media = null;
      debugLogEvent("preload-timeout", job.key);
      failPreloadJob(job, job.key, "timeout");
    }, PRELOAD_TIMEOUT_MS);
  }

  // Display-side watchdog: the element on stage must reach a usable state
  // within the budget. One silent budget earns a fresh restart (a hung
  // connection often answers a restarted request); a second silent budget
  // ends in the failure card. Ready media, navigation away, and superseded
  // elements all disarm it.
  function restartDisplayElement(video) {
    // A DASH-attached element carries a live MediaSource; load() would tear
    // it down, so the restart is refused and the watchdog's next pass takes
    // the failure path instead.
    if (video.getAttribute("data-redditp-dash") === "attached") return false;
    try {
      video.pause();
      video.load();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function armDisplayWatchdog(element, slide, isReady, canRestart) {
    clearDisplayWatchdog();
    if (isReady()) return;
    let retried = false;
    const attempt = () => {
      displayWatchdog = setTimeout(() => {
        displayWatchdog = null;
        if (!state.open || state.slides[state.index] !== slide) return;
        if (element.parentNode !== mediaBox || isReady()) return;
        if (!retried && canRestart()) {
          retried = true;
          debugLogEvent("display-timeout-retry", mediaPreloadKey(slide));
          attempt();
          return;
        }
        debugLogEvent("display-timeout", mediaPreloadKey(slide));
        showMediaFailure(element, slide);
      }, DISPLAY_TIMEOUT_MS);
    };
    attempt();
  }

  // Releases the cached video resource farthest from the displayed slide,
  // and only when it is strictly farther than the waiting job asking for
  // room. Returns whether one was released. Never releases the resource
  // of a slide near the stage: the current, next, and previous slides'
  // entries stay within the active window and are skipped by the
  // distance check.
  function evictFartherVideoResource(distance) {
    let farKey = "";
    let farDistance = distance;
    for (const [key, value] of state.preloadCache) {
      if (
        typeof HTMLVideoElement === "undefined" ||
        !(value instanceof HTMLVideoElement)
      ) {
        continue;
      }
      const expensive =
        value.readyState >= (HTMLMediaElement.HAVE_CURRENT_DATA || 2) ||
        value.getAttribute("data-redditp-dash") === "attached";
      if (!expensive) continue;
      const cacheIndex = state.slides.findIndex(
        (slide) => mediaPreloadKey(slide) === key,
      );
      if (cacheIndex === -1) continue;
      const cacheDistance = Math.abs(cacheIndex - state.index);
      if (cacheDistance > farDistance) {
        farKey = key;
        farDistance = cacheDistance;
      }
    }
    if (!farKey) return false;
    releasePreloadResource(state.preloadCache.get(farKey));
    state.preloadCache.delete(farKey);
    state.preloadRetry.delete(farKey);
    state.preloadStats.evicted += 1;
    debugLogEvent("preload-evict", { key: farKey, reason: "video-budget" });
    return true;
  }

  function runPreload(job) {
    if (!job || !job.slide || !job.slide.url) return;
    const key = job.key;
    if (!state.open) return;
    if (state.preloadInFlight.has(key) || state.preloadCache.has(key)) return;
    state.preloadInFlight.set(key, job);
    state.preloadStats.started += 1;
    // Congestion-signal input: image jobs report their completion latency
    // through this timestamp when the load event fires.
    job.startedAtMs = performance.now();
    const guarded = (callback) => () => {
      // A job canceled by close() or eviction (or fired after the viewer
      // closed) must not fill the cache or restart the scheduler.
      if (job.canceled || !state.open) {
        clearPreloadTimeout(job);
        releasePreloadResource(job.media);
        state.preloadInFlight.delete(key);
        return;
      }
      callback();
    };
    if (job.jobKind === "redgifs") {
      // RedGIFs metadata resolution: no element of its own, so nothing to
      // attach; the resolution is awaited and the successful upgrade hands
      // the slide to the ordinary video pipeline on the next pass.
      armPreloadTimeout(job);
      void runRedgifsPreload(job);
      return;
    }
    if (job.slide.kind === "image") {
      const image = new Image();
      job.media = image;
      image.decoding = "async";
      image.redditpPreloaded = true;
      const finish = () => {
        clearPreloadTimeout(job);
        job.slide.preloadedImage = image;
        job.slide.preloadFailed = false;
        state.preloadCache.set(key, image);
        state.preloadStats.loaded += 1;
        state.preloadRetry.delete(key);
        debugLogEvent("preload-loaded", key);
        state.preloadInFlight.delete(key);
        schedulePreloadQueue();
      };
      image.addEventListener(
        "load",
        guarded(() => {
          // Feed the image-latency window (measured to the load event, before
          // decode time, so decode cost never reads as network slowness).
          // Loads served by the browser's image cache record no new resource
          // timing entry after the src assignment, so they are not sampled:
          // the pause must lift on recovered network latency, not on cache
          // hits. Engines without resource timing sample as before.
          if (
            timingBaseline === -1 ||
            performance.getEntriesByName(job.slide.url, "resource").length >
              timingBaseline
          ) {
            noteImageLoadLatency(performance.now() - job.startedAtMs);
          }
          // Bytes are only half the story: decode upcoming images here so
          // display never waits for another decode. A decode failure is
          // recorded separately from a load failure and never poisons the
          // finished entry, since the browser still holds complete bytes.
          if (typeof image.decode === "function") {
            image
              .decode()
              .then(
                () => {
                  if (job.canceled || !state.open) return;
                  job.decoded = true;
                  image.redditpDecoded = true;
                  state.preloadStats.decoded += 1;
                  debugLogEvent("preload-decoded", key);
                },
                () => {
                  if (job.canceled || !state.open) return;
                  state.preloadStats.decodeFailed += 1;
                  debugLogEvent("preload-decode-failed", key);
                },
              )
              // A cancel that lands during the decode must not cache the
              // job; release and clear the in-flight marker like the other
              // guarded callbacks do.
              .then(() => {
                if (job.canceled || !state.open) {
                  clearPreloadTimeout(job);
                  releasePreloadResource(job.media);
                  state.preloadInFlight.delete(key);
                  return;
                }
                finish();
              });
          } else {
            // No decode support (very old engines): the load event plus the
            // natural-size check is the readiness signal, as before.
            finish();
          }
        }),
        { once: true },
      );
      image.addEventListener(
        "error",
        guarded(() => {
          clearPreloadTimeout(job);
          failPreloadJob(job, key, "error");
        }),
        { once: true },
      );
      armPreloadTimeout(job);
      debugLogEvent("preload-start", key);
      // Measured around the src assignment (a URL the session already holds
      // can be served by the browser's image cache without a fetch; see
      // resourceTimingBaseline). Such a cached recheck carries no network
      // evidence: a sub-30ms completion sampling into the congestion window
      // would erase real congestion history and lift the speculative-video
      // pause while the network is still slow.
      const timingBaseline = resourceTimingBaseline(job.slide.url);
      image.src = job.slide.url;
      return;
    }
    if (job.slide.kind === "video") {
      // Exclusions can tighten after the job was queued (a duration arriving,
      // the page's dash.js going away): re-ask before spending any element.
      const exclusion = videoPreloadExclusionReason(job.slide);
      if (exclusion) {
        state.preloadInFlight.delete(key);
        releasePreloadResource(job.media);
        notePreloadSkip(job.slide, exclusion);
        debugLogEvent("preload-skip", { key, reason: exclusion });
        schedulePreloadQueue();
        return;
      }
      if (job.slide.mpdUrl) {
        // v.redd.it DASH startup preparation: the source (MPD) is resolved
        // through the existing page bridge so playback later starts from a
        // live dash.js player instead of a cold element. No second DASH
        // player, exactly the integration the display path already uses.
        runDashVideoPreload(job);
        return;
      }
      const video = document.createElement("video");
      job.media = video;
      video.redditpPreloaded = true;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.addEventListener(
        "loadedmetadata",
        guarded(() => {
          clearPreloadTimeout(job);
          noteVideoDuration(job.slide, video);
          state.preloadCache.set(key, video);
          state.preloadStats.loaded += 1;
          state.preloadRetry.delete(key);
          debugLogEvent("preload-loaded", { key, media: "metadata" });
          state.preloadInFlight.delete(key);
          // The immediate next eligible video also gets its first frame:
          // one bounded position fetch at the head of the media, so
          // navigation starts with usable pixels instead of decoding from
          // zero. Longer or further videos keep their metadata-only depth,
          // and on a congested network (recent image loads consistently
          // slow) even this fetch defers: pixels then arrive at display
          // time, exactly as they would without preparation. The priority
          // ceiling is 1.5 — the immediate-next slot including the
          // image-first bias, but not its +1 deprioritized retries.
          const duration = slideVideoDuration(job.slide);
          if (
            duration !== null &&
            duration <= MAX_ELIGIBLE_VIDEO_SECONDS &&
            job.priority <= 1.5 &&
            !imageNetworkSlow()
          ) {
            try {
              video.currentTime = 0.01;
            } catch (_error) {
              // Seek-less engines simply pay the fetch at display time.
            }
            debugLogEvent("preload-firstframe-scheduled", { key });
          }
          video.addEventListener(
            "loadeddata",
            () => {
              // Evidence that initial media data exists is recorded whether
              // or metadata never claims first-frame readiness (11H).
              state.preloadStats.videoFirstFrames += 1;
              debugLogEvent("preload-firstframe", {
                key,
                readyState: video.readyState,
              });
            },
            { once: true },
          );
          schedulePreloadQueue();
        }),
        { once: true },
      );
      video.addEventListener(
        "error",
        guarded(() => {
          // Without a failure marker this error handler would re-queue the
          // same URL forever (an HLS playlist on a browser that cannot play
          // it, removed media, a network outage). The shared failure path
          // retries a limited number of times like the image path before
          // parking the slide.
          clearPreloadTimeout(job);
          failPreloadJob(job, key, "error");
        }),
        { once: true },
      );
      armPreloadTimeout(job);
      debugLogEvent("preload-start", key);
      video.src = job.slide.url;
      return;
    }
    state.preloadInFlight.delete(key);
  }

  // v.redd.it DASH preparation for an upcoming slide. The element is
  // attached to the page's dash.js through the same bridge protocol the
  // display path uses (attachRedditDash), so the MPD is resolved and the
  // player is connected before navigation; no competing DASH player is
  // created and src stays untouched (dash.js needs a src-free element).
  // Completing on attach keeps the budget from freezing on engines where
  // dash.js never reports loadedmetadata; duration only arrives when it
  // arrives, and stays unknown until then.
  function runDashVideoPreload(job) {
    const key = job.key;
    const video = document.createElement("video");
    job.media = video;
    video.redditpPreloaded = true;
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    attachRedditDashSource(video, job.slide.mpdUrl);
    if (video.getAttribute("data-redditp-dash") !== "attached") {
      // The bridge mediation vanished between scheduling and attaching;
      // report it like the scheduler's other exclusions do.
      state.preloadInFlight.delete(key);
      releasePreloadResource(video);
      notePreloadSkip(job.slide, "dash-delegated");
      debugLogEvent("preload-skip", { key, reason: "dash-delegated" });
      schedulePreloadQueue();
      return;
    }
    state.preloadCache.set(key, video);
    state.preloadStats.loaded += 1;
    state.preloadStats.dashPrepared += 1;
    state.preloadRetry.delete(key);
    state.preloadInFlight.delete(key);
    debugLogEvent("preload-loaded", { key, media: "dash" });
    // Duration and first-frame evidence still arrive later through the
    // connected player's own element events.
    video.addEventListener(
      "loadedmetadata",
      () => noteVideoDuration(job.slide, video),
      { once: true },
    );
    video.addEventListener(
      "loadeddata",
      () => {
        state.preloadStats.videoFirstFrames += 1;
        debugLogEvent("preload-firstframe", {
          key,
          readyState: video.readyState,
        });
      },
      { once: true },
    );
    // A later bridge failure must not keep a broken prepared entry. When the
    // element is displayed the ordinary fallback path takes over; when it is
    // still speculative the entry is dropped and the slide stays out of the
    // speculative queue until it is actually visited (a display resets the
    // flag and a fresh attempt is spent there).
    video.addEventListener(
      "redditp:dash-failed",
      () => {
        if (video.parentNode === mediaBox) return; // displayed fallback path owns it
        if (state.preloadCache.get(key) === video) {
          state.preloadCache.delete(key);
          state.preloadStats.evicted += 1;
          job.slide.preloadFailed = true;
          debugLogEvent("preload-invalidated", { key, reason: "dash-failed" });
          schedulePreloadQueue();
        }
      },
      { once: true },
    );
    schedulePreloadQueue();
  }

  // RedGIFs direct-media preparation (Part B): resolve the media metadata
  // (deduplicated per media id), then upgrade the slide from its embed
  // player into a plain video slide so the ordinary pipeline (duration
  // policy, speculative metadata/first-frame preloading, prepared-element
  // reuse) takes over unchanged. Failures leave the embed path in place.
  async function runRedgifsPreload(job) {
    const slide = job.slide;
    const result = await resolveRedgifsMedia(slide.redgifsId);
    clearPreloadTimeout(job);
    state.preloadInFlight.delete(job.key);
    if (job.canceled || !state.open) {
      releasePreloadResource(job.media);
      return;
    }
    if (state.preloadCache.has(job.key)) return;
    if (!result.ok) {
      // Persist the reason on the slide so the candidate generator stops
      // re-queueing this slide; the resolver's counted attempts are the
      // actual bound on further network work.
      slide.redditpRedgifsSkip = result.reason;
      state.preloadStats.redgifsFailed += 1;
      debugLogEvent("redgifs-still-embed", {
        key: job.key,
        why: result.reason,
      });
      schedulePreloadQueue();
      return;
    }
    absorbRedgifsResult(slide, result);
    schedulePreloadQueue();
  }

  // The tail a settled RedGIFs resolution shares with the display path
  // below: record the duration knowledge the API handed over, apply the
  // Phase 5A duration policy to it, and upgrade the slide in place. The
  // upgrade's own render() swaps the embed the viewer is looking at.
  function absorbRedgifsResult(slide, result) {
    const duration = slideVideoDuration(slide);
    if (
      result.duration !== null &&
      (duration === null || duration !== result.duration) &&
      Number.isFinite(result.duration) &&
      result.duration > 0
    ) {
      slide.videoDuration = Math.round(result.duration * 100) / 100;
      debugLogEvent("video-duration", {
        key: mediaPreloadKey(slide),
        duration: slide.videoDuration,
        source: "redgifs",
      });
      if (state.open) schedulePreloadQueue();
    }
    if (
      slideVideoDuration(slide) !== null &&
      slideVideoDuration(slide) > MAX_ELIGIBLE_VIDEO_SECONDS
    ) {
      // Known-long RedGIFs media: the duration policy applies (4C), so no
      // direct element is prepared and the slide leaves the eligible
      // navigation sequence with its diagnostic reason.
      slide.redditpRedgifsSkip = "long-video";
      debugLogEvent("redgifs-long-video", {
        key: mediaPreloadKey(slide),
        duration: slideVideoDuration(slide),
      });
      schedulePreloadQueue();
      return;
    }
    upgradeRedgifsSlide(slide, result);
  }

  // Swaps a RedGIFs embed slide over to a direct video slide in place. The
  // original /ifr URL is kept on the slide for the fallback to reuse.
  function upgradeRedgifsSlide(slide, result) {
    if (slide.kind !== "embed" || !slide.redgifsId) return;
    slide.redgifsEmbedUrl = slide.url;
    slide.kind = "video";
    slide.url = result.url;
    if (result.poster) slide.poster = result.poster;
    slide.mpdUrl = "";
    slide.redditpPreloadSkip = null;
    state.preloadStats.redgifsPrepared += 1;
    debugLogEvent("redgifs-prepared", mediaPreloadKey(slide));
    if (state.open && state.slides[state.index] === slide && !document.hidden) {
      render();
    }
  }

  // Drops queued work and marks running jobs canceled on close; the running
  // callbacks release their own media elements when the set() above lets them
  // through the guard.
  function cancelPreloads() {
    for (const job of state.preloadQueue) {
      debugLogEvent("preload-cancel", job.key);
    }
    state.preloadQueue = [];
    for (const job of state.preloadInFlight.values()) {
      job.canceled = true;
      clearPreloadTimeout(job);
      if (job.media) releasePreloadResource(job.media);
    }
    state.preloadStats.canceled += state.preloadInFlight.size;
    state.preloadInFlight.clear();
  }

  // Renders the explicit no-matching-media stage (sync already un-hid the
  // empty panel with the mode's copy) and parks any slideshow timer, so an
  // empty filter cannot keep advancing through excluded slides on its own.
  function renderNoMatchingMedia() {
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
  }

  // The active index can become ineligible outside navigation: a newly known
  // video duration, an enrichment upgrade, a media-mode change. Landing on
  // the next eligible slide deterministically (forward first, then backward)
  // keeps out the exclusion reason of ever painting a filtered slide.
  function resolveIneligibleIndex() {
    const slide = state.slides[state.index];
    if (!slide || !slideEligibilityReason(slide)) return;
    const dest =
      forwardEligibleSlide(state.index) ??
      backwardEligibleSlide(state.index - 1);
    if (dest !== null && dest !== state.index) state.index = dest;
  }

  // Slide transitions (new). One engine serves every navigation path:
  // move(), skipGallery(), previousPostLast(), auto-advance end and the
  // numbered track all "request" a transition right before their render,
  // and render() consumes the request. No animation logic lives inside the
  // gesture or keyboard handlers.
  function currentTransitionAnimation() {
    const stored = state.settings.transitionAnimation;
    // A corrupt or missing value must not disable or break the viewer; an
    // unknown name behaves exactly like the shipped default.
    return TRANSITION_ANIMATION_KEYS.includes(stored) ? stored : "none";
  }

  // Reduced motion is honored twice, by design: this resolver stops timers,
  // snapshots, and class churn from starting at all, while the stylesheet
  // still hard-disables the animations for anything that might slip through.
  function reducedMotionRequested() {
    try {
      return Boolean(
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      );
    } catch (_error) {
      return false;
    }
  }

  // The test seam for Random: production keeps Math.random, and the process
  // API can inject a deterministic sampler without any test-only branch in
  // the navigation or settings code.
  function pickRandomTransitionStyle() {
    const pool = TRANSITION_ANIMATION_POOL.filter(
      (name) => name !== state.lastRandomTransition,
    );
    const sampled = Number(state.randomSource());
    const clamped = Number.isFinite(sampled)
      ? Math.min(0.999999, Math.max(0, sampled))
      : 0;
    const pick = pool[Math.floor(clamped * pool.length)] || "fade";
    state.lastRandomTransition = pick;
    return pick;
  }

  function resolveTransitionStyle(style, incomingSlide) {
    if (reducedMotionRequested()) return "none";
    let resolved = TRANSITION_ANIMATION_KEYS.includes(style) ? style : "none";
    if (resolved === "random") resolved = pickRandomTransitionStyle();
    // Ken Burns is an image treatment: zooming a video element would scale
    // its native controls too, so video slides use the fade instead.
    if (resolved === "ken-burns" && incomingSlide?.kind !== "image") {
      resolved = "fade";
    }
    return resolved;
  }

  // Navigation call sites ask once, right before their synchronous render:
  // a site that ends up not rendering leaves no pending request, and the
  // pagination continuation re-requests on its own before its render.
  function requestTransition(direction) {
    state.pendingTransition = direction > 0 ? 1 : -1;
  }

  function stripAnimationClasses(container) {
    container.querySelectorAll(".redditp__media-anim").forEach((element) => {
      element.classList.remove(
        "redditp__media-anim",
        "redditp__media-anim--fade",
        "redditp__media-anim--slide-right",
        "redditp__media-anim--slide-left",
        "redditp__media-anim--ken-burns",
      );
    });
  }

  function releaseGhostElement(el) {
    el.classList.remove(
      "redditp__ghost-anim--exit-left",
      "redditp__ghost-anim--exit-right",
      "redditp__ghost-anim--exit-fade",
    );
  }

  // A stale transition can never survive into the next render: both CSS
  // animations (entering and exiting states) and any inline geometry are
  // cleaned up here, whatever the previous render left behind.
  function cancelTransition() {
    const transition = state.transition;
    if (transition) {
      clearTimeout(transition.releaseTimer);
      state.transition = null;
      restoreParkedImages(transition.parked);
    }
    const children = Array.from(transitionGhost.children);
    transitionGhost.replaceChildren();
    children.forEach((child) => releaseGhostElement(child));
    stripAnimationClasses(mediaBox);
  }

  // Before stopMedia() drops the current media, an image gets parked in the
  // ghost layer with its exact computed geometry so its exit animation can
  // play while the next slide's element builds underneath. The element is
  // moved, not cloned or refetched, and its inline style attribute is put
  // back byte-for-byte when the ghost releases it.
  function ghostOutgoingImage() {
    const outgoing = mediaBox.firstElementChild;
    if (
      !(outgoing instanceof HTMLImageElement) ||
      !outgoing.complete ||
      outgoing.naturalWidth === 0
    ) {
      return [];
    }
    const rect = outgoing.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    const restore = outgoing.getAttribute("style");
    const computed = getComputedStyle(outgoing);
    outgoing.style.position = "absolute";
    outgoing.style.margin = "0";
    outgoing.style.left = `${rect.left}px`;
    outgoing.style.top = `${rect.top}px`;
    outgoing.style.width = `${rect.width}px`;
    outgoing.style.height = `${rect.height}px`;
    outgoing.style.objectFit = computed.objectFit;
    outgoing.style.opacity = "1";
    outgoing.style.zIndex = "3";
    transitionGhost.append(outgoing);
    return [{ el: outgoing, restore }];
  }

  function startTransition(incomingSlide) {
    const style = resolveTransitionStyle(
      currentTransitionAnimation(),
      incomingSlide,
    );
    if (style === "none") return;
    cancelTransition();
    const token = state.transitionToken + 1;
    state.transitionToken = token;
    const parked = ghostOutgoingImage();
    // The exit direction of the parked image follows the chosen style, not
    // the navigation direction: "slide-right" always shows new media
    // entering from the right with the old one leaving toward the left,
    // "slide-left" mirrors it, and a fade dims the parked image out in
    // step with the entering one.
    if (parked.length && style !== "ken-burns") {
      const { el } = parked[0];
      el.classList.add(
        style === "slide-right"
          ? "redditp__ghost-anim--exit-left"
          : style === "slide-left"
            ? "redditp__ghost-anim--exit-right"
            : "redditp__ghost-anim--exit-fade",
      );
    }
    // The safety timer releases everything even when animationend never
    // fires (a blockable animation, an immediate further navigation that
    // already consumed the element, or an offscreen tab's throttling).
    state.transition = {
      token,
      style,
      releaseTimer: 0,
      parked,
    };
    if (parked.length) {
      parked[0].el.addEventListener(
        "animationend",
        () => {
          if (state.transition?.token === token) finishTransition();
        },
        { once: true },
      );
    }
    state.transition.releaseTimer = setTimeout(
      finishTransition,
      style === "ken-burns" ? 5600 : 700,
    );
  }

  // The exit snapshot stays parked in the preloaded image cache, so its
  // inline style attributes must be resting before the same element is ever
  // displayed again.
  function finishTransition() {
    const transition = state.transition;
    if (!transition) return;
    clearTimeout(transition.releaseTimer);
    state.transition = null;
    const children = Array.from(transitionGhost.children);
    transitionGhost.replaceChildren();
    children.forEach((child) => releaseGhostElement(child));
    restoreParkedImages(transition.parked);
    // The entering element may still carry its animation class when the
    // safety timer wins the race against animationend.
    stripAnimationClasses(mediaBox);
  }

  // A stale transition can never survive into the next render: both CSS
  // animations (entering and exiting states) and any inline geometry are
  // cleaned up here, whatever the previous render left behind.
  function cancelTransition() {
    const transition = state.transition;
    if (transition) {
      clearTimeout(transition.releaseTimer);
      state.transition = null;
      restoreParkedImages(transition.parked);
    }
    const children = Array.from(transitionGhost.children);
    transitionGhost.replaceChildren();
    children.forEach((child) => releaseGhostElement(child));
    stripAnimationClasses(mediaBox);
  }

  // One place keeps the parked image's release rule: its inline style
  // attribute is restored from the snapshot taken when it was parked, so
  // the preloaded element can be displayed again with nothing left behind.
  function restoreParkedImages(parked) {
    (parked || []).forEach(({ el, restore }) => {
      releaseGhostElement(el);
      if (restore === null) el.removeAttribute("style");
      else el.setAttribute("style", restore);
    });
  }

  // After the new media is built, the entering animation is applied to the
  // element itself: transforms and opacity only, no layout properties.
  function applyIncomingTransition(transition) {
    const incoming = mediaBox.firstElementChild;
    if (!incoming) return;
    const { token, style } = transition;
    incoming.classList.add(
      "redditp__media-anim",
      `redditp__media-anim--${style}`,
    );
    incoming.addEventListener(
      "animationend",
      () => {
        // Only the matching transition's end strips the classes; a later
        // navigation superseding this one cancels through cancelTransition.
        if (state.transition?.token === token) stripAnimationClasses(mediaBox);
      },
      { once: true },
    );
  }

  function render() {
    // A fresh render is a clean technical slate: whichever animation an
    // earlier navigation left behind is released before anything below is
    // rebuilt, so superseding transitions never accumulate.
    cancelTransition();
    const pendingTransition = state.pendingTransition;
    state.pendingTransition = null;
    if (pendingTransition) {
      // Must run before stopMedia(): the outgoing image is moved into the
      // ghost layer here, not after the swap.
      startTransition(state.slides[state.index]);
    }
    renderGeneration += 1;
    const generation = renderGeneration;
    // The watchdog belongs to the element about to be built; the previous
    // slide's timer must never fire into this render's stage.
    clearDisplayWatchdog();
    stopMedia();
    resolveIneligibleIndex();
    syncPresentationUi();
    if (!state.slides.length) return;
    if (!hasVisibleSlides()) {
      renderNoMatchingMedia();
      return;
    }

    const slide = state.slides[state.index];
    // The loading state is per-render: every render starts from a clean
    // class so a stale loader can never outlive the media it described.
    mediaBox.classList.remove("redditp__loading");
    // Revisiting a slide retries its media, so a past failure must not keep
    // forcing the timer path.
    slide.mediaFailed = false;
    slide.preloadFailed = false;
    slide.redgifsRefreshed = false;
    slide.redditpRedgifsSkip = "";
    title.textContent = visibleGalleryLabel(slide);
    const metaItems = [];
    if (slide.community) {
      const communityLink = element("a", "redditp__meta-link", slide.community);
      communityLink.href = redditPageUrl(slide.community, "community");
      communityLink.addEventListener("click", navigateToPresentation);
      metaItems.push(communityLink);
    }
    if (slide.author) {
      const authorLink = element("a", "redditp__meta-link", slide.author);
      authorLink.href = redditPageUrl(slide.author, "user");
      authorLink.addEventListener("click", navigateToPresentation);
      metaItems.push(authorLink);
    }
    meta.replaceChildren();
    metaItems.forEach((item, index) => {
      if (index) meta.append(document.createTextNode(" · "));
      meta.append(item);
    });
    meta.hidden =
      !state.settings.showDetails ||
      state.interfaceHidden ||
      metaItems.length === 0;
    // The media and comments destinations no longer render as buttons; the
    // keyboard shortcuts I and C open them in a new tab.

    if (slide.kind === "image") {
      const navKey = mediaPreloadKey(slide);
      const cachedImage = preloadReadyImage(slide);
      // A preload that is still fetching keeps its element. Displaying that
      // same element costs no second request, and it completes on the spot.
      const inflightImage = cachedImage ? null : inflightImageFor(slide);
      const img =
        cachedImage || inflightImage || element("img", "redditp__image", "");
      if (!cachedImage && !inflightImage) {
        img.alt = slide.title;
        img.addEventListener(
          "load",
          () => {
            clearDisplayWatchdog();
            expandLargeImage(img, slide);
            noteMediaReady(navKey);
          },
          { once: true },
        );
        img.addEventListener(
          "error",
          () => {
            clearDisplayWatchdog();
            showMediaFailure(img, slide);
          },
          {
            once: true,
          },
        );
        img.src = slide.url;
        recordNavigation(slide, false);
        noteCacheRead(false, slide);
      } else {
        img.className = "redditp__image";
        img.alt = slide.title;
        img.removeAttribute("width");
        img.removeAttribute("height");
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          expandLargeImage(img, slide);
        }
        if (inflightImage) {
          // The shared element is still loading; class and failure handling
          // settle with its events, and its src must not be touched again.
          if (!img.complete) {
            img.addEventListener(
              "load",
              () => {
                if (mediaBox.firstElementChild === img) {
                  expandLargeImage(img, slide);
                }
                clearDisplayWatchdog();
                noteMediaReady(navKey);
              },
              { once: true },
            );
          }
          img.addEventListener(
            "error",
            () => {
              clearDisplayWatchdog();
              showMediaFailure(img, slide);
            },
            {
              once: true,
            },
          );
        }
        recordNavigation(slide, Boolean(cachedImage || img.complete));
        noteCacheRead(true, slide);
      }
      mediaBox.append(img);
      // A displayed image that never settles must not hold the loader
      // forever: one fresh request, then the failure card (watchdog).
      armDisplayWatchdog(
        img,
        slide,
        () => img.complete && img.naturalWidth > 0,
        () => {
          img.src = slide.url;
          return true;
        },
      );
    } else if (
      slide.kind === "video" &&
      slide.redgifsId &&
      slide.redgifsFallback
    ) {
      // The resolved URL kept failing even after the bounded refresh: the
      // host's own /ifr player is the remaining way to watch this media.
      mediaBox.append(embedElement(slide));
    } else if (slide.kind === "video") {
      const navKey = mediaPreloadKey(slide);
      // DASH slides keep a src-free element: dash.js needs one without a
      // src-tagged stream behind it. The one exception is a prepared element
      // whose player is already attached and live, which is exactly what the
      // DASH preloader produced; reusing it starts the stream with no setup.
      // Other videos reuse a prepared element so metadata and the first
      // frame are already there.
      const cachedEntry = state.preloadCache.get(navKey);
      const cachedVideo =
        typeof HTMLVideoElement !== "undefined" &&
        cachedEntry instanceof HTMLVideoElement &&
        (!slide.mpdUrl ||
          cachedEntry.getAttribute("data-redditp-dash") === "attached")
          ? cachedEntry
          : null;
      if (cachedEntry && !cachedVideo && slide.mpdUrl) {
        // A prepared DASH entry whose bridge mark is gone is dead weight:
        // drop it here as well as in stopMedia, so an entry released
        // outside our own bookkeeping (a raced close, a retired overlay)
        // can neither be reused nor hold a video budget slot.
        state.preloadCache.delete(navKey);
        state.preloadRetry.delete(navKey);
        state.preloadStats.dashReleased += 1;
        debugLogEvent("preload-invalidated", {
          key: navKey,
          reason: "dash-released",
        });
        schedulePreloadQueue();
      }
      const inflightVideo = cachedVideo ? null : inflightVideoFor(slide);
      // Reuse an in-flight video element even before its metadata arrives so
      // navigation does not issue a second request for the same resource.
      const reusable = cachedVideo
        ? cachedVideo
        : inflightVideo && !inflightVideo.error
          ? inflightVideo
          : null;
      let fresh = false;
      let video;
      if (reusable) {
        video = reusable;
      } else {
        fresh = true;
        video = element("video", "redditp__video", "");
        video.preload = "metadata";
      }
      video.className = "redditp__video";
      video.poster = slide.poster || "";
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      video.muted = !state.settings.sound;
      trackMedia(video);
      // A reused element was registered the same way on an earlier display;
      // an identity mark keeps one error handler on it no matter how often
      // it comes back to the stage. The slide it falls back with is rebound
      // on every display so a stale slide can never set the wrong src.
      video.redditpErrorSlide = slide;
      if (!video.redditpErrorHooked) {
        video.redditpErrorHooked = true;
        video.addEventListener("error", () => {
          // Changing src resets video.error, so an error queued by the
          // attempt being replaced must not fail the fallback.
          if (video.error) playVideoFallback(video, video.redditpErrorSlide);
        });
      }
      // Lightweight loading state: a video with no frame to show yet gets
      // the CSS loader on the media box until data arrives or the display
      // fails. A prepared element already holding frames (or the deck of
      // cached media about to replay) pays the class removal, nothing else.
      if (video.readyState < (HTMLMediaElement.HAVE_CURRENT_DATA || 2)) {
        mediaBox.classList.add("redditp__loading");
        // Late events from a superseded element must not cut short the
        // current media's loader, and the loader must also clear when this
        // render's element ends in the failure card (where it is no longer
        // in the media box). The generation guards both.
        const clearLoader = () => {
          if (
            generation === renderGeneration &&
            mediaBox.classList.contains("redditp__loading")
          ) {
            mediaBox.classList.remove("redditp__loading");
          }
          // Data, failure, or playback: whichever arrives first, the loader
          // question is settled and the display watchdog stands down.
          clearDisplayWatchdog();
        };
        video.addEventListener("loadeddata", clearLoader, { once: true });
        video.addEventListener("error", clearLoader, { once: true });
        video.addEventListener("playing", clearLoader, { once: true });
      }
      const navStart = Date.now();
      const firstFrameEvidence = () => {
        // Initial media data, not metadata — this is the first-frame
        // instrumentation (11H) and feeds no navigation decisions.
        debugLogEvent("display-firstframe", {
          key: navKey,
          ms: Math.max(0, Date.now() - navStart),
          readyState: video.readyState,
        });
      };
      if (fresh) {
        video.addEventListener(
          "loadedmetadata",
          () => {
            noteVideoDuration(slide, video);
            noteMediaReady(navKey);
          },
          { once: true },
        );
        recordNavigation(slide, false, "fresh");
        noteCacheRead(false, slide);
      } else if (videoPreloadReady(video)) {
        recordNavigation(slide, true, "prepared");
        noteCacheRead(true, slide);
      } else {
        video.addEventListener(
          "loadedmetadata",
          () => {
            noteVideoDuration(slide, video);
            noteMediaReady(navKey);
          },
          { once: true },
        );
        recordNavigation(slide, false, cachedVideo ? "prepared" : "inflight");
        noteCacheRead(true, slide);
      }
      video.addEventListener("loadeddata", firstFrameEvidence, { once: true });
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // Data already present (shared element replaying): record at once.
        firstFrameEvidence();
      }
      mediaBox.append(video);
      // A displayed video that produces no data within the budget gets one
      // restarted request, then the failure card. DASH-attached elements
      // refuse the restart (a live MediaSource must not be torn down) and
      // take the failure path directly.
      armDisplayWatchdog(
        video,
        slide,
        () =>
          video.readyState >= (HTMLMediaElement.HAVE_CURRENT_DATA || 2) &&
          !video.error,
        () => restartDisplayElement(video),
      );
      if (
        slide.mpdUrl &&
        video.getAttribute("data-redditp-dash") === "attached"
      ) {
        // Prepared before navigation: the player is already wired up.
        playVideo(video);
      } else if (!slide.mpdUrl || !attachRedditDash(video, slide)) {
        video.redditpPlayingFallback = true;
        // Reusing an element that already carries the right src must not
        // reset it: assigning .src always restarts the element.
        if (video.getAttribute("src") !== slide.url) video.src = slide.url;
        playVideo(video);
      }
    } else if (slide.kind === "pending-native-video") {
      if (slide.poster) {
        const poster = element("img", "redditp__image", "");
        poster.alt = slide.title;
        poster.src = slide.poster;
        mediaBox.append(poster);
      } else {
        mediaBox.append(linkCard(slide, false));
      }
    } else if (
      slide.kind === "native-video" &&
      slide.nativeElement?.parentNode
    ) {
      const video = slide.nativeElement;
      const placeholder = document.createComment("redditp native video");
      video.parentNode.insertBefore(placeholder, video);
      state.nativeRestores.set(video, {
        placeholder,
        className: video.getAttribute("class"),
        style: video.getAttribute("style"),
        controls: video.controls,
        muted: video.muted,
        loop: video.loop,
        autoplay: video.autoplay,
      });
      video.className = "redditp__video";
      video.removeAttribute("style");
      video.controls = true;
      video.playsInline = true;
      video.autoplay = true;
      video.muted = !state.settings.sound;
      trackMedia(video);
      mediaBox.append(video);
      playVideo(video);
    } else if (slide.kind === "embed") {
      mediaBox.append(embedElement(slide));
      // A RedGIFs slide opened on directly resolves here: the scheduler only
      // looks ahead, so the first slide of a feed (or one reached while its
      // resolution was stopped) gets the same shared, counted resolution
      // and the same upgrade path. Its embed frame is already on screen,
      // so the viewer never waits with an empty stage either way.
      if (slide.redgifsId && !slide.redditpRedgifsSkip) {
        void resolveRedgifsMedia(slide.redgifsId).then((result) => {
          if (result.ok) {
            absorbRedgifsResult(slide, result);
          } else {
            slide.redditpRedgifsSkip = result.reason;
            state.preloadStats.redgifsFailed += 1;
            debugLogEvent("redgifs-still-embed", {
              key: mediaPreloadKey(slide),
              why: result.reason,
            });
          }
        });
      }
    } else {
      mediaBox.append(
        linkCard(
          slide,
          false,
          Boolean(slide.needsEnrichment && slide.commentsUrl),
        ),
      );
    }
    // The entering animation is applied to the element that was just built:
    // works identically for the next/previous post, gallery steps, auto
    // advance, numbered navigation, and the pagination continuation, since
    // they all funnel through this render.
    if (state.transition) applyIncomingTransition(state.transition);
    scheduleAuto();
    schedulePreloadQueue();
    void enrichSlide(slide);
    void upgradePendingAdaptiveSlide(slide);
    // Start loading on the last post's first slide so the next post is ready
    // by the time its gallery ends. The eligibility-aware placement keeps
    // this firing when the filters leave only the eligible tail navigable.
    if (!isSinglePostPage() && isOnLastEligiblePost()) {
      void loadMoreAtEnd(false);
    }
  }

  function move(delta) {
    if (!state.slides.length) return;
    if (delta < 0 && state.index === 0) return;
    if (
      delta > 0 &&
      isSinglePostPage() &&
      state.index === state.slides.length - 1
    ) {
      return;
    }
    if (state.loadingMore) {
      if (delta > 0 && state.index === state.slides.length - 1) {
        state.advanceAfterLoad = true;
        updateCount(true);
        return;
      }
      if (delta < 0 && state.index + delta < lastPostStart()) {
        state.loadRequest += 1;
        state.loadingMore = false;
        state.advanceAfterLoad = false;
        document.documentElement.style.overflow = "hidden";
      }
    }
    if (delta > 0 && state.index === state.slides.length - 1) {
      void loadMoreAtEnd(true);
      return;
    }
    // Duration eligibility is resolved once, here: the landing slide is
    // found by skipping whole excluded posts in the travelled direction,
    // bounded by the feed length and with explicit end-of-feed handling. A
    // plain step (the picture case) resolves to a plain step.
    const target = state.index + delta;
    const dest =
      delta > 0 ? forwardEligibleSlide(target) : backwardEligibleSlide(target);
    if (dest === null) {
      // Nothing eligible ahead in this direction until the feed grows; the
      // last-post advance still starts the scan like the unfiltered path.
      noteDurationSkips("navigation-skipped-long", state.index, target);
      if (delta > 0) void loadMoreAtEnd(true);
      return;
    }
    if (dest !== target) {
      noteDurationSkips("navigation-skipped-long", state.index, dest);
    }
    requestTransition(delta);
    state.index = dest;
    render();
  }

  function skipGallery() {
    const slide = state.slides[state.index];
    if (!slide) return;
    let nextIndex = state.index + 1;
    if (slide.galleryItem) {
      const identity = postIdentity(slide);
      while (
        nextIndex < state.slides.length &&
        postIdentity(state.slides[nextIndex]) === identity
      ) {
        nextIndex += 1;
      }
    }
    // Skipping a post with an excluded video must jump the whole post, so
    // the hop goes through move(), which resolves the duration policy
    // together with its loading and single-post bookkeeping.
    const dest =
      nextIndex <= state.slides.length - 1
        ? forwardEligibleSlide(nextIndex)
        : null;
    if (dest !== null) {
      move(dest - state.index);
      return;
    }
    // Settle on the last eligible slide before using the normal end-of-feed
    // path. An excluded tail must not be rendered to satisfy the settle.
    // This keeps loading, wrapping, and single-post boundaries in move().
    const lastEligible = backwardEligibleSlide(state.slides.length - 1);
    if (lastEligible !== null && lastEligible > state.index) {
      requestTransition(1);
      state.index = lastEligible;
      render();
    }
    move(1);
  }

  function previousPost() {
    if (!state.slides.length || state.index === 0) return;
    const identity = postIdentity(state.slides[state.index]);
    let start = state.index;
    while (start > 0 && postIdentity(state.slides[start - 1]) === identity) {
      start -= 1;
    }
    if (start === 0) return;
    const dest = previousEligiblePostStart(start - 1);
    if (dest === null) {
      noteDurationSkips("navigation-skipped-long", state.index, start);
      return;
    }
    state.index = dest;
    render();
  }

  function previousPostLast() {
    if (!state.slides.length || state.index === 0) return;
    const identity = postIdentity(state.slides[state.index]);
    let start = state.index;
    while (start > 0 && postIdentity(state.slides[start - 1]) === identity) {
      start -= 1;
    }
    if (start === 0) return;
    const dest = eligiblePostLastSlide(start - 1);
    if (dest === null) {
      noteDurationSkips("navigation-skipped-long", state.index, start);
      return;
    }
    requestTransition(-1);
    state.index = dest;
    render();
  }

  function lastPostStart() {
    const lastIndex = state.slides.length - 1;
    const identity = postIdentity(state.slides[lastIndex]);
    let start = lastIndex;
    while (start > 0 && postIdentity(state.slides[start - 1]) === identity) {
      start -= 1;
    }
    return start;
  }

  function isOnLastPost() {
    return state.slides.length > 0 && state.index >= lastPostStart();
  }

  // The raw feed and the navigable feed diverge when a mode filter or the
  // duration policy hides the tail: the user can reach the last eligible
  // post while raw posts still trail it, and those can never be "reached"
  // by navigation. Pagination must therefore trigger from the last post
  // that still holds navigable media — otherwise the loader never fires
  // and the feed stops growing (the 50-post stall).
  function lastEligiblePostStart() {
    for (let i = state.slides.length - 1; i >= 0; i -= 1) {
      if (slideEligibilityReason(state.slides[i])) continue;
      const identity = postIdentity(state.slides[i]);
      let start = i;
      while (start > 0 && postIdentity(state.slides[start - 1]) === identity) {
        start -= 1;
      }
      return start;
    }
    return -1;
  }

  // True also when nothing loaded is eligible: with zero navigable media the
  // only way out of the no-match stage is to keep scanning later batches, so
  // the placement check must not refuse to start the loader.
  function isOnLastEligiblePost() {
    if (!state.slides.length) return false;
    const start = lastEligiblePostStart();
    return start === -1 || state.index >= start;
  }

  function postIdentity(slide) {
    if (slide.postKey) return `post:${slide.postKey}`;
    if (slide.commentsUrl) return `comments:${slide.commentsUrl}`;
    return `fallback:${slide.title}|${slide.sourceUrl}`;
  }

  // The title's ("(2/7)") gallery counter. The extraction numbering (the
  // post's own media order) is used whenever the mode filter leaves the
  // gallery intact; when some of its slides are excluded the counter counts
  // the slidably visible subsequence instead, so the indicator always
  // describes what next/previous actually walk through.
  function visibleGalleryLabel(slide) {
    if (!slide || !slide.galleryItem) return slide ? slide.title : "";
    const identity = postIdentity(slide);
    let start = state.index;
    while (
      start > 0 &&
      state.slides[start - 1] &&
      postIdentity(state.slides[start - 1]) === identity
    ) {
      start -= 1;
    }
    let end = state.index + 1;
    while (
      end < state.slides.length &&
      postIdentity(state.slides[end]) === identity
    ) {
      end += 1;
    }
    let position = 0;
    let total = 0;
    for (let i = start; i < end; i += 1) {
      if (slideEligibilityReason(state.slides[i])) continue;
      total += 1;
      if (i < state.index) position += 1;
    }
    if (total > 0) {
      return `(${position + 1}/${total}) ${slide.title}`;
    }
    return `(${slide.galleryItem}/${slide.galleryTotal}) ${slide.title}`;
  }

  function appendNewPosts(root) {
    const existingPosts = new Set(state.slides.map(postIdentity));
    const additions = extractSlides(root).filter(
      (slide) => !existingPosts.has(postIdentity(slide)),
    );
    if (additions.length) {
      // Posts may keep arriving later than the scan gave up, so finding any
      // re-arms the end-of-feed loader.
      state.scanFailures = 0;
      state.slides.push(...additions);
      schedulePreloadQueue();
      // A feed whose first listing held one post disables auto-advance's
      // length guard, and the append above lifts it. Arm the timer here so
      // the shipped-on slideshow actually starts moving — but never disturb
      // a timer that is already counting down (or out) for the user.
      if (state.open && state.autoPlaying && !state.autoTimer) {
        scheduleAuto();
      }
    }
    return additions.length;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // Consecutive exhausting scans end the loading attempts for a while. It
  // resets when posts appear anywhere, when the viewer reopens, and when a
  // wrap-advance asks for the feed again, so live reddits keep loading.
  const SCAN_FAILURE_LIMIT = 2;

  async function loadMoreAtEnd(advanceWhenReady) {
    if (isSinglePostPage()) return;
    if (state.loadingMore) {
      if (advanceWhenReady) {
        state.advanceAfterLoad = true;
        updateCount(true);
      }
      return;
    }
    if (!state.open || !isOnLastEligiblePost()) return;

    if (state.scanFailures >= SCAN_FAILURE_LIMIT) {
      if (advanceWhenReady || state.advanceAfterLoad) {
        // The user asked to move past the end, so the feed gets a fresh
        // scan now instead of an instant wrap; passive arrivals stay cheap.
        state.scanFailures = 0;
        state.advanceAfterLoad = false;
      } else {
        // Do not burn four seconds of scrolling probes on a flowless
        // listing; still answer the navigation request immediately. The
        // counter resets when posts appear anywhere, when the viewer
        // reopens, and when a wrap-advance asks for the feed again.
        updateCount(false);
        return;
      }
    }

    state.loadingMore = true;
    state.advanceAfterLoad = Boolean(advanceWhenReady);
    const request = ++state.loadRequest;
    updateCount(true);

    let added = appendNewPosts(document);
    try {
      if (!added && state.nextPageUrl) {
        try {
          const doc = await fetchRedditDocument(state.nextPageUrl);
          if (!state.open || request !== state.loadRequest) return;
          state.nextPageUrl = nextPageUrl(doc);
          added = appendNewPosts(doc);
        } catch (_error) {
          // Reddit may rate-limit or return a challenge page. Wrap as at the
          // end of the listing and try this page again the next time around.
        }
      } else if (!added) {
        document.documentElement.style.overflow = state.oldOverflow;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const scrollingElement = document.scrollingElement;
          window.scrollTo(0, scrollingElement?.scrollHeight || 0);
          await wait(200);
          if (!state.open || request !== state.loadRequest) return;
          added = appendNewPosts(document);
          if (added) break;
        }
      }
    } finally {
      if (state.open && request === state.loadRequest) {
        document.documentElement.style.overflow = "hidden";
        state.loadingMore = false;
        state.scanFailures = added ? 0 : state.scanFailures + 1;
      }
    }

    if (!state.open || request !== state.loadRequest) return;
    debugLogEvent("load-more-scan", {
      request,
      added,
      scanFailures: state.scanFailures,
      advance: Boolean(state.advanceAfterLoad),
    });
    const shouldAdvance = state.advanceAfterLoad;
    state.advanceAfterLoad = false;
    if (added && shouldAdvance) {
      // The appended posts are brand new, so their durations are unknown and
      // provisionally eligible; the resolver only guards against an identity
      // that somehow arrived pre-excluded. When nothing in the additions is
      // eligible yet, stay put instead of parking the viewer on excluded
      // media — the next navigation or completed scan resolves again.
      const dest = forwardEligibleSlide(state.index + 1);
      if (dest !== null) {
        requestTransition(1);
        state.index = dest;
        render();
      } else {
        syncPresentationUi();
      }
    } else if (!added && shouldAdvance) {
      // Start the next lap with a fresh scan budget. Wrapping resolves the
      // whole feed's eligibility; without any eligible slide the viewer
      // stays in its explicit no-matching-media state rather than looping.
      state.scanFailures = 0;
      const wrapDest = forwardEligibleSlide(0);
      if (wrapDest !== null) {
        requestTransition(1);
        state.index = wrapDest;
        render();
      } else {
        syncPresentationUi();
      }
    } else if (added) {
      // The appended posts do not advance the current slide, but the count
      // and the numbered bar must reflect them right away.
      syncPresentationUi();
    } else {
      updateCount(false);
    }
  }

  function syncMediaLoop() {
    const playback = state.mediaPlayback;
    if (!playback) return;
    // Keep the first pass non-looping so its ended event can release a timer
    // that expired during playback. Later loops may be cut off by the timer.
    playback.video.loop =
      !state.autoPlaying ||
      (state.settings.loopShortMedia &&
        (!state.settings.finishMediaOnce || playback.completed));
  }

  // The slide's video drives auto-advance through these listeners, so they
  // are registered here, together with the playback they report on, and
  // removed again by untrackMedia when the slide changes.
  function trackMedia(video) {
    const playback = {
      video,
      completed: false,
      timerExpired: false,
      lastTime: 0,
      handlers: null,
    };
    const isCurrent = () => state.open && state.mediaPlayback === playback;
    // Once the timer has run out, only ended would advance the slide. A video
    // that stops short of its end gets one more slide timer instead.
    const stopped = () => {
      if (isCurrent() && playback.timerExpired && !state.autoTimer) {
        armAutoTimer();
      }
    };
    playback.handlers = {
      ended: () => {
        if (!isCurrent()) return;
        playback.completed = true;
        if (!state.autoPlaying) return;
        if (playback.timerExpired || !state.settings.loopShortMedia) {
          move(1);
        } else {
          syncMediaLoop();
          video.currentTime = 0;
          playVideo(video);
        }
      },
      // A looping video never fires ended. Its wrap from the end back to the
      // start still means the first pass has been watched.
      timeupdate: () => {
        if (!isCurrent()) return;
        // A displayed video is the authoritative source for its own
        // duration, so late discovery (a slow stream, an adaptive player
        // that reports duration after it started decoding) is picked up
        // while the slide stays on screen. Renewal is cheap: the recorder
        // only acts on a change.
        noteVideoDuration(state.slides[state.index], video);
        if (
          video.loop &&
          video.currentTime < playback.lastTime &&
          video.duration - playback.lastTime < 1
        ) {
          playback.completed = true;
        }
        playback.lastTime = video.currentTime;
      },
      pause: stopped,
      waiting: stopped,
      stalled: stopped,
      error: stopped,
    };
    Object.keys(playback.handlers).forEach((type) => {
      video.addEventListener(type, playback.handlers[type]);
    });
    state.mediaPlayback = playback;
  }

  function untrackMedia() {
    const playback = state.mediaPlayback;
    state.mediaPlayback = null;
    if (!playback) return;
    Object.keys(playback.handlers).forEach((type) => {
      playback.video.removeEventListener(type, playback.handlers[type]);
    });
  }

  function autoTimerFired() {
    state.autoTimer = null;
    const slide = state.slides[state.index];
    // A RedGIFs player loops, so the ordinary slide interval is not evidence
    // that its media finished. Wait for the bridge's completion report; a
    // paused completion recorded earlier advances after the resume timer,
    // matching the completed-video path. If the bridge never reports (for
    // example, injection was unavailable), the slide is safely held and
    // manual navigation remains available.
    if (isRedgifsEmbedSlide(slide) && state.settings.finishMediaOnce) {
      if (slide.redgifsCompleted) move(1);
      return;
    }
    const playback = state.mediaPlayback;
    const video = playback?.video;
    // Unknown, failed, blocked, or paused media must not trap auto-advance.
    // Buffering gets the benefit of the doubt once, when the timer first runs
    // out; a video still buffering a full slide timer later moves on.
    if (
      state.settings.finishMediaOnce &&
      playback &&
      !playback.completed &&
      !state.slides[state.index]?.mediaFailed &&
      Number.isFinite(video.duration) &&
      video.duration > 0 &&
      video.currentTime > 0 &&
      !video.paused &&
      !video.ended &&
      !video.error &&
      (!playback.timerExpired ||
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA)
    ) {
      playback.timerExpired = true;
      // A video already buffering fires no new waiting event, so check back.
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        armAutoTimer();
      }
      return;
    }
    move(1);
  }

  function armAutoTimer() {
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    if (state.autoPlaying && state.open && state.slides.length > 1) {
      state.autoTimer = setTimeout(
        autoTimerFired,
        state.settings.slideDurationSeconds * 1000,
      );
    }
  }

  function scheduleAuto() {
    if (state.mediaPlayback) state.mediaPlayback.timerExpired = false;
    syncMediaLoop();
    armAutoTimer();
  }

  // Playback preferences apply to the current video without restarting its
  // slide timer.
  function syncMediaPreferences() {
    syncMediaLoop();
    const playback = state.mediaPlayback;
    // With finishing turned off, a timer that already ran out no longer
    // holds the slide; give it one more slide timer rather than jumping away
    // from the settings panel.
    if (
      playback?.timerExpired &&
      !state.settings.finishMediaOnce &&
      !state.autoTimer
    ) {
      armAutoTimer();
    }
  }

  // Embeds point at a player page (youtube.com/embed/…), so prefer the post's
  // own link (youtube.com/watch?…) for them. Other kinds link the media file.
  function mediaHref(slide) {
    if (
      slide.kind === "embed" &&
      slide.sourceUrl &&
      slide.sourceUrl !== slide.commentsUrl
    )
      return slide.sourceUrl;
    // A DASH video's url is only its fallback rendition; the post's
    // v.redd.it link opens the whole video.
    if (slide.mpdUrl && slide.sourceUrl) return slide.sourceUrl;
    return slide.url || slide.sourceUrl || slide.commentsUrl;
  }

  function syncSettingsUi() {
    durationInput.value = String(state.settings.slideDurationSeconds);
    Object.keys(settingCheckboxes).forEach((key) => {
      settingCheckboxes[key].checked = state.settings[key];
    });
    transitionSelect.value = currentTransitionAnimation();
  }

  function openSettings() {
    state.settingsOpen = true;
    syncSettingsUi();
    settingsOverlay.hidden = false;
    settingsClose.focus({ preventScroll: true });
  }

  function closeSettings() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    settingsOverlay.hidden = true;
    // A hidden target cannot take focus; fall back to the close chip so the
    // keyboard user does not lose focus to the page when the bottom panel
    // setting was off.
    (!settingsButton.hidden ? settingsButton : closeButton).focus({
      preventScroll: true,
    });
  }

  function updateSetting(key, value) {
    state.settings[key] = value;
    saveSettings();
    // Display changes must not reload the image, restart playback, or reset
    // the current slide's timer. Only a new duration needs a fresh timer.
    syncPresentationUi();
    if (key === "slideDurationSeconds") scheduleAuto();
    else if (key === "finishMediaOnce" || key === "loopShortMedia") {
      syncMediaPreferences();
    }
  }

  // One place keeps the auto toggle's icon, accessible name, and pressed
  // state in sync with `state.autoPlaying`, so every entry point (user
  // toggle, open, close) paints the same play/pause visuals.
  function renderAutoButton() {
    setSvgMarkup(autoButton, state.autoPlaying ? pauseSvg : playSvg);
    autoButton.setAttribute(
      "aria-label",
      state.autoPlaying ? "Pause slideshow" : "Start slideshow",
    );
    autoButton.setAttribute("aria-pressed", String(state.autoPlaying));
  }

  const MEDIA_MODE_ICONS = {
    both: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M13 19v-1.5a3 3 0 0 1 6 0V19"/></svg>`,
    images: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
    videos: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`,
  };
  const MEDIA_MODE_TITLES = {
    both: "Show images and videos",
    images: "Show images only",
    videos: "Show videos only",
  };

  function currentMediaMode() {
    return MEDIA_MODE_KEYS.includes(state.settings.mediaMode)
      ? state.settings.mediaMode
      : "both";
  }

  function renderMediaModeButton() {
    const mode = currentMediaMode();
    setSvgMarkup(mediaModeButton, MEDIA_MODE_ICONS[mode]);
    mediaModeButton.title = `${MEDIA_MODE_TITLES[mode]} (cycle mode)`;
    mediaModeButton.setAttribute("aria-label", MEDIA_MODE_TITLES[mode]);
    mediaModeButton.dataset.mediaMode = mode;
  }

  // Cycling the mode keeps the feed where it is whenever the framed slide is
  // still allowed, and otherwise lands deterministically on the next
  // eligible slide (forward first, then backward, then the explicit
  // no-matching-media stage). Media that stays eligible is never restarted
  // and the preload cache is not cleared: eviction remains horizon-based.
  function cycleMediaMode() {
    const index = MEDIA_MODE_KEYS.indexOf(state.settings.mediaMode);
    state.settings.mediaMode =
      MEDIA_MODE_KEYS[(index + 1) % MEDIA_MODE_KEYS.length] || "both";
    saveSettings();
    renderMediaModeButton();
    debugLogEvent("media-mode", state.settings.mediaMode);
    reconcileMediaMode();
  }

  function reconcileMediaMode() {
    if (!state.open) {
      syncPresentationUi();
      return;
    }
    const current = state.slides[state.index];
    if (
      current &&
      !postDurationExclusionReason(postIdentity(current)) &&
      slideMediaModeEligible(current)
    ) {
      // Stay on the eligible slide: only the counters and the preload
      // priorities change, nothing about the displayed media does. The
      // title's gallery indicator, though, describes what next/previous
      // walk through the mode filter, so it must re-label here where the
      // other counters do.
      syncPresentationUi();
      if (state.slides[state.index]?.galleryItem) {
        title.textContent = visibleGalleryLabel(state.slides[state.index]);
      }
      schedulePreloadQueue();
      return;
    }
    const dest =
      forwardEligibleSlide(state.index) ??
      backwardEligibleSlide(state.index - 1);
    if (dest !== null && dest !== state.index) {
      state.index = dest;
    }
    render();
  }

  function toggleAuto() {
    state.autoPlaying = !state.autoPlaying;
    state.settings.autoAdvance = state.autoPlaying;
    saveSettings();
    renderAutoButton();
    scheduleAuto();
  }

  function toggleRotate() {
    state.rotation = (state.rotation + 90) % 360;
    syncPresentationUi();
  }

  function toggleHideInterface() {
    if (state.interfaceHidden === false && state.settingsOpen) closeSettings();
    state.interfaceHidden = !state.interfaceHidden;
    if (state.interfaceHidden) {
      state.settingsOpen = false;
      settingsOverlay.hidden = true;
    }
    syncPresentationUi();
  }

  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      root.requestFullscreen().catch(() => {});
    }
  }

  function playVideo(video) {
    // Navigation-relative playback start (Phase 7 instrumentation). Fires
    // only for the display path (preloader jobs never call playVideo), and
    // only lands in the bounded ring while localStorage debug is on.
    debugLogEvent("playback-start", {
      key: mediaPreloadKey(state.slides[state.index]),
      ms:
        state.lastNavigation &&
        Math.max(0, Date.now() - state.lastNavigation.startedAtMs),
      readyState: video.readyState,
    });
    video.play().catch((error) => {
      // The remembered sound setting can start a presentation without a user
      // gesture on the page, where browsers refuse unmuted autoplay. Play this
      // video muted instead; the setting stays on for later slides.
      if (error?.name !== "NotAllowedError" || video.muted) return;
      if (video.parentNode !== mediaBox) return;
      video.muted = true;
      video.play().catch(() => {});
    });
  }

  function currentEmbed() {
    return mediaBox.querySelector("iframe.redditp__embed");
  }

  // A RedGIFs embed can be the original slide or the last-resort fallback
  // after a direct rendition failed. Both are the same player frame and both
  // must wait for the bridge's completion report instead of the ordinary
  // image timer.
  function isRedgifsEmbedSlide(slide) {
    if (!slide || !slide.redgifsId) return false;
    return (
      slide.kind === "embed" ||
      (slide.kind === "video" && Boolean(slide.redgifsFallback))
    );
  }

  function resetRedgifsCompletion(slide) {
    if (!slide || !slide.redgifsId) return;
    slide.redgifsCompleted = false;
    slide.redgifsCompletionConsumed = false;
  }

  // Returns the frame only when it is the active slide's own RedGIFs player.
  // The media-id check keeps a message from one embed from completing a
  // different slide that happens to be current.
  function activeRedgifsEmbed(slide) {
    const embed = currentEmbed();
    if (!embed || !embed.contentWindow) return null;
    let source;
    try {
      source = new URL(embed.src);
    } catch (_error) {
      return null;
    }
    if (source.origin !== REDGIFS_EMBED_ORIGIN) return null;
    if (redgifsMediaId(source) !== slide.redgifsId) return null;
    return embed;
  }

  // A player frame is cross-origin, so its video cannot be touched from this
  // document and no amount of DOM work will reach it. Two things still are
  // possible: ask for the opening state in the frame URL, and speak a player's
  // own message protocol where it publishes one.
  function commandableEmbed() {
    const embed = currentEmbed();
    if (!embed) return null;
    try {
      return new URL(embed.src).origin === JS_API_EMBED_ORIGIN ? embed : null;
    } catch (_error) {
      return null;
    }
  }

  function sendEmbedSound() {
    const embed = commandableEmbed();
    if (!embed?.contentWindow) return;
    try {
      embed.contentWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: state.settings.sound ? "unMute" : "mute",
          args: [],
        }),
        JS_API_EMBED_ORIGIN,
      );
    } catch (_error) {
      // The frame went away between the click and the message.
    }
  }

  function initializeEmbed(embed) {
    if (embed !== commandableEmbed() || !embed.contentWindow) return;
    try {
      // YouTube's iframe protocol emits onReady after a parent announces that
      // it is listening. The load event alone can fire before the player is
      // ready to accept commands.
      embed.contentWindow.postMessage(
        JSON.stringify({ event: "listening", id: "redditp" }),
        JS_API_EMBED_ORIGIN,
      );
    } catch (_error) {
      return;
    }
    sendEmbedSound();
  }

  function onEmbedMessage(event) {
    if (event.origin !== JS_API_EMBED_ORIGIN) return;
    const embed = commandableEmbed();
    if (!embed?.contentWindow || event.source !== embed.contentWindow) return;
    let message = event.data;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch (_error) {
        return;
      }
    }
    if (message?.event === "onReady") sendEmbedSound();
  }

  // Parent half of the RedGIFs bridge. Every condition below is a gate: a
  // message that fails any one of them cannot move the slideshow.
  function onRedgifsMessage(event) {
    if (!state.open) return;
    if (event.origin !== REDGIFS_EMBED_ORIGIN) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.channel !== REDGIFS_BRIDGE_CHANNEL) return;
    if (message.version !== REDGIFS_BRIDGE_VERSION) return;
    if (message.type !== REDGIFS_BRIDGE_COMPLETION) return;
    const slide = state.slides[state.index];
    if (!isRedgifsEmbedSlide(slide)) return;
    const embed = activeRedgifsEmbed(slide);
    if (!embed || event.source !== embed.contentWindow) return;
    if (String(message.mediaId || "").toLowerCase() !== slide.redgifsId) return;
    // One completion per displayed player. A paused completion is recorded
    // but not consumed; the ordinary resume timer takes it from there.
    if (slide.redgifsCompletionConsumed || slide.redgifsCompleted) return;
    slide.redgifsCompleted = true;
    debugLogEvent("redgifs-completion", {
      key: mediaPreloadKey(slide),
      auto: state.autoPlaying,
    });
    if (!state.autoPlaying) return;
    // With finishing turned off the ordinary slide timer owns advancement,
    // exactly as it does for direct videos. The completed state is still
    // recorded for the timer and for a later resume.
    if (!state.settings.finishMediaOnce) return;
    slide.redgifsCompletionConsumed = true;
    move(1);
  }

  function toggleSound() {
    const video = mediaBox.querySelector("video");
    // Follow what the user hears: a video muted by the autoplay fallback is
    // silent even though the setting is on, so the toggle unmutes it.
    const sound = video ? video.muted : !state.settings.sound;
    updateSetting("sound", sound);
    if (video) video.muted = !sound;
    sendEmbedSound();
  }

  function toggleVideoFromSurface(event) {
    const video = event.target.closest?.("video.redditp__video");
    if (!video || event.button !== 0) return;
    const bounds = video.getBoundingClientRect();
    // Leave the browser's native control strip alone. Reddit also attaches a
    // click handler to its video element; intercept clicks on the picture so
    // the two handlers do not pause and immediately resume each other.
    if (event.clientY >= bounds.bottom - 56) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function releaseVideoFocus(event) {
    const video = event.target;
    if (
      video.tagName !== "VIDEO" ||
      document.activeElement !== video ||
      video.matches(":focus-visible")
    )
      return;
    // Clicking a native control such as mute, play or the seek bar focuses a
    // button inside the video's user-agent shadow root, and Chrome then stops
    // delivering key events to the page, so the arrow keys could no longer
    // change slides. Chrome does not dispatch the control's pointer events to
    // the page, so wait for the media event the control causes. Blurring on
    // focus instead would close the overflow menu as soon as it opened.
    // Keyboard users who tab into the player keep its native controls.
    video.blur();
  }

  function navigateToPresentation(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const href = event.currentTarget.href;
    close();
    location.assign(href);
  }

  function close() {
    if (!state.open && !state.opening) return;
    state.open = false;
    state.opening = false;
    state.autoPlaying = false;
    state.loadingMore = false;
    state.advanceAfterLoad = false;
    state.loadRequest += 1;
    state.openRequest += 1;
    state.settingsOpen = false;
    state.interfaceHidden = false;
    settingsOverlay.hidden = true;
    clearTimeout(state.autoTimer);
    // A transition must never outlive the viewer: the ghost layer is a
    // presentation surface, and closing refreshes the reader it sits over.
    cancelTransition();
    renderAutoButton();
    clearDisplayWatchdog();
    stopMedia();
    cancelPreloads();
    root.hidden = true;
    document.documentElement.style.overflow = state.oldOverflow;
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function retire() {
    close();
    root.remove();
    document.removeEventListener("redditp:presentation-retire", retire);
    window.removeEventListener("message", onEmbedMessage);
    window.removeEventListener("message", onRedgifsMessage);
  }

  async function open() {
    if (state.open || state.opening) return;
    const request = ++state.openRequest;
    state.opening = true;
    await loadSettings();
    if (request !== state.openRequest) {
      state.opening = false;
      return;
    }
    state.opening = false;
    state.oldOverflow = document.documentElement.style.overflow;
    state.open = true;
    // A fresh feed may be able to load more posts again.
    state.scanFailures = 0;
    state.autoPlaying = Boolean(state.settings.autoAdvance);
    renderAutoButton();
    renderMediaModeButton();
    state.interfaceHidden = Boolean(state.settings.startHidden);
    root.hidden = false;
    document.documentElement.style.overflow = "hidden";
    if (state.settings.startFullscreen && document.fullscreenEnabled) {
      root.requestFullscreen().catch(() => {});
    }
    document.addEventListener("keydown", onKeyDown, true);
    // Slides are rebuilt from the live page on every open, so the previous
    // run's enrichment results no longer refer to anything. Keeping them would
    // make enrichSlide skip every thumbnail it had already upgraded once.
    state.enrichments.clear();
    state.slides = [];
    emptyTitle.textContent = "Preparing Reddit video…";
    emptyText.textContent = "Waiting for Reddit's full-quality player.";
    render();
    await waitForAdaptivePlayer(request);
    if (!state.open || request !== state.openRequest) return;
    emptyTitle.textContent = "No posts found on this page";
    emptyText.textContent =
      "Scroll Reddit to load some posts, then try presentation mode again.";
    state.slides = extractSlides(document);
    state.nextPageUrl = nextPageUrl(document);
    state.index = Math.min(state.index, Math.max(0, state.slides.length - 1));
    render();
    // Focus whichever primary control is actually visible: the close button
    // is the usual anchor, and the settings chip stands in when close was
    // turned off. Hidden elements cannot take focus.
    const initialFocus = closeButton.hidden ? settingsButton : closeButton;
    initialFocus.focus({ preventScroll: true });
  }

  function focusableElements() {
    const container = state.settingsOpen ? settingsPanel : root;
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (element) => !element.hidden && element.getClientRects().length > 0,
    );
  }

  function trapFocus(event) {
    const focusable = focusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const container = state.settingsOpen ? settingsPanel : root;
    if (!container.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeyDown(event) {
    if (!state.open) return;
    // Never swallow browser and OS shortcuts such as Ctrl+F or Cmd+M; every
    // binding below is a bare key.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    )
      return;
    if (state.settingsOpen) {
      if (event.key === "Tab") {
        trapFocus(event);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSettings();
      }
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      // ArrowUp/ArrowDown keep the slide-level movement used before: the
      // gallery-aware branches resolved to the same move() call in both
      // cases, so the duplication is collapsed without changing behavior.
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
    } else if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      toggleAuto();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // The settings-open branch above never falls through to here, so the
      // only remaining choice is fullscreen first, then close.
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        close();
      }
    } else if (event.key.toLowerCase() === "f" && document.fullscreenEnabled) {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else root.requestFullscreen().catch(() => {});
    } else if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      toggleHideInterface();
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      toggleRotate();
    } else if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      toggleSound();
    } else if (event.key.toLowerCase() === "t") {
      event.preventDefault();
      updateSetting("showDetails", !state.settings.showDetails);
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      updateSetting("showControls", !state.settings.showControls);
    } else if (event.key.toLowerCase() === "c") {
      const slide = state.slides[state.index];
      if (!slide?.commentsUrl) return;
      event.preventDefault();
      window.open(slide.commentsUrl, "_blank", "noopener,noreferrer");
    } else if (event.key.toLowerCase() === "i") {
      const slide = state.slides[state.index];
      const href = slide && mediaHref(slide);
      if (!href) return;
      event.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
    } else if (event.key.toLowerCase() === "a") {
      event.preventDefault();
      toggleAuto();
    }
  }

  closeButton.addEventListener("click", close);
  settingsButton.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsOverlay.addEventListener("click", (event) => {
    if (event.target === settingsOverlay) closeSettings();
  });
  durationInput.addEventListener("change", () => {
    const seconds = Math.min(
      3600,
      Math.max(1, Math.round(Number(durationInput.value) || 1)),
    );
    durationInput.value = String(seconds);
    updateSetting("slideDurationSeconds", seconds);
  });
  transitionSelect.addEventListener("change", () => {
    updateSetting("transitionAnimation", transitionSelect.value);
  });
  Object.keys(settingCheckboxes).forEach((key) => {
    settingCheckboxes[key].addEventListener("change", () => {
      updateSetting(key, settingCheckboxes[key].checked);
    });
  });
  mediaBox.addEventListener("click", toggleVideoFromSurface, true);
  // After clicking "mute" and "unmute" the right-left arows failed to change
  // the current slide in Chrome (seemed to work in Firefox).
  // Media events do not bubble, so listen during capture.
  ["volumechange", "play", "pause", "seeked", "ratechange"].forEach((type) => {
    mediaBox.addEventListener(type, releaseVideoFocus, true);
  });
  document.addEventListener("redditp:presentation-retire", retire);
  window.addEventListener("message", onEmbedMessage);
  window.addEventListener("message", onRedgifsMessage);
  prevButton.addEventListener("click", () => move(-1));
  nextButton.addEventListener("click", () => move(1));
  autoButton.addEventListener("click", toggleAuto);
  mediaModeButton.addEventListener("click", cycleMediaMode);
  rotateButton.addEventListener("click", toggleRotate);
  hideButton.addEventListener("click", toggleHideInterface);
  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    syncPresentationUi();
  });
  window.addEventListener("resize", () => {
    syncPresentationUi();
  });
  root.addEventListener("pointerdown", (event) => {
    state.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      target: event.target,
      // Gestures starting in the bottom navigation row (count chip, numbered
      // strip, auto toggle — including the strip's transparent gaps) belong
      // to the row: the strip scrolls natively and the row never navigates
      // media.
      inControls: Boolean(
        event.target.closest?.(".redditp__controls, .redditp__numbers"),
      ),
    };
  });
  root.addEventListener("pointerup", (event) => {
    if (!state.pointerStart || state.pointerStart.id !== event.pointerId)
      return;
    const start = state.pointerStart;
    state.pointerStart = null;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // A gesture born in the bottom navigation row never navigates media, no
    // matter where it ends; the row scrolls itself.
    if (start.inControls) return;
    // Check if the tap target is the video element itself.
    const video = event.target.closest?.("video.redditp__video");
    const isVideoTarget = !!video;
    if (isVideoTarget) {
      // Determine if the tap is on the video's control strip (bottom area)
      // or on the video picture area. Controls should not navigate;
      // the picture area may navigate.
      const vidBounds = video.getBoundingClientRect();
      const tapY = event.clientY;
      // If the tap is on the lower 56px strip (native controls), do not navigate.
      if (tapY >= vidBounds.bottom - 56) return;
      // If the tap is on the video picture (above the controls), allow navigation.
      // Fall through to the zone-checking logic below.
    }
    // If the target is an interactive element that is not the video, skip navigation.
    const interactive = event.target.closest(
      "button, a, input, textarea, select, iframe",
    );
    // Allow navigation even if the target is a video, as long as it wasn't a control-tap
    // (handled above). For other interactive elements, still skip.
    if (interactive && !isVideoTarget) return;
    if (
      state.settings.swipeNavigation &&
      Math.abs(dx) > 55 &&
      Math.abs(dx) > Math.abs(dy)
    ) {
      // Swipes are post-level, matching the right/left tap zones: a swipe
      // left is the next post wherever the feed is (gallery included), a
      // swipe right returns to the previous post's last eligible slide.
      // The vertical guard (|dx| > |dy|) and the 55px threshold keep small
      // or vertical gestures from being read as horizontal navigation.
      if (dx < 0) skipGallery();
      else previousPostLast();
      return;
    }
    // Only a near-movement gesture counts as a tap: a bigger drag was
    // handled as a swipe above, and anything else is ignored so accidental
    // movement cannot trigger navigation.
    if (!state.settings.tapZones) return;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const rect = root.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    if (ratio < 0.33) {
      previousPostLast();
    } else if (ratio > 0.67) {
      skipGallery();
    } else {
      const slide = state.slides[state.index];
      // A gallery slide advances exactly one gallery image, and at the last
      // image moves through to the next post — move() runs the same
      // duration policy, wrap, and pagination the loaded end-of-feed
      // single-post page relies on.
      if (slide?.galleryItem) {
        move(1);
      } else {
        // An empty middle tap must never sit still on a single-image or
        // single-video post: the middle zone is exactly the "advance one
        // media step" zone, and only a gallery currently has one more.
        // Everything else behaves like next-post.
        skipGallery();
      }
    }
  });

  document.documentElement.append(root);
  window.__redditpPresentation = {
    toggle() {
      if (state.open || state.opening) close();
      else open();
    },
    // Injectable seam for the Random transition style: a deterministic
    // sampler can replace Math.random at runtime without any test-only
    // branch elsewhere. Passing anything that is not a function (including
    // null) restores the production sampler.
    setRandomSource(random) {
      state.randomSource = typeof random === "function" ? random : Math.random;
    },
    debug: {
      queue() {
        return state.preloadQueue.map((job) => ({
          key: job.key,
          title: job.slide?.title,
          galleryItem: job.slide?.galleryItem,
          kind: job.slide?.kind,
          url: job.slide?.url,
        }));
      },
      cache() {
        return Array.from(state.preloadCache.keys());
      },
      refresh() {
        schedulePreloadQueue();
        return state.preloadQueue.length;
      },
      // The most recent navigation render: destination identity, whether it
      // reused prepared media ("prepared" / "inflight" / "fresh"), and the
      // navigation-to-usable-media time (0 for prepared media, measured
      // milliseconds for a fresh fetch).
      lastNavigation() {
        return (
          state.lastNavigation && {
            index: state.lastNavigation.index,
            key: state.lastNavigation.key,
            kind: state.lastNavigation.kind,
            ready: state.lastNavigation.ready,
            reuse: state.lastNavigation.reuse || "",
            readyAfterMs: state.lastNavigation.readyAfterMs,
          }
        );
      },
      // Recent diagnostics, written only while localStorage.redditpDebug is
      // set; capped so a debug session cannot grow without bound.
      log() {
        return state.debugLog.slice();
      },
      stats() {
        return {
          ...state.preloadStats,
          inFlight: state.preloadInFlight.size,
          cacheSize: state.preloadCache.size,
          scanFailures: state.scanFailures,
          redgifsPending: redgifsResolutions.size,
        };
      },
      // Test/diagnostic snapshot: one immutable view of the state the
      // eligibility helpers see, so suites can assert on filtering reasons
      // instead of guessing from titles.
      snapshot() {
        return {
          open: state.open,
          index: state.index,
          mediaMode: state.settings.mediaMode,
          slides: state.slides.map((slide, i) => {
            const identity = postIdentity(slide);
            return {
              i,
              kind: slide.kind,
              redgifsId: slide.redgifsId || "",
              redgifsCompleted: Boolean(slide.redgifsCompleted),
              redgifsCompletionConsumed: Boolean(
                slide.redgifsCompletionConsumed,
              ),
              identity,
              durationReason: postDurationExclusionReason(identity),
              modeEligible: slideMediaModeEligible(slide),
              mediaMode: slideMediaModeEligible(slide)
                ? ""
                : "filtered-media-mode",
            };
          }),
        };
      },
    },
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.open) schedulePreloadQueue();
  });
  open();
})();
