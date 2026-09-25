// The content script's tool ops added for background agent work (0.43),
// against a DOM stub that models only what those ops touch: contenteditable
// fill through insertText and its fallback, an <input type=file> filled from
// base64, an eval whose promise is parked as a job, and a subframe that serves
// the world route but neither listens for messages nor holds a panel.
// Loaded as Safari loads it: one file, in a context whose global IS the
// content world's window.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class Evt { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
class El {
  constructor(tag, props = {}) { this.tagName = tag; this.events = []; this.focused = false; Object.assign(this, props); }
  focus() { this.focused = true; }
  dispatchEvent(e) { this.events.push(e.type + (e.inputType ? ":" + e.inputType : "")); return true; }
}
class HTMLInputElement extends El {}
class HTMLTextAreaElement extends El {}
// A FileList as DataTransfer hands one out, and the File it holds.
class File { constructor(parts, name, opts) { this.name = name; this.type = opts.type; this.size = parts[0].length; this.bytes = Array.from(parts[0]); } }
class DataTransfer {
  constructor() { const list = []; this.files = list; this.items = { add: (f) => list.push(f) }; }
}

// `execInsert` decides what document.execCommand("insertText") does to the
// focused editable: "works" writes the text as an editor would, "refused"
// returns false (a page or an engine that does not take the command).
function load({ top = true, elements = {}, execInsert = "works" } = {}) {
  const listeners = [];
  const document = {
    contentType: "text/html", hidden: false,
    documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml", style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
    body: { innerText: "body", children: [] },
    getElementById: () => null,
    querySelector: (sel) => elements[sel] || null,
    querySelectorAll: () => [],
    createRange: () => ({ selectNodeContents(el) { this.el = el; } }),
    execCommand(cmd, ui, value) {
      if (cmd !== "insertText" || execInsert === "refused") return false;
      const el = Object.values(elements).find((e) => e.focused && e.isContentEditable);
      if (el) { el.textContent = value; el.events.push("beforeinput:insertText", "input:insertText"); }
      return true;
    },
    addEventListener() {},
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, document, Event: Evt, InputEvent: Evt,
    HTMLInputElement, HTMLTextAreaElement, DataTransfer, File, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    browser: {
      runtime: { getURL: (p) => "safari-web-extension://TEST/" + p, onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async () => undefined },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.top = top ? ctx : {};
  vm.runInContext(SRC, ctx, { filename: "content.js" });
  const run = (msg) => ctx.__claudeSafari.run(msg);
  return { ctx, listeners, run };
}

test("a contenteditable is filled through insertText, replacing what was there", () => {
  const ed = new El("DIV", { isContentEditable: true, textContent: "old draft" });
  const env = load({ elements: { "#ed": ed } });
  const r = plain(env.run({ op: "fill", selector: "#ed", value: "Hello world" }));
  assert.deepEqual(r, { filled: "#ed", via: "insertText", matches: true });
  assert.equal(ed.textContent, "Hello world");
  assert.equal(ed.focused, true);
  assert.deepEqual(ed.events, ["beforeinput:insertText", "input:insertText"], "the editor saw a real edit, and only one");
});

test("where insertText is refused, the text is set directly and an input event sent", () => {
  const ed = new El("DIV", { isContentEditable: true, textContent: "old" });
  const env = load({ elements: { "#ed": ed }, execInsert: "refused" });
  assert.deepEqual(plain(env.run({ op: "fill", selector: "#ed", value: "new text" })), { filled: "#ed", via: "textContent", matches: true });
  assert.equal(ed.textContent, "new text");
  assert.deepEqual(ed.events, ["input:insertText"]);
});

test("an editor that took insertText but renders later is NOT overwritten", () => {
  // Lexical-style: the command is accepted and the DOM catches up a tick
  // later. Writing textContent over it would break the editor's model.
  const ed = new El("DIV", { isContentEditable: true, textContent: "old" });
  const env = load({ elements: { "#ed": ed }, execInsert: "works" });
  env.ctx.document.execCommand = () => true;             // accepted, nothing rendered yet
  const r = plain(env.run({ op: "fill", selector: "#ed", value: "new" }));
  assert.deepEqual(r, { filled: "#ed", via: "insertText", matches: false });
  assert.equal(ed.textContent, "old", "left for the editor to render");
  assert.deepEqual(ed.events, []);
});

test("a plain input keeps the native-setter path and its input/change pair", () => {
  const input = new HTMLInputElement("INPUT", { value: "" });
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    configurable: true, get() { return this._v || ""; }, set(v) { this._v = "via-setter:" + v; },
  });
  try {
    const env = load({ elements: { "#q": input } });
    assert.deepEqual(plain(env.run({ op: "fill", selector: "#q", value: "abc" })), { filled: "#q" });
    assert.equal(input._v, "via-setter:abc");
    assert.deepEqual(input.events, ["input", "change"]);
  } finally {
    delete HTMLInputElement.prototype.value;
  }
});

test("an upload builds the files from base64 and fires input and change", () => {
  const input = new HTMLInputElement("INPUT", { type: "file", multiple: true });
  const env = load({ elements: { "#f": input } });
  const r = plain(env.run({ op: "upload", selector: "#f", files: [
    { name: "a.txt", type: "text/plain", base64: Buffer.from("hi").toString("base64") },
    { name: "b.bin", type: "", base64: Buffer.from([0, 255, 7]).toString("base64") },
  ] }));
  assert.deepEqual(r, { uploaded: [{ name: "a.txt", size: 2 }, { name: "b.bin", size: 3 }], count: 2 });
  assert.deepEqual(input.files.map((f) => [f.name, f.type, f.bytes]), [["a.txt", "text/plain", [104, 105]], ["b.bin", "", [0, 255, 7]]]);
  assert.deepEqual(input.events, ["input", "change"]);
});

test("an upload refuses anything but a file input, and more files than the input takes", () => {
  const env = load({ elements: { "#t": new HTMLInputElement("INPUT", { type: "text" }), "#one": new HTMLInputElement("INPUT", { type: "file" }) } });
  const f = { name: "a", base64: "aGk=" };
  assert.throws(() => env.run({ op: "upload", selector: "#t", files: [f] }), /not an <input type=file>/);
  assert.throws(() => env.run({ op: "upload", selector: "#one", files: [f, f] }), /takes one file/);
  assert.throws(() => env.run({ op: "upload", selector: "#none", files: [f] }), /no element matched/);
});

test("an eval that returns a promise is parked as a job and read once when it settles", async () => {
  const env = load();
  const first = plain(env.run({ op: "eval", code: "new Promise((r) => setTimeout(() => r({ n: 7 }), 20))" }));
  assert.match(first.pending, /^j\d+-\d+$/);
  assert.deepEqual(plain(env.run({ op: "job", id: first.pending })), { pending: first.pending });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(plain(env.run({ op: "job", id: first.pending })), { value: { n: 7 } });
  assert.throws(() => env.run({ op: "job", id: first.pending }), /no pending eval/, "a job is read once");

  const rejected = plain(env.run({ op: "eval", code: "Promise.reject(new Error('nope'))" }));
  await new Promise((r) => setTimeout(r, 5));
  assert.throws(() => env.run({ op: "job", id: rejected.pending }), /nope/);
  // A plain value is still answered at once, as before.
  assert.deepEqual(plain(env.run({ op: "eval", code: "1 + 1" })), { value: 2 });
});

test("a subframe serves the world route but registers no message listener and holds no panel", () => {
  const input = new HTMLInputElement("INPUT", { type: "file" });
  const sub = load({ top: false, elements: { "#f": input } });
  assert.equal(sub.listeners.length, 0, "tabs.sendMessage without a frameId must never reach a subframe's answer");
  assert.equal(plain(sub.run({ op: "ping" })).ok, true);
  assert.throws(() => sub.run({ op: "togglePanel" }), /top frame/);
  const top = load({ top: true });
  assert.equal(top.listeners.length, 1);
});
