// The content script's half of the panel's open path, against a DOM stub small
// enough to be honest about what it is: enough document for the run-once
// guard, the world route and buildPanel's first decisions, and no more. It
// covers the rules a page cannot be trusted to respect -- which documents the
// panel can live in, what a failed build must leave behind, and what a second
// run does to the first -- which is exactly the part no browser test reached.
//
// The script is loaded the way Safari loads it: one file, evaluated in a
// context whose global IS the content world's window.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
const XHTML = "http://www.w3.org/1999/xhtml";

function makeStyle() {
  const map = new Map();
  return {
    setProperty: (k, v) => map.set(k, v),
    removeProperty: (k) => map.delete(k),
    getPropertyValue: (k) => map.get(k) || "",
    getPropertyPriority: () => "",
    get marginRight() { return map.get("margin-right") || ""; },
    get transition() { return map.get("transition") || ""; },
    declarations: map,
  };
}

// `shadow` decides what attachShadow does: "throw" is the page that refuses a
// shadow root (an XML document did, measured), "ok" gets far enough to fail on
// the markup instead. Either way buildPanel throws, which is the case under
// test -- a successful build needs a real DOM.
function load({ ns = XHTML, contentType = "text/html", shadow = "throw" } = {}) {
  const documentElement = {
    namespaceURI: ns,
    style: makeStyle(),
    appendChild() {},
    tagName: "HTML",
  };
  const made = [];
  const document = {
    contentType,
    hidden: false,
    documentElement,
    body: { innerText: "body text" },
    getElementById: () => null,
    querySelectorAll: () => [],
    createElementNS(namespace, tag) {
      const el = {
        namespaceURI: namespace, tagName: String(tag).toUpperCase(), id: "",
        style: makeStyle(), isConnected: false,
        remove() { this.removed = true; },
        attachShadow() {
          if (shadow === "throw") throw new Error("The operation is not supported.");
          return { innerHTML: "", getElementById: () => null, querySelector: () => null,
            addEventListener() {}, prepend() {} };
        },
      };
      made.push(el);
      return el;
    },
    createElement(tag) { return this.createElementNS(XHTML, tag); },
    addEventListener() {},
  };
  const listeners = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
    document,
    browser: {
      runtime: {
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: async () => undefined,
      },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    },
    CSSStyleSheet: function () { throw new Error("no constructed sheets in this stub"); },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { filename: "content.js" });
  return { ctx, document, documentElement, listeners, made };
}

test("the world route is published, and answers a ping", () => {
  const { ctx } = load();
  const w = ctx.window.__claudeSafari;
  assert.equal(typeof w.run, "function");
  assert.equal(w.ctx, "safari-web-extension://TEST/");
  assert.equal(ctx.window.__claudeSafariContent, "ready");
  // Field by field: objects made inside the vm realm are never
  // reference-equal to this realm's, which deepEqual insists on.
  const ping = w.run({ op: "ping" });
  assert.equal(ping.ok, true);
  assert.equal(ping.v, w.v);
  assert.equal(ping.hidden, false);
});

test("a document that is not HTML or XHTML is refused with the reason", () => {
  const { ctx, documentElement } = load({ ns: "http://www.w3.org/2000/svg", contentType: "image/svg+xml" });
  const run = ctx.window.__claudeSafari.run;
  assert.throws(() => run({ op: "togglePanel" }), /needs an HTML document.*image\/svg\+xml/);
  // and again: a refusal must not leave half-built state that makes the next
  // click a "close" instead of another attempt.
  assert.throws(() => run({ op: "togglePanel" }), /needs an HTML document/);
  assert.equal(documentElement.style.declarations.size, 0, "the page keeps its own inline styles");
});

test("text/plain is NOT refused: WebKit renders it as an HTML document", () => {
  const { ctx } = load({ contentType: "text/plain" });
  // It gets past the document check and fails further in (this stub has no
  // shadow DOM), which is the distinction the check exists to make.
  assert.throws(() => ctx.window.__claudeSafari.run({ op: "togglePanel" }), /operation is not supported/);
});

test("a failed build leaves nothing behind, so every click tries again", () => {
  const { ctx, made, documentElement } = load({ shadow: "throw" });
  const run = ctx.window.__claudeSafari.run;
  assert.throws(() => run({ op: "togglePanel" }), /operation is not supported/);
  assert.throws(() => run({ op: "togglePanel" }), /operation is not supported/,
    "the second click must build again, not close a panel that was never there");
  assert.equal(made.length, 2, "two attempts, two hosts");
  assert.ok(made.every((el) => el.removed), "each half-built host was removed");
  assert.equal(documentElement.style.declarations.size, 0, "and the page was not left pushed aside");
});

test("a second run in the same world is a no-op while the first still answers", () => {
  const { ctx } = load();
  const first = ctx.window.__claudeSafari;
  assert.equal(first.gen, 1);
  vm.runInContext(SRC, ctx, { filename: "content.js" });
  assert.equal(ctx.window.__claudeSafari.gen, 1, "the guard held: no second generation");
});

test("clearing the guard is what lets the next injection take the page over", () => {
  const { ctx, listeners } = load();
  const firstListener = listeners[0];
  const answered = firstListener({ op: "ping" });
  assert.equal(typeof (answered && answered.then), "function", "the live run answers a message");
  // what background.js's takeOver does:
  ctx.window.__claudeSafariContent = "stale";
  ctx.window.__claudeSafari.run = null;
  vm.runInContext(SRC, ctx, { filename: "content.js" });
  assert.equal(ctx.window.__claudeSafari.gen, 2, "the new run owns the world");
  assert.equal(typeof ctx.window.__claudeSafari.run, "function");
  assert.equal(firstListener({ op: "ping" }), undefined,
    "the superseded run's listener goes quiet, so one message cannot be answered twice");
  assert.equal(listeners.length, 2);
});
