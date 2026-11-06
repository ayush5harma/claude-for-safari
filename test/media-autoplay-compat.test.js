// media-autoplay-compat.js against a stub of WebKit's autoplay policy.
//
// The stub models the one rule the shim exists for (measured on Safari 27.3,
// 2026-11-06): a media element that carries audio may not be PLAYING UNMUTED
// unless a user gesture is in progress in its own document. Unmuting a playing
// element outside a gesture pauses it; an unmuted play() outside a gesture
// rejects with NotAllowedError. Muted playback is always allowed. The stub can
// also be told the page has sticky activation that Safari honours (App Live's
// top document), in which case nothing is paused and the shim must stay out of
// the way.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHIM = fs.readFileSync(
  path.join(__dirname, "..", "extension", "media-autoplay-compat.js"), "utf8");
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.3 Safari/605.1.15";

function makeWindow({ ua = CHROME_UA, allowUnmutedWithoutGesture = false } = {}) {
  const listeners = {};
  const activation = { isActive: false, hasBeenActive: false };

  class MediaStream {}
  class NotAllowedError extends Error { constructor() { super("not allowed"); this.name = "NotAllowedError"; } }

  function HTMLMediaElement() { this._muted = false; this._paused = true; this.srcObject = null; this.isConnected = true; }
  const allowed = () => activation.isActive || allowUnmutedWithoutGesture;
  Object.defineProperty(HTMLMediaElement.prototype, "muted", {
    configurable: true, enumerable: true,
    get() { return this._muted; },
    set(v) {
      this._muted = !!v;
      if (!this._muted && !this._paused && !allowed()) this._paused = true;   // WebKit: pause on unmute
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true, enumerable: true, get() { return this._paused; },
  });
  HTMLMediaElement.prototype.play = function play() {
    if (!this._muted && !allowed()) return Promise.reject(new NotAllowedError());
    this._paused = false;
    return Promise.resolve();
  };

  const win = {
    navigator: { userAgent: ua, userActivation: activation },
    HTMLMediaElement, MediaStream,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setTimeout,
    Promise, Object, Array, Set, Error,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SHIM, win);

  const element = (stream = true) => {
    const el = new HTMLMediaElement();
    if (stream) el.srcObject = new MediaStream();
    return el;
  };
  // A trusted user gesture: activation is live while the listeners run.
  const gesture = (type = "pointerdown") => {
    activation.isActive = true; activation.hasBeenActive = true;
    for (const fn of listeners[type] || []) fn({ type, isTrusted: true });
    activation.isActive = false;
  };
  const untrusted = (type = "pointerdown") => {
    for (const fn of listeners[type] || []) fn({ type, isTrusted: false });
  };
  return { win, element, gesture, untrusted, activation };
}

test("unmuting a playing live stream outside a gesture keeps it playing, muted", () => {
  const { element } = makeWindow();
  const v = element();
  v.muted = true;
  v.play();
  v.muted = false;                  // the viewer's ReplayKit-audio unmute
  assert.equal(v.paused, false, "Safari's pause was undone");
  assert.equal(v.muted, true, "it plays muted until a gesture");
});

test("the first trusted gesture turns the sound on", async () => {
  const { element, gesture, untrusted } = makeWindow();
  const v = element();
  v.muted = true; await v.play();
  v.muted = false;
  untrusted();                      // a scripted click is not a gesture
  assert.equal(v.muted, true);
  gesture("pointerdown");
  assert.equal(v.muted, false);
  assert.equal(v.paused, false);
});

test("a page that mutes again cancels the pending unmute", async () => {
  const { element, gesture } = makeWindow();
  const v = element();
  v.muted = true; await v.play();
  v.muted = false;
  v.muted = true;                   // the page changed its mind
  gesture();
  assert.equal(v.muted, true);
});

test("an unmuted play() that Safari refuses is retried muted and resolves", async () => {
  const { element, gesture } = makeWindow();
  const v = element();
  await v.play();                   // attachMediaStream's bare play()
  assert.equal(v.paused, false);
  assert.equal(v.muted, true);
  gesture("keydown");
  assert.equal(v.muted, false);
});

test("where Safari allows the unmute, the shim changes nothing", async () => {
  const { element } = makeWindow({ allowUnmutedWithoutGesture: true });
  const v = element();
  v.muted = true; await v.play();
  v.muted = false;
  assert.equal(v.muted, false);
  assert.equal(v.paused, false);
});

test("an unmute inside a gesture is passed straight through", async () => {
  const { element, activation } = makeWindow();
  const v = element();
  v.muted = true; await v.play();
  activation.isActive = true;
  v.muted = false;
  activation.isActive = false;
  assert.equal(v.muted, false);
  assert.equal(v.paused, false);
});

test("media that is not a live MediaStream keeps Safari's policy", async () => {
  const { element } = makeWindow();
  const clip = element(false);      // a marketing video, a loader clip
  await assert.rejects(clip.play(), { name: "NotAllowedError" });
  clip.muted = true; await clip.play();
  clip.muted = false;
  assert.equal(clip.paused, true, "Safari's pause stands");
});

test("a page whose UA patch did not take is left alone", async () => {
  const { element } = makeWindow({ ua: SAFARI_UA });
  const v = element();
  await assert.rejects(v.play(), { name: "NotAllowedError" });
});

test("the wrapped play keeps its name, arity and a native-looking toString", () => {
  const { win } = makeWindow();
  const play = win.HTMLMediaElement.prototype.play;
  assert.equal(play.name, "play");
  assert.equal(play.length, 0);
  assert.match(play.toString(), /\[native code\]/);
});
