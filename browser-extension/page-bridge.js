// Runs in the page's own JavaScript world (scripting.executeScript with
// world: "MAIN"), not in the extension's isolated world.
//
// v.redd.it keeps video and audio as separate DASH tracks, so a plain <video>
// can only play a silent rendition. Old Reddit already loads dash.js for its
// own player and exposes it as window.dashjs. This bridge lets content.js
// attach that player to a <video> it created, without bundling a copy.
//
// Protocol (DOM is shared between the worlds; JavaScript objects are not, so
// everything travels as attributes and plain events on the video element):
//   content.js sets data-redditp-mpd and dispatches "redditp:dash-attach".
//   The bridge answers synchronously by setting data-redditp-dash to
//   "attached" or "unavailable". Later playback errors arrive as
//   "redditp:dash-failed". "redditp:dash-reset" tears the player down.
//   Preparation progress is reported as a stage attribute plus a plain
//   "redditp:dash-stage" event: "manifest" (the MPD was fetched and parsed),
//   "segments" (the stream was initialized and segment requests start), and
//   "ready" (the player can start playback). content.js tracks these after
//   an attach so a speculative DASH job is only settled once real stream
//   work happened, not merely because the player object exists.
(function redditpPageBridge() {
  "use strict";

  if (window.__redditpPageBridge) return;
  window.__redditpPageBridge = true;

  var players = new WeakMap();

  // dash.js MediaPlayer.events members, resolved defensively: a build that
  // renamed or dropped one just reports no stage for it instead of breaking
  // the attach.
  var stageEventNames = [
    ["MANIFEST_LOADED", "manifest"],
    ["STREAM_INITIALIZED", "segments"],
    ["CAN_PLAY", "ready"],
  ];

  function reportStage(video, stage) {
    video.setAttribute("data-redditp-dash-stage", stage);
    video.dispatchEvent(new Event("redditp:dash-stage", { bubbles: true }));
  }

  function wireStageEvents(player, video, dash) {
    var events = (dash && dash.MediaPlayer && dash.MediaPlayer.events) || {};
    stageEventNames.forEach(function (pair) {
      var type = events[pair[0]];
      if (!type) return;
      try {
        player.on(type, function () {
          // A reset between the event and its dispatch must not report a
          // stage for a player the element no longer owns.
          if (players.get(video) !== player) return;
          reportStage(video, pair[1]);
        });
      } catch (_error) {
        // Stage reporting is diagnostics; the attach itself must not fail.
      }
    });
  }

  function reset(video) {
    var player = players.get(video);
    if (!player) return;
    players.delete(video);
    try {
      player.reset();
    } catch (_error) {
      // The element is being discarded either way.
    }
  }

  document.addEventListener(
    "redditp:dash-attach",
    function (event) {
      var video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      reset(video);
      video.removeAttribute("data-redditp-dash-stage");
      var url = video.getAttribute("data-redditp-mpd") || "";
      var dash = window.dashjs;
      if (
        !/^https:\/\/v\.redd\.it\//i.test(url) ||
        !dash ||
        typeof dash.MediaPlayer !== "function"
      ) {
        video.setAttribute("data-redditp-dash", "unavailable");
        return;
      }
      try {
        var player = dash.MediaPlayer().create();
        player.on(dash.MediaPlayer.events.ERROR, function () {
          if (players.get(video) !== player) return;
          reset(video);
          video.dispatchEvent(new Event("redditp:dash-failed"));
        });
        // Progress stages go out before initialize() so the earliest one
        // (the manifest) cannot be missed.
        wireStageEvents(player, video, dash);
        // content.js starts playback itself so it can fall back to muted
        // playback when the browser refuses autoplay with sound.
        players.set(video, player);
        player.initialize(video, url, false);
        video.setAttribute("data-redditp-dash", "attached");
      } catch (_error) {
        reset(video);
        video.setAttribute("data-redditp-dash", "unavailable");
      }
    },
    true,
  );

  document.addEventListener(
    "redditp:dash-reset",
    function (event) {
      if (event.target instanceof HTMLVideoElement) reset(event.target);
    },
    true,
  );
})();
