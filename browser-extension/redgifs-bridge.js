(function redgifsBridge() {
  "use strict";

  // The bridge only exists for the embedded player frame. A top-level visit to
  // the same URL is a normal RedGIFs page and must stay untouched.
  if (window.top === window || window.parent === window) return;

  const CHANNEL = "redditp-redgifs";
  const VERSION = 1;
  const TYPE = "completion";
  // Experimentally validated loop boundary. RedGIFs loops its media, so the
  // native `ended` event never fires; the wrap from the end back to the start
  // is the completion signal instead.
  const LOOP_END_SECONDS = 0.75;
  const LOOP_START_SECONDS = 0.5;
  const MIN_DURATION_SECONDS = 1;

  // Only a genuine Reddit page may receive the report. The check is on the
  // parsed hostname, not a substring, so `reddit.com.example` and
  // `notreddit.com` never qualify.
  function redditReferrerOrigin() {
    if (!document.referrer) return "";
    let referrer;
    try {
      referrer = new URL(document.referrer);
    } catch (_error) {
      return "";
    }
    if (referrer.protocol !== "https:") return "";
    const host = referrer.hostname.toLowerCase();
    if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return "";
    return referrer.origin;
  }

  const parentOrigin = redditReferrerOrigin();
  if (!parentOrigin) return;

  function frameMediaId() {
    const match = location.pathname.match(/^\/ifr\/([\w-]+)(?:\/|$)/i);
    return match ? decodeURIComponent(match[1]).toLowerCase() : "";
  }

  const mediaId = frameMediaId();
  if (!mediaId) return;

  const videos = new WeakMap();
  let observer = null;

  function currentTimeOf(video) {
    const currentTime = Number(video.currentTime);
    return Number.isFinite(currentTime) ? currentTime : 0;
  }

  function sendCompletion() {
    try {
      window.parent.postMessage(
        {
          channel: CHANNEL,
          version: VERSION,
          type: TYPE,
          mediaId,
        },
        parentOrigin,
      );
    } catch (_error) {
      // The frame went away between the event and the report.
    }
  }

  // Duration changes can move the end of the timeline. Never compare a new
  // duration against a position recorded for the old one. This is a pure
  // bookkeeping reset: playback itself is never touched.
  function syncDuration(video, playback) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      if (Number.isFinite(playback.duration)) {
        playback.duration = NaN;
        playback.lastTime = currentTimeOf(video);
        playback.completed = false;
      }
      return;
    }
    if (
      Number.isFinite(playback.duration) &&
      Math.abs(duration - playback.duration) > 0.01
    ) {
      if (playback.lastTime > duration - LOOP_END_SECONDS) {
        playback.lastTime = currentTimeOf(video);
      }
      playback.completed = false;
    }
    playback.duration = duration;
  }

  function loopBoundaryReached(video, playback) {
    const duration = Number(video.duration);
    const currentTime = currentTimeOf(video);
    if (!Number.isFinite(duration) || duration <= MIN_DURATION_SECONDS) {
      return false;
    }
    if (video.paused || video.seeking) return false;
    return (
      playback.lastTime > duration - LOOP_END_SECONDS &&
      currentTime < LOOP_START_SECONDS &&
      currentTime + LOOP_START_SECONDS < playback.lastTime
    );
  }

  function reportOnce(video, playback) {
    if (playback.completed) return;
    playback.completed = true;
    sendCompletion();
  }

  function onTimeUpdate(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (!playback) return;
    syncDuration(video, playback);
    const currentTime = currentTimeOf(video);
    // A completed cycle may report again only after playback genuinely
    // advanced into a new cycle. Re-delivered events at the same boundary
    // therefore cannot produce a second report.
    if (
      playback.completed &&
      currentTime > LOOP_START_SECONDS &&
      currentTime < playback.duration - LOOP_END_SECONDS
    ) {
      playback.completed = false;
    }
    if (!playback.completed && loopBoundaryReached(video, playback)) {
      reportOnce(video, playback);
    }
    playback.lastTime = currentTime;
  }

  function onSeeked(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (!playback) return;
    syncDuration(video, playback);
    const currentTime = currentTimeOf(video);
    if (!playback.completed && loopBoundaryReached(video, playback)) {
      reportOnce(video, playback);
    }
    playback.lastTime = currentTime;
  }

  function onPlay(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (!playback) return;
    syncDuration(video, playback);
    // A fresh play from the start after a completed pass is a new cycle.
    if (playback.completed && currentTimeOf(video) < LOOP_START_SECONDS) {
      playback.completed = false;
    }
  }

  function onDurationChange(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (playback) syncDuration(video, playback);
  }

  function onEmptied(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (!playback) return;
    playback.duration = NaN;
    playback.lastTime = currentTimeOf(video);
    playback.completed = false;
  }

  function onEnded(event) {
    const video = event.currentTarget;
    const playback = videos.get(video);
    if (!playback) return;
    syncDuration(video, playback);
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= MIN_DURATION_SECONDS) return;
    // Native ended is the fallback for a future non-looping player build.
    reportOnce(video, playback);
    playback.lastTime = currentTimeOf(video);
  }

  const handlers = {
    timeupdate: onTimeUpdate,
    seeked: onSeeked,
    play: onPlay,
    durationchange: onDurationChange,
    emptied: onEmptied,
    ended: onEnded,
  };

  function trackVideo(video) {
    if (!(video instanceof HTMLVideoElement) || videos.has(video)) return;
    videos.set(video, {
      lastTime: currentTimeOf(video),
      duration: Number(video.duration),
      completed: false,
    });
    Object.keys(handlers).forEach((type) => {
      video.addEventListener(type, handlers[type]);
    });
  }

  function scan(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) {
      return;
    }
    if (root.nodeType === 1 && root.tagName === "VIDEO") trackVideo(root);
    if (typeof root.querySelectorAll === "function") {
      root.querySelectorAll("video").forEach(trackVideo);
    }
  }

  scan(document);
  // RedGIFs builds its player after initialization, so the video element can
  // appear long after this document_start script ran.
  observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach(scan);
    });
  });
  observer.observe(document, { childList: true, subtree: true });

  window.addEventListener(
    "pagehide",
    () => {
      if (observer) observer.disconnect();
      observer = null;
    },
    { once: true },
  );
})();
