// Keep a live device stream playing when a Chrome-UA site unmutes it without a
// user gesture in ITS OWN document.
//
// The extension serves the sites in ua-chrome-sites.js a Chrome user agent, so
// they run their Chrome code paths, and those assume Chrome's autoplay policy:
// once the user has interacted with the page (or with the embedding page, for
// an iframe granted `allow="autoplay"`), script may unmute a playing video.
// WebKit's policy is stricter: an element with audio may only play UNMUTED
// while a user gesture is being handled in the element's own document.
// Unmuting a playing element outside one PAUSES it, and an unmuted play()
// outside one rejects with NotAllowedError. Muted playback is always allowed.
//
// The failure this fixes, measured on Safari 27.3 on 2026-11-06 (App
// Accessibility "Workflow Analyzer", iPhone 17 Pro, iOS 26):
//   - The scanner page (app-accessibility.browserstack.com) starts the device
//     in a CROSS-ORIGIN iframe (appaccessibility.browserstack.com/dashboard).
//     The user's click lands in the parent document; the iframe document never
//     sees a gesture (navigator.userActivation false/false).
//   - The iOS ReplayKit viewer plays the WebRTC stream muted (allowed), then,
//     with viewerParams.replayKitAudioEnabled, sets muted = false in the same
//     tick. Safari paused it immediately: a frozen first frame, readyState 4,
//     both tracks live, BsLive.state "displayed" -- every health flag green.
//   - Only a later real click INSIDE the iframe resumed it (the viewer's
//     click.unmuteVideo handler). App Live itself was unaffected: the device is
//     picked in the same document, and Safari honoured that.
// The viewer's plain attachMediaStream path calls an unmuted play() directly,
// which Safari refuses the same way.
//
// WHAT IT DOES. Safari is asked first, every time; the shim acts only on
// Safari's refusal, and only for an element whose srcObject is a MediaStream
// (a live stream -- marketing videos, loader clips and anything with a src URL
// keep Safari's policy untouched):
//   - muted = false on a playing stream with no gesture in progress: the
//     unmute is applied, and if Safari paused the element for it, the element
//     is muted and played again, and the unmute is queued.
//   - play() rejected with NotAllowedError on an unmuted stream: it is retried
//     muted; the returned promise settles with the retry, and the unmute is
//     queued.
//   - The queue is flushed on the first TRUSTED pointerdown, keydown or
//     touchend in this document, inside the gesture, so Safari allows it.
//   - Setting muted = true removes an element from the queue: a page that
//     mutes on purpose is never unmuted behind its back.
// So the stream is always visible, and its sound starts at the first
// interaction with the device frame instead of the frame staying frozen.
//
// Scope: registered with ua-consistency.js and webrtc-legacy-compat.js (same
// MAIN-world, all-frames registration, after them), so it runs exactly where
// the Chrome code paths are served, and self-gated on navigator.userAgent
// claiming Chrome as a second, independent gate. The wrapped play() mirrors
// `name`, `length` and a native-shaped toString, as the WebRTC shim does.
(function () {
  "use strict";
  if (window.__mediaAutoplayCompat__) return;
  window.__mediaAutoplayCompat__ = 1;
  if (!/Chrome\/\d+\./.test(navigator.userAgent)) return;

  var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (!proto) return;
  var mutedDesc = Object.getOwnPropertyDescriptor(proto, "muted");
  var nativePlay = proto.play;
  if (!mutedDesc || !mutedDesc.get || !mutedDesc.set || typeof nativePlay !== "function") return;
  var getMuted = mutedDesc.get;
  var setMuted = mutedDesc.set;

  var pending = new Set();          // elements whose unmute waits for a gesture

  function isLiveStream(el) {
    try {
      var s = el.srcObject;
      return !!s && (Object.prototype.toString.call(s) === "[object MediaStream]" ||
        (typeof window.MediaStream === "function" && s instanceof window.MediaStream));
    } catch (e) { return false; }
  }

  function inGesture() {
    var ua = navigator.userActivation;
    return !!(ua && ua.isActive);
  }

  function quietly(p) {
    if (p && typeof p.catch === "function") p.catch(function () {});
  }

  function queueUnmute(el) {
    pending.add(el);
    window.__mediaAutoplayCompat__ = 2;   // 2 = Safari refused at least once
  }

  function flush(ev) {
    if (!ev || !ev.isTrusted || !pending.size) return;
    var els = Array.from(pending);
    pending.clear();
    els.forEach(function (el) {
      try {
        if (el.isConnected === false) return;
        setMuted.call(el, false);
        if (el.paused) quietly(nativePlay.call(el));
      } catch (e) { /* never break the page's own handler for this */ }
    });
  }
  ["pointerdown", "keydown", "touchend"].forEach(function (type) {
    window.addEventListener(type, flush, true);
  });

  try {
    Object.defineProperty(proto, "muted", {
      configurable: true,
      enumerable: mutedDesc.enumerable,
      get: getMuted,
      set: function (value) {
        if (value) pending.delete(this);
        var rescue = !value && isLiveStream(this) && !this.paused && !inGesture();
        setMuted.call(this, value);
        // WebKit pauses synchronously when it refuses the unmute.
        if (!rescue || !this.paused) return;
        setMuted.call(this, true);
        quietly(nativePlay.call(this));
        queueUnmute(this);
      },
    });
  } catch (e) {
    return;   // a non-configurable accessor: leave Safari's behaviour alone
  }

  var play = function () {
    var el = this;
    var p = nativePlay.apply(el, arguments);
    if (!p || typeof p.then !== "function") return p;
    return p.catch(function (err) {
      var refused = err && err.name === "NotAllowedError";
      if (!refused || !isLiveStream(el) || getMuted.call(el) || inGesture()) throw err;
      setMuted.call(el, true);
      return nativePlay.call(el).then(
        function () { queueUnmute(el); },
        function () { setMuted.call(el, false); throw err; }
      );
    });
  };
  try {
    proto.play = play;
  } catch (e) {
    return;
  }
  try {
    Object.defineProperty(play, "length", { value: nativePlay.length });
    Object.defineProperty(play, "name", { value: "play" });
    Object.defineProperty(play, "toString", {
      value: function () { return "function play() { [native code] }"; },
      configurable: true, writable: true,
    });
  } catch (e) { /* cosmetic only */ }
})();
