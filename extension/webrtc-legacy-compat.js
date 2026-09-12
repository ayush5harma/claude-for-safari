// Restore Chrome's legacy WebRTC callback semantics under the Chrome UA spoof.
//
// The extension serves the sites in ua-chrome-sites.js a Chrome user agent
// (ua-consistency.js patches navigator before this file runs — manifest
// order), so exactly those sites serve this browser their Chrome code paths.
// Chrome still accepts the pre-promise callback forms
//   pc.setLocalDescription(desc, successCb)
//   pc.setRemoteDescription(desc, successCb)
// and INVOKES the callback. In WebKit that callback is silently dropped, by
// either of two layers — both measured 2026-09-01 on Safari 27:
//
//   (1) Bare WebKit resolves the 2-arg call to the one-argument promise
//       overload: no throw, the description applies, the returned promise
//       resolves, the callback never runs. (Firefox throws instead.)
//   (2) webrtc-adapter, detecting "safari" from the AppleWebKit token that
//       survives inside the Chrome spoof, installs its own legacy shim:
//         function (e, t, r) { e = o.apply(this, [e]);
//                              return r ? (e.then(t, r), Promise.resolve()) : e }
//       which wires the callbacks ONLY when the error callback is also given
//       — the 2-arg form falls through the `: e` branch and drops successCb.
//
// The silent drop is the worst failure mode of the three: some WebRTC
// streaming viewers (ReplayKit, iOS >= 13.4) chain createAnswer inside
// exactly such a success callback, so the device's SDP offer applied, nothing
// errored, and no answer was ever created — a black stream with every health
// flag green. The matching 2-arg setLocalDescription drops the client's
// sendOffer the same way. A second product embedded the same viewer in a
// cross-origin iframe, which is why this rides the extension's all_frames
// injection. Both verified fixed live 2026-09-01.
//
// Because of layer (2), patching once at document_start is NOT enough: the
// page's adapter wraps our patch and drops the callback ABOVE us (verified
// live — the document_start-only version reproduced the black stream). So the
// wrap is applied twice: at document_start, where it fixes pages that never
// wrap the prototype, and again at window load — after adapter has installed
// its wrappers, so ours is outermost where it can still see the callbacks.
// The load-time pass re-wraps the CURRENT method (adapter's), which keeps
// adapter's own SDP munging in the chain; a closure-held WeakSet makes every
// pass idempotent without leaving a page-visible marker on the functions.
// Calls without callbacks pass through untouched, so spec-correct sites never
// see a difference.
//
// Scope: self-gated on navigator.userAgent actually claiming Chrome. Since
// the 2026-09-01 inversion that is true exactly where this shim is needed —
// the hosts on the effective site list, whose navigator ua-consistency.js has
// already patched by the time this runs (same registration, listed before this
// file) — i.e. precisely the sites served Chrome code paths. Since 0.36 the
// registration's `matches` already scopes this file to those hosts, so the
// check is a second, independent gate rather than the only one, and it is what
// keeps the shim off a page whose UA patch did not take. `length`, `name`, and a native-shaped toString are
// mirrored on the wrappers: adapters sniff arity to pick an API generation,
// and Function.prototype.toString is the cheapest integrity tell.
(function () {
  "use strict";
  if (window.__wrtcLegacyCompat__) return;
  window.__wrtcLegacyCompat__ = 1;
  if (!/Chrome\/\d+\./.test(navigator.userAgent)) return;

  var wrapped = new WeakSet();

  function wrapMethod(proto, method) {
    var current = proto[method];
    if (typeof current !== "function" || wrapped.has(current)) return;
    var wrapper = function (description, successCb, errorCb) {
      if (typeof successCb !== "function" && typeof errorCb !== "function") {
        // Modern promise call (including 0-arg implicit setLocalDescription).
        return current.apply(this, arguments);
      }
      var p = current.call(this, description);
      // `current` may be a page wrapper rather than the native method; treat
      // a non-promise return as an already-settled call.
      if (!p || typeof p.then !== "function") p = Promise.resolve(p);
      p.then(
        typeof successCb === "function"
          ? function () {
              // A callback that throws must surface like any event-loop
              // exception, not poison this internal chain.
              try { successCb(); } catch (e) { setTimeout(function () { throw e; }, 0); }
            }
          : undefined,
        function (err) {
          if (typeof errorCb === "function") {
            try { errorCb(err); } catch (e) { setTimeout(function () { throw e; }, 0); }
          } else {
            // No legacy error handler: rethrow async so the failure stays as
            // visible on the console as the pre-shim unhandled rejection was.
            setTimeout(function () { throw err; }, 0);
          }
        }
      );
      return p;
    };
    // The functional change first; cosmetics must not be able to abort it.
    try {
      proto[method] = wrapper;
    } catch (e) {
      return;   // frozen or hostile prototype: leave the current behavior alone
    }
    wrapped.add(wrapper);
    window.__wrtcLegacyCompat__ = 2;   // 2 = at least one method actually wrapped
    try {
      Object.defineProperty(wrapper, "length", { value: current.length });
      Object.defineProperty(wrapper, "name", { value: method });
      Object.defineProperty(wrapper, "toString", {
        value: function () { return "function " + method + "() { [native code] }"; },
        configurable: true, writable: true
      });
    } catch (e) { /* cosmetic only */ }
  }

  function applyPatch() {
    try {
      // Read the CURRENT global each time: pages (webrtc-adapter among them)
      // replace window.RTCPeerConnection wholesale, sharing the prototype
      // object with the class their instances are built from.
      var pc = window.RTCPeerConnection;
      var proto = pc && pc.prototype;
      if (!proto) return;
      wrapMethod(proto, "setLocalDescription");
      wrapMethod(proto, "setRemoteDescription");
    } catch (e) { /* never break the page for this */ }
  }

  applyPatch();                                          // document_start: bare pages
  addEventListener("load", applyPatch, { once: true });  // outermost after adapter
})();
