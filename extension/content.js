// Claude for Safari — content script: the in-page half of the tool calls,
// plus the chat panel (a Claude-for-Chrome-style sidebar in a shadow DOM).
//
// Wrapped in a run-once guard: the background page injects this file ON
// DEMAND (tabs.executeScript) into pages that predate the extension or were
// only just granted access, and a second evaluation on a page that already
// has it would double-register the message listener — every togglePanel
// would then open AND close the panel in one click.
(() => {
// The guard is a STATE, not a flag (0.39): only "ready" -- the message
// listener below is installed -- stops a second run. A run that set a flag
// and then threw before its listener existed used to poison the page for
// good: every later injection returned here, every ping went unanswered,
// and the toolbar showed "content script did not answer after injection"
// with no way back but a reload. So anything but "ready" is re-run, and the
// listener is installed right after the tool ops, ahead of everything the
// panel needs, so the ops survive a panel-side failure.
//
// THE WORLD THIS STATE LIVES IN IS SHARED (0.40). Measured on Safari 27,
// 2026-09-16: one page has ONE content world for this extension, and every
// context of the extension -- one per Safari profile, plus any left behind by
// a bundle replaced under a running Safari -- injects into that same world.
// The first run is therefore the only one whose runtime.onMessage listener
// exists, and that listener answers only ITS OWN context's background page.
// On a plain static page opened seconds earlier, tabs.sendMessage from the
// very instance that had opened the tab resolved undefined, executeScript of
// this file returned at the guard above, and the toolbar reported "content
// script did not answer after injection": no panel, and every tool call on
// that tab failed. So the ops are ALSO published on the world below, where
// tabs.executeScript reaches them from any context, and the run that owns
// them is the newest one (GEN).
//
// The world object is not reachable from the page: measured on the same day
// with a page-world probe that reported window.__claudeSafari as undefined
// while the content script's run had already published it.
const CTX = (() => { try { return browser.runtime.getURL(""); } catch (e) { return ""; } })();
const world = (window.__claudeSafari && typeof window.__claudeSafari === "object")
  ? window.__claudeSafari
  : (window.__claudeSafari = {});
// A run whose ops are published serves every context, so a second context does
// not need its own run -- it calls through the world. Only a run that is gone
// or too old to publish them is replaced, and the background page asks for that
// by clearing this state (see takeOver in background.js).
if (window.__claudeSafariContent === "ready" && world.run) return;
window.__claudeSafariContent = "loading";
// Whatever a previous run left in the page goes with it: a takeover happens
// only when that run could not be reached, so its panel could not be closed
// either, and two panel hosts in one page would stack.
// (pushPage is hoisted, and only its `on === false` half runs here -- the half
// that touches no load-time constant. Keep it that way: this line runs before
// PANEL_FOOTPRINT and NARROW are initialised, and a ReferenceError here would
// be swallowed by the catch below, leaving the page silently pushed aside.)
try {
  const stale = document.getElementById("claude-safari-panel-host");
  if (stale) { stale.remove(); pushPage(false); }
} catch (e) {}
const GEN = (world.gen = (world.gen || 0) + 1);
// The content-script protocol version, reported on BOTH routes below. One
// constant, because ensureContent prefers the newest script in the page by
// this number and two spellings that disagreed would send it silently down the
// wrong route. background.js's CONTENT_V is its counterpart.
const V = 6;

// ── Tool ops (driven by Claude Code sessions via the bridge) ─────────────────

function findClickable(selector, text) {
  if (selector) return document.querySelector(selector);
  if (text) {
    const needle = text.trim().toLowerCase();
    const candidates = document.querySelectorAll(
      'a, button, [role="button"], input[type="submit"], input[type="button"], [onclick]'
    );
    for (const el of candidates) {
      const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label === needle) return el;
    }
    for (const el of candidates) {
      const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label.includes(needle)) return el;
    }
  }
  return null;
}

const ops = {
  // Liveness probe: Safari resolves sendMessage to a missing receiver with
  // undefined instead of throwing, so the background page detects "content
  // script present" only by this answering.
  // v is the content-script protocol version, reported by both routes (the
  // message listener and world.v) so a background page can tell which one it
  // reached and how old the script in the page is.
  ping() {
    return { ok: true, v: V, hidden: !!document.hidden };
  },

  read(msg) {
    const max = msg.maxChars || 120000;
    let text = document.body ? document.body.innerText : "";
    const truncated = text.length > max;
    if (truncated) text = text.slice(0, max);
    return {
      text,
      truncated,
      selection: String(window.getSelection() || ""),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, 200)
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href }))
        .filter((l) => l.text),
    };
  },

  click(msg) {
    const el = findClickable(msg.selector, msg.text);
    if (!el) throw new Error("no clickable element matched " + JSON.stringify(msg.selector || msg.text));
    el.scrollIntoView({ block: "center" });
    el.click();
    return { clicked: (el.innerText || el.value || msg.selector || msg.text || "").trim().slice(0, 120) };
  },

  fill(msg) {
    const el = document.querySelector(msg.selector);
    if (!el) throw new Error("no element matched selector " + JSON.stringify(msg.selector));
    el.focus();
    // Set via the native setter so frameworks (React et al.) see the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      setter.set.call(el, msg.value);
    } else {
      el.value = msg.value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: msg.selector };
  },

  eval(msg) {
    // Indirect eval: content-world scope, full DOM access. The result must
    // survive JSON, so coerce anything exotic to a string.
    const value = (0, eval)(msg.code);
    try {
      JSON.stringify(value);
      // undefined would be dropped by JSON on the way back and the caller would
      // read an empty object rather than "this evaluated to nothing".
      return { value: value === undefined ? null : value };
    } catch {
      return { value: String(value) };
    }
  },
};

// One entry point for every op, messaged or not. Synchronous on purpose: the
// world route below is a tabs.executeScript, whose value is the last
// expression and which does not await a promise.
function runOp(msg) {
  if (msg && msg.op === "togglePanel") return togglePanel(msg);
  const fn = msg && ops[msg.op];
  if (!fn) throw new Error("unknown op " + ((msg && msg.op) || ""));
  return fn(msg);
}

// Installed HERE, before the panel's constants and functions, so a failure
// anywhere below leaves ping/read/click/fill/eval working (togglePanel then
// fails on its own and says why). togglePanel is a function declaration, so
// it is already hoisted; ops is the table above.
//
// GEN keeps a superseded run's listener quiet. A takeover leaves the replaced
// run's listener registered (nothing can unregister it from here), and two
// listeners answering one togglePanel would open the panel and close it again
// in a single click. Returning undefined is what a listener says for a message
// that is not its own, so the current run's answer is still the one delivered.
browser.runtime.onMessage.addListener((msg) => {
  if (world.gen !== GEN) return undefined;
  if (!msg || (msg.op !== "togglePanel" && !ops[msg.op])) return undefined;   // not ours
  // Through runOp, and INSIDE the try: togglePanel used to be dispatched ahead
  // of it, so a synchronous throw from buildPanel left Safari resolving the
  // sender with undefined -- indistinguishable from "no listener" -- and the
  // background page's fallback then ran the same op a second time through the
  // world route.
  try {
    return Promise.resolve(runOp(msg));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
});
// The world route: reachable with tabs.executeScript from ANY context of this
// extension, which is what makes a page driveable by the profile that is
// actually asking rather than only by the one that injected first.
world.v = V;
world.ctx = CTX;
world.run = (msg) => (world.gen === GEN ? runOp(msg) : undefined);
window.__claudeSafariContent = "ready";

// ── Chat panel ───────────────────────────────────────────────────────────────
// Design matched to Claude for Chrome: near-black ground, assistant text with
// no bubble, user messages in soft cards, a floating rounded composer card
// holding context chips + input + controls, lavender circular send, coral
// Claude spark. All inside a closed shadow root so page CSS can't reach in.

let panelHost = null;
let panelApi = null;
let hostWatch = null;   // watches for a page removing the host (see buildPanel)
let chatSessionId = null;
let chatBusy = false;
let chatProvider = "claude";
let attachments = [];   // {name, type, dataUrl}
let tabChips = [];      // {tabId, title, url}

// Safari's own sidebar RESHAPES the content area rather than covering it —
// do the same: push the page left by the pane's width. Fixed-position site
// chrome ignores a root margin; the pane is near-opaque so those cases stay
// legible. Fully reverted on close.
const PANEL_FOOTPRINT = 360;
// Under 700px the panel is a full-width SHEET (see the phone-layout CSS), so
// shoving the page right-ward would just wedge a hidden margin under it.
// A media query that cannot throw at load: a page (or a world) without
// matchMedia gets a query that never matches and takes listeners quietly.
function mediaQuery(q) {
  try { const m = window.matchMedia(q); if (m) return m; } catch (e) {}
  return { matches: false, addEventListener() {}, removeEventListener() {} };
}
const NARROW = mediaQuery("(max-width: 700px)");
// Coarse pointer = a fingertip (iPhone, and an iPad with no trackpad). Gates
// the touch BEHAVIOURS in buildPanel — what the return key does, when the
// composer auto-focuses — independently of width: an iPad keeps the side-pane
// layout and still needs the finger rules. Sizing lives in the stylesheet's
// (pointer: coarse) block for the same reason.
const TOUCH = mediaQuery("(pointer: coarse)");
// On a phone the panel is presented like an iOS sheet: inset from the top by
// this much (the page shows, dimmed, above the rounded top corners), so the
// silhouette matches the system sheets the user sees everywhere else in iOS.
const SHEET_INSET = 14;
function pushPage(on) {
  try {
    const de = document.documentElement;
    if (on && NARROW.matches) return;
    if (on) {
      if (de.__claudePrevMR === undefined) de.__claudePrevMR = de.style.marginRight || "";
      // The transition is ours and has to go back too. It used to be set and
      // never removed, so every page the panel had been opened on kept
      // "transition: margin-right .22s ease-out" on its root element for the
      // rest of its life -- ours to clean up, and it also slowed down any
      // margin the page itself set afterwards (measured 2026-09-16: every page
      // in the matrix ended with that declaration still on <html>).
      if (de.__claudePrevTr === undefined) de.__claudePrevTr = de.style.transition || "";
      de.style.setProperty("transition", "margin-right .22s ease-out");
      de.style.setProperty("margin-right", PANEL_FOOTPRINT + "px", "important");
    } else {
      // Restore ONLY what was recorded. The push returns early on a narrow
      // viewport (the phone sheet does not move the page), so nothing was
      // recorded there, and an unconditional removeProperty would strip the
      // page's OWN inline margin-right or transition on every close.
      if (de.__claudePrevMR !== undefined) {
        if (de.__claudePrevMR) de.style.setProperty("margin-right", de.__claudePrevMR);
        else de.style.removeProperty("margin-right");
        delete de.__claudePrevMR;
      }
      if (de.__claudePrevTr !== undefined) {
        if (de.__claudePrevTr) de.style.setProperty("transition", de.__claudePrevTr);
        else de.style.removeProperty("transition");
        delete de.__claudePrevTr;
      }
    }
  } catch {}
}

// The real Claude spark artwork, shipped in the bundle (web_accessible_resources).
const SPARK_URL = (() => { try { return browser.runtime.getURL("images/spark.png"); } catch (e) { return ""; } })();


const SVG = {
  plus: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  at: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.95"/></svg>',
  up: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5.5M5.8 11.3L12 5l6.2 6.3"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  // Header glyphs. Deliberately a heavier stroke (1.9-2.0) than the inline
  // ones above: they sit on a filled material chip rather than on bare
  // ground, so a hairline reads as a smudge inside the circle. Shapes follow
  // the SF Symbols they stand in for — clock, square.and.pencil, xmark —
  // because those are the marks a Mac user already knows. SVG.x stays as it
  // is: the chip/history "remove" affordances are 11-13px and need the
  // lighter weight to stay legible at that size.
  fresh: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 4.8H8A3.2 3.2 0 0 0 4.8 8v8a3.2 3.2 0 0 0 3.2 3.2h8a3.2 3.2 0 0 0 3.2-3.2V9.4"/><path d="M13.2 10.6 18.6 5.2a1.7 1.7 0 0 1 2.2 2.2l-5.4 5.4-3 .8z"/></svg>',
  clock: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.1"/><path d="M12 7.1V12h4.1"/></svg>',
  close: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6"/></svg>',
  gear: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.2 12c0-.48-.05-.95-.14-1.4l2-1.55-1.9-3.3-2.35.95a7.3 7.3 0 0 0-2.42-1.4L13.9 2.8h-3.8l-.49 2.5a7.3 7.3 0 0 0-2.42 1.4l-2.35-.95-1.9 3.3 2 1.55a7.2 7.2 0 0 0 0 2.8l-2 1.55 1.9 3.3 2.35-.95a7.3 7.3 0 0 0 2.42 1.4l.49 2.5h3.8l.49-2.5a7.3 7.3 0 0 0 2.42-1.4l2.35.95 1.9-3.3-2-1.55c.09-.45.14-.92.14-1.4z"/></svg>',
  film: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/></svg>',
  mic: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M9 20.5h6"/></svg>',
};

// Empty-state starter prompts. Deliberately page-shaped (they all act on
// whatever is open) rather than generic assistant chatter, since the panel's
// whole premise is the current tab — and deliberately short enough to wrap two
// per row in a 360px pane. Kept as data, not markup, so the chips are built
// with textContent and can never inject into the shadow root.
const SUGGESTIONS = [
  "Summarise this page",
  "Key takeaways",
  "Explain it simply",
  "Find the main argument",
];

// Minimal, XSS-safe markdown: escape everything first, extract fenced code
// into placeholders, transform inline marks, then restore the code blocks.
function md(src) {
  const esc = String(src).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pres = [];
  let t = esc.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => {
    pres.push(c.replace(/\n$/, ""));
    return "\u0000PRE" + (pres.length - 1) + "\u0000";
  });
  t = t
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^#{1,4} (.+)$/gm, "<h4>$1</h4>")
    .replace(/^[-*] (.+)$/gm, '<div class="li">$1</div>')
    .replace(/^(\d+)\. (.+)$/gm, '<div class="li"><span class="ln">$1.</span>$2</div>')
    .replace(/\n/g, "<br/>");
  return t.replace(/\u0000PRE(\d+)\u0000(?:<br\/>)?/g, (_, i) => `<pre>${pres[+i]}</pre>`);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
// The icon comes from the tab itself (tabs.favIconUrl, forwarded by
// background.js) — the panel must not tell a third party which hosts are open,
// which a google.com/s2/favicons URL per tab did on every draw. Only the two
// shapes Safari actually reports are accepted, and the value is set as a
// PROPERTY on an <img> rather than interpolated into innerHTML: a page chooses
// its own favicon href, so it is attacker-controlled text.
function faviconImg(favIconUrl, cls) {
  const u = String(favIconUrl || "");
  if (!/^(https?:|data:image\/)/i.test(u)) return null;
  const img = document.createElement("img");
  if (cls) img.className = cls;
  img.src = u;
  img.onerror = () => img.remove();
  return img;
}

// The panel's stylesheet goes in as a CONSTRUCTED sheet, never as a <style>
// element: a page whose Content-Security-Policy has a style-src without
// 'unsafe-inline' blocks a <style> element's text even inside a closed shadow
// root (measured on claude.ai, 2026-09-15 -- an inline <style> probe did not
// apply there while it did on Calendar and Slack), and the panel rendered as
// bare markup: the spark at natural size, unstyled controls, a visible file
// input. CSSOM construction is not governed by style-src. The element is the
// fallback for a WebKit without adoptedStyleSheets (before 16.4). For the same
// reason the markup carries no style="" attribute: those are inline styles
// too, and the file input is hidden from the sheet instead.
function adoptStyles(root, css) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    return "constructed";
  } catch (e) {}
  const st = document.createElement("style");
  st.textContent = css;
  root.prepend(st);
  return "element";
}

function buildPanel() {
  // A document that is not HTML or XHTML has nowhere to put an HTML panel:
  // an .svg or .xml opened as a page renders only its own vocabulary, so an
  // HTML div appended to <svg> would be invisible even when it can be built.
  // Measured 2026-09-16 on an image/svg+xml document: createElement made a
  // null-namespace element WebKit refuses a shadow root on ("The operation is
  // not supported"), and with that fixed the markup below failed the XML
  // parser instead ("The string did not match the expected pattern"). Both
  // read as "the button does nothing", so say what is actually true. XHTML is
  // NOT refused: it renders HTML, and the markup below is XML-parseable (void
  // elements closed, the icons namespaced, no named entities) for its sake.
  // The test is the ROOT ELEMENT'S NAMESPACE, not the MIME type: WebKit serves
  // text/plain, and plenty of application/json, as an HTML document with a
  // synthesized <pre> body, where the panel works and did (a MIME allowlist
  // refused those by mistake). An SVG or XML root is the case that cannot
  // work.
  const docRoot = document.documentElement;
  if (!docRoot || docRoot.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    throw new Error("the panel needs an HTML document; this tab is " +
      (document.contentType || (docRoot && docRoot.namespaceURI) || "unknown"));
  }
  // A PLUGIN DOCUMENT passes the namespace test and is still nowhere to put a
  // panel. Safari's PDF viewer is one: an HTML document whose whole body is a
  // single <embed> filled by the viewer, so a panel appended to it is appended
  // to the viewer's own chrome and the page has no DOM of its own to read. The
  // MIME test 0.40 shipped refused these as a side effect of refusing text
  // types it should not have; this is the arm that was worth keeping. The
  // content type is the measured case (Safari 27 reports application/pdf);
  // the single-<embed> body is the general shape of it.
  const ctype = String(document.contentType || "").toLowerCase();
  const onlyChild = (document.body && document.body.children && document.body.children.length === 1)
    ? document.body.children[0] : null;
  const embedded = !!(onlyChild && /^(embed|object)$/i.test(String(onlyChild.tagName || "")) &&
    String((onlyChild.getAttribute && onlyChild.getAttribute("type")) || "").toLowerCase() === ctype);
  if (/\bpdf\b/.test(ctype) || embedded) {
    throw new Error("the panel needs a web page; this tab is " + (ctype || "a plugin document") +
      ", which Safari renders with its own viewer");
  }
  // createElementNS, not createElement: in an XML document createElement makes
  // a null-namespace element, and WebKit refuses a shadow root on one. An HTML
  // div is also what the stylesheet below assumes.
  panelHost = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  panelHost.id = "claude-safari-panel-host";
  // A shadow root keeps the page's CSS out of the panel; it does nothing about
  // the page's CSS reaching the HOST, and rules a page aims at unknown
  // elements do exactly that. Measured 2026-09-16: a page with
  // "div:empty { display: none !important }" -- the host has no light-DOM
  // children, so it matches -- computed display:none on it, and the toolbar
  // click "succeeded" with nothing on screen, which is the whole bug as a user
  // sees it. An inline declaration with !important outranks any author rule,
  // and set through CSSOM it is not an inline STYLE ATTRIBUTE, so a page whose
  // style-src forbids inline styles (0.39's case) does not block it.
  for (const [prop, value] of [
    ["display", "block"], ["visibility", "visible"], ["opacity", "1"],
    // The panel inside is position:fixed; a transform, filter, perspective,
    // backdrop-filter or contain on the host would make the host its
    // containing block and drag it into the page's scroll.
    ["transform", "none"], ["filter", "none"], ["perspective", "none"],
    ["contain", "none"], ["content-visibility", "visible"],
    ["clip-path", "none"], ["mask", "none"], ["pointer-events", "auto"],
    // A host the page floats, sizes or positions cannot move the fixed panel,
    // but it can take part in the page's own layout; keep it out of it.
    ["position", "static"], ["float", "none"], ["width", "auto"], ["height", "auto"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["max-width", "none"], ["max-height", "none"],
  ]) {
    try { panelHost.style.setProperty(prop, value, "important"); } catch (e) {}
  }
  const root = panelHost.attachShadow({ mode: "closed" });
  const css = `
      /* Native-material design: the panel is built like a Safari sidebar —
         translucent system-gray with backdrop blur, hairlines, system accent,
         both appearances via prefers-color-scheme — not a web widget. The one
         brand note is the coral spark. */
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel {
        --bg: rgba(28,28,30,0.62);
        /* Dark material must DARKEN the backdrop or a white page bleeds
           through and the panel turns milky. */
        --vibrancy: blur(52px) saturate(180%) brightness(0.55);
        --ovl: rgba(40,40,43,0.78);
        --ink: rgba(255,255,255,0.93);
        --ink2: rgba(255,255,255,0.55);
        --ink3: rgba(255,255,255,0.32);
        --line: rgba(255,255,255,0.09);
        --edge: rgba(255,255,255,0.14);
        --spec: rgba(255,255,255,0.10);
        --fill: rgba(255,255,255,0.07);
        --fill2: rgba(255,255,255,0.13);
        /* Control material: the translucent chip behind the header glyphs and
           the empty-state chips, after Apple's Siri panel. Kept SEPARATE from
           --fill/--fill2 (which are surfaces: the composer card, code blocks,
           context chips) because these three are interaction states of one
           control and have to move together — brightening a surface token to
           tune a hover would repaint the composer with it. */
        --ctl: rgba(255,255,255,0.09);
        --ctl2: rgba(255,255,255,0.15);
        --ctl3: rgba(255,255,255,0.21);
        --accent: #0A84FF;
        /* The sheet's OPAQUE tone: what the phone composer is painted with
           and what the host page's root is set to while the sheet is open,
           so Safari's floating-bar zone continues the sheet (see the root
           background note in buildPanel). */
        --solid: #1c1c1e;
        /* Single source of truth for the header's height: .hdr sizes itself
           to it and .histov (an absolutely-positioned overlay that must start
           exactly below the hairline) offsets by it. This used to be a magic
           37px inside .histov, which silently drifted the moment the header's
           padding or glyph size changed. */
        --hdr-h: 42px;
      }
      @media (prefers-color-scheme: light) {
        .panel {
          --bg: rgba(246,246,248,0.68);
          /* Light material lifts instead, so a dark page behind it does not
             drag the surface grey. */
          --vibrancy: blur(52px) saturate(180%) brightness(1.35);
          --ovl: rgba(252,252,254,0.82);
          --ink: rgba(0,0,0,0.88);
          --ink2: rgba(0,0,0,0.50);
          --ink3: rgba(0,0,0,0.30);
          --line: rgba(0,0,0,0.09);
          --edge: rgba(0,0,0,0.10);
          --spec: rgba(255,255,255,0.65);
          --fill: rgba(0,0,0,0.05);
          --fill2: rgba(0,0,0,0.085);
          /* NOT the mirror of the dark alphas. A 0.09 white veil on the dark
             ground is ~25 levels of separation; a 0.06 black veil on the light
             ground is only ~14, so the same numbers make the chips read as
             solid in dark and as barely-there in light. Matched by measured
             separation instead. */
          --ctl: rgba(0,0,0,0.08);
          --ctl2: rgba(0,0,0,0.13);
          --ctl3: rgba(0,0,0,0.18);
          --accent: #007AFF;
          --solid: #f6f6f8;
        }
      }
      /* Built like the macOS 27 Safari sidebar itself: a flush, flat,
         edge-to-edge pane in sidebar material — near-opaque with a whisper of
         vibrancy — separated from content by a single hairline. No island,
         no radius, no shadow: the window supplies the shape. */
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
        z-index: 2147483647; display: flex; flex-direction: column;
        background: var(--bg);
        /* THE ALPHA IS THE POINT. This was 0.965 — effectively opaque, so the
           blur behind it did nothing and the panel read as a flat slab beside
           Safari's own translucent sidebar. Real vibrancy needs the surface to
           actually transmit: ~0.62 dark / 0.68 light, with a blur radius in the
           50s and saturation pushed past 150% so colour behind it blooms the way
           macOS materials do rather than turning to grey mud. */
        -webkit-backdrop-filter: var(--vibrancy);
        backdrop-filter: var(--vibrancy);
        color: var(--ink);
        /* Inset hairline along the leading edge: the specular lip that makes an
           Apple material look like lit glass instead of tinted plastic. */
        box-shadow: inset 1px 0 0 var(--spec);
        border-left: 1px solid var(--line); overflow: hidden;
        font: 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        /* Touch: no grey tap flash (the :active states are the feedback), and
           a drag that starts on the pane's non-scrolling parts must not pan
           the host page underneath — touch-action: none blocks that at the
           pane, and each scroller below opts back in with pan-y. Inert for a
           mouse. */
        -webkit-tap-highlight-color: transparent; touch-action: none; }
      /* SAFETY NET. The translucent surface only works because the blur behind
         it supplies the contrast; with backdrop-filter unavailable the same
         alpha composites to a washed-out grey and the secondary text becomes
         unreadable over a light page. Anything that cannot blur gets a nearly
         opaque panel instead — plainer, but legible, which is the right way to
         lose. */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .panel { --bg: rgba(28,28,30,0.98); }
        .histov { --ovl: rgba(40,40,43,0.99); }
        @media (prefers-color-scheme: light) { .panel { --bg: rgba(246,246,248,0.98); } }
      }
      svg { width: 16px; height: 16px; display: block; }
      img.spark { display: block; }
      button { background: none; border: 0; color: var(--ink2); cursor: default;
        border-radius: 6px; padding: 4px; display: grid; place-items: center; }
      /* Every :hover in this sheet is gated on (hover: hover). On iOS a tapped
         element KEEPS :hover until the next tap lands elsewhere, so ungated
         hover paint left history rows and @-menu items stuck in accent after
         use. Touch feedback is the :active states in the (pointer: coarse)
         block; a mouse still gets every hover it had. */
      @media (hover: hover) { button:hover { background: var(--fill2); color: var(--ink); } }

      .hdr { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 14px;
        height: var(--hdr-h); flex: none;
        border-bottom: 1px solid var(--line); }
      .hdr .spark { width: 15px; height: 15px; }
      .hdr b { font-size: 13px; font-weight: 600; }
      .hdr .provider { flex: 1; text-align: left; color: var(--ink); font-weight: 600; }
      /* Header controls as light-on-dark material chips (Apple's Siri panel),
         not bare strokes: a soft translucent circle with no border, one
         monochrome glyph centred in it. 28px is both the optical size that
         balances the 13px title and the minimum comfortable hit target — the
         glyph inside stays 15px, so the fill supplies the target area rather
         than the mark having to grow to earn it. */
      .hdr .ctl { width: 28px; height: 28px; flex: none; padding: 0;
        border-radius: 50%; background: var(--ctl); color: var(--ink);
        transition: background .13s ease, transform .13s ease; }
      .hdr .ctl svg { width: 15px; height: 15px; }
      @media (hover: hover) { .hdr .ctl:hover { background: var(--ctl2); color: var(--ink); transform: scale(1.05); } }
      .hdr .ctl:active { background: var(--ctl3); transform: scale(.93); }
      .hdr .ctl:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

      .histov { position: absolute; top: var(--hdr-h); left: 0; right: 0; bottom: 0;
        background: var(--ovl);
        -webkit-backdrop-filter: var(--vibrancy);
        backdrop-filter: var(--vibrancy);
        z-index: 6; display: none; overflow-y: auto; padding: 8px;
        overscroll-behavior: contain; touch-action: pan-y; }
      .histov.open { display: block; }
      .hi-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border-radius: 8px; }
      @media (hover: hover) {
        .hi-item:hover { background: var(--accent); }
        .hi-item:hover .t, .hi-item:hover .d, .hi-item:hover button { color: #fff; }
      }
      .hi-item .col { flex: 1; min-width: 0; }
      .hi-item .t { font-size: 13px; color: var(--ink); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; display: block; }
      .hi-item .d { font-size: 11px; color: var(--ink2); }
      .hi-item button svg { width: 12px; height: 12px; }
      .hi-none { color: var(--ink2); font-size: 12px; text-align: center; padding: 26px 0; }

      .msgs { flex: 1; overflow-y: auto; padding: 10px 14px 6px; display: flex;
        flex-direction: column; gap: 12px;
        /* Scrolling stays inside the list: no chaining into the host page at
           either end, and only vertical panning (no double-tap zoom) on touch. */
        overscroll-behavior: contain; touch-action: pan-y; }
      .msgs::-webkit-scrollbar { width: 7px; }
      .msgs::-webkit-scrollbar-thumb { background: var(--fill2); border-radius: 4px; }

      /* Empty state, in three optically-spaced bands rather than one evenly
         spaced stack: the lede (spark + heading + hint) reads as ONE unit at a
         tight 7px, then 18px of air to the starter chips, then to "Add all
         tabs". Equal gaps made the four items look like an unfinished list;
         grouping them is what makes the middle of the panel read as considered
         rather than empty. The bottom padding is heavier than the top so the
         block sits fractionally above true centre — the optical centre of a
         pane whose bottom edge carries a composer. */
      .empty { flex: 1; display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 18px; padding: 14px 4px 24px; text-align: center; }
      .empty .lede { display: flex; flex-direction: column; align-items: center; gap: 12px; }
      /* The spark is the one piece of brand in the panel and it was a 26px
         afterthought floating in a large void. At 56px it anchors the empty
         state and gives the eye somewhere to land. The halo is a radial coral
         wash sized to the mark, which stops a saturated logo from looking
         pasted onto the glass — it sits UNDER the image via a wrapper so no
         filter touches the artwork itself. */
      .empty .mark { position: relative; display: grid; place-items: center;
        width: 92px; height: 92px; }
      .empty .mark::before { content: ""; position: absolute; inset: 0;
        border-radius: 50%;
        background: radial-gradient(circle at 50% 50%,
          rgba(217,119,87,0.20) 0%, rgba(217,119,87,0.09) 42%, transparent 70%); }
      .empty .spark { position: relative; width: 56px; height: 56px; opacity: .95; }
      .empty .hi { color: var(--ink); font-size: 16px; font-weight: 600;
        letter-spacing: -.015em; }
      .empty .sub { font-size: 11px; line-height: 1.55; color: var(--ink3); }
      /* Starter chips: same material as the header controls (--ctl), so the
         two sets of affordances read as one system. Wrapped and centred, with
         the max-width sized so the four SUGGESTIONS above pair into a 2x2 —
         a single column would look like a menu, four across like a toolbar.
         Nothing depends on that pairing holding: this is flex-wrap, so a
         longer string or a wider system font just reflows to 2/1/1 rather
         than overflowing the pane. */
      .sugg { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px;
        max-width: 318px; }
      .sugg .sg { display: inline-flex; align-items: center; min-height: 28px;
        padding: 6px 12px; border-radius: 999px;
        background: var(--ctl); color: var(--ink);
        font: 12px/1.35 -apple-system, "SF Pro Text", system-ui, sans-serif;
        transition: background .13s ease, transform .13s ease; }
      @media (hover: hover) { .sugg .sg:hover { background: var(--ctl2); color: var(--ink); transform: translateY(-1px); } }
      .sugg .sg:active { background: var(--ctl3); transform: none; }
      .sugg .sg:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .empty .addall { font: 12px -apple-system, sans-serif;
        color: var(--accent); background: var(--ctl);
        border-radius: 999px; padding: 5px 13px; min-height: 26px;
        transition: background .13s ease; }
      @media (hover: hover) { .empty .addall:hover { background: var(--ctl2); color: var(--accent); } }
      .empty .addall:active { background: var(--ctl3); }
      .empty .addall:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

      .m { max-width: 100%; overflow-wrap: break-word; }
      .m.u { align-self: flex-end; max-width: 85%; background: var(--accent);
        color: #fff; border-radius: 14px 14px 4px 14px; padding: 7px 11px;
        white-space: pre-wrap; }
      .m.u .att-note { display: block; margin-top: 4px; font-size: 10.5px;
        color: rgba(255,255,255,.78); }
      .m.c { color: var(--ink); }
      .m.c code { background: var(--fill); border-radius: 4px; padding: 1px 4px;
        font: 11.5px ui-monospace, "SF Mono", monospace; }
      .m.c pre { background: var(--fill); border: 1px solid var(--line);
        border-radius: 8px; padding: 9px 11px; margin: 6px 0; overflow-x: auto;
        font: 11.5px/1.5 ui-monospace, "SF Mono", monospace; white-space: pre; }
      .m.c a { color: var(--accent); text-decoration: none; }
      .m.c a:hover { text-decoration: underline; }
      .m.c h4 { font-size: 13px; margin: 7px 0 2px; }
      .m.c .li { padding-left: 13px; text-indent: -13px; margin: 2px 0; }
      .m.c .li::before { content: "•  "; color: var(--ink2); }
      .m.c .li .ln { color: var(--ink2); margin-right: 4px; }
      .m.c .li:has(.ln)::before { content: ""; }
      .m.err { color: #ff6961; font-size: 12px; }

      .think { display: flex; gap: 4px; padding: 4px 2px; }
      .think i { width: 5px; height: 5px; border-radius: 50%; background: var(--ink2);
        animation: pulse 1.2s ease-in-out infinite; }
      .think i:nth-child(2) { animation-delay: .18s; }
      .think i:nth-child(3) { animation-delay: .36s; }
      @keyframes pulse { 0%,70%,100% { opacity: .25; transform: scale(.85); }
        35% { opacity: 1; transform: scale(1); } }
      /* The header chips and starter chips change fill AND nudge on hover; the
         nudge is the part a reduced-motion user opted out of, so drop the
         transforms and the transitions but keep the colour states, which are
         what actually signal "this is pressable". */
      @media (prefers-reduced-motion: reduce) {
        .panel, .scrim { transition: none; }
        .think i { animation: none; opacity: .6; }
        .hdr .ctl, .sugg .sg, .empty .addall { transition: none; }
        .hdr .ctl:hover, .hdr .ctl:active, .sugg .sg:hover { transform: none; }
      }

      .composer { padding: 8px 10px 10px; position: relative;
        border-top: 1px solid var(--line); }
      .card { background: var(--fill); border: 1px solid var(--line);
        border-radius: 12px; padding: 7px 9px 6px;
        box-shadow: inset 0 1px 0 var(--spec);
        transition: border-color .12s, box-shadow .12s; }
      .card.focus { border-color: var(--accent);
        box-shadow: inset 0 1px 0 var(--spec),
          0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
      .card.drag { border-color: var(--accent); }
      .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
      .chips:empty { display: none; }
      .chip { display: inline-flex; align-items: center; gap: 5px; background: var(--fill2);
        border-radius: 6px; padding: 3px 4px 3px 6px; font-size: 11px;
        color: var(--ink); max-width: 170px; }
      .chip img.fav { width: 13px; height: 13px; border-radius: 3px; }
      .chip img.thumb { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; }
      .chip .fico svg { width: 13px; height: 13px; color: var(--ink2); }
      .chip .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip .h { color: var(--ink3); font-size: 10px; }
      .chip button { padding: 1px; border-radius: 4px; }
      .chip button svg { width: 11px; height: 11px; }
      .chip.bad { box-shadow: inset 0 0 0 1px #ff6961; }

      textarea { width: 100%; background: transparent; border: 0; outline: none;
        resize: none; color: var(--ink);
        font: 13px/1.45 -apple-system, system-ui, sans-serif;
        max-height: 120px; caret-color: var(--accent); }
      textarea::placeholder { color: var(--ink3); }

      .row { display: flex; align-items: center; gap: 1px; margin-top: 5px; }
      .row .gap { flex: 1; }
      select { background: transparent; border: 0; outline: none; color: var(--ink2);
        font: 11.5px -apple-system, sans-serif; -webkit-appearance: none;
        appearance: none; padding: 3px 2px; text-align: right; }
      @media (hover: hover) { select:hover { color: var(--ink); } }
      .send { width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
        color: #fff; margin-left: 6px; }
      @media (hover: hover) { .send:hover { background: var(--accent); color: #fff; filter: brightness(1.12); } }
      .send[disabled] { opacity: .35; }
      .send svg { width: 13px; height: 13px; }

      .menu { position: absolute; left: 10px; right: 10px; bottom: calc(100% - 4px);
        background: var(--ovl);
        -webkit-backdrop-filter: var(--vibrancy);
        backdrop-filter: var(--vibrancy);
        border: 1px solid var(--edge); border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0,0,0,.32), inset 0 1px 0 var(--spec);
        max-height: 250px; overflow-y: auto; padding: 4px; display: none;
        overscroll-behavior: contain; touch-action: pan-y; }
      .menu.open { display: block; }
      .mi { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
        border-radius: 7px; }
      .mi img { width: 15px; height: 15px; border-radius: 4px; }
      .mi .col { min-width: 0; }
      .mi .ti { font-size: 12.5px; color: var(--ink); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .mi .ho { font-size: 10.5px; color: var(--ink2); }
      .mi.sel { background: var(--accent); }
      .mi.sel .ti { color: #fff; }
      .mi.sel .ho { color: rgba(255,255,255,.75); }
      @media (hover: hover) {
        .mi:hover { background: var(--accent); }
        .mi:hover .ti { color: #fff; }
        .mi:hover .ho { color: rgba(255,255,255,.75); }
      }
      .mi.none { color: var(--ink2); font-size: 12px; }

      /* ── Hub settings overlay (gear) ── */
      .hubov { position: absolute; top: var(--hdr-h); left: 0; right: 0; bottom: 0;
        background: var(--ovl); z-index: 6; display: none; padding: 16px 14px;
        overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
      .hubov.open { display: block; }
      .hubov .lede2 { font-size: 12px; line-height: 1.55; color: var(--ink2);
        margin-bottom: 14px; }
      .hubov label { display: block; font-size: 11px; color: var(--ink2);
        margin-bottom: 10px; }
      .hubov input { display: block; width: 100%; margin-top: 4px;
        background: var(--fill); border: 1px solid var(--line); border-radius: 8px;
        padding: 7px 9px; color: var(--ink); outline: none;
        font: 12.5px -apple-system, system-ui, sans-serif; }
      .hubov input:focus { border-color: var(--accent); }
      /* The site-list box reuses the input's material but must be able to grow.
         The bare textarea rule above is the composer's and caps height at
         120px, so both dimensions are restated here. NO BACKTICKS anywhere in
         this stylesheet: it is a JS template literal, and one would end it. */
      .hubov textarea { display: block; width: 100%; margin-top: 4px;
        background: var(--fill); border: 1px solid var(--line); border-radius: 8px;
        padding: 7px 9px; color: var(--ink); outline: none; resize: vertical;
        min-height: 92px; max-height: 260px;
        font: 12px/1.5 ui-monospace, "SF Mono", monospace; }
      .hubov textarea:focus { border-color: var(--accent); }
      .hubov .sep { height: 1px; background: var(--line); margin: 16px 0 14px; }
      .hubrow { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
      .hubstat { flex: 1; font-size: 11.5px; color: var(--ink2); }
      .hubstat.ok { color: #46c46b; }
      .hubstat.bad { color: #ff6961; }
      .hubsave { background: var(--accent); color: #fff; border-radius: 8px;
        padding: 6px 14px; font-size: 12px; }
      /* Secondary action beside Save: the same shape in control material, so
         "Restore defaults" cannot be mistaken for the primary button. */
      .hubalt { background: var(--ctl); color: var(--ink); border-radius: 8px;
        padding: 6px 12px; font-size: 12px; }
      @media (hover: hover) {
        .hubsave:hover { filter: brightness(1.12); }
        .hubalt:hover { background: var(--ctl2); color: var(--ink); }
      }
      .hubalt:active { background: var(--ctl3); }

      /* The dimmed page behind the phone sheet; a tap on it dismisses, like
         tapping outside any iOS sheet. Never shown on desktop. */
      .scrim { position: fixed; inset: 0; z-index: 2147483646; display: none;
        background: rgba(0,0,0,0.38); opacity: 0; transition: opacity .32s ease-out; }
      .scrim.in { opacity: 1; }
      /* Presentation. The pane is built off-screen and slides in on the next
         frame (desktop from the right, matching the page push; phone from the
         bottom on the curve iOS uses for its sheets, with the scrim fading),
         and slides back out before it is removed. A header drag on the phone
         moves it with the finger under .drag (no transition), then springs
         back or completes the dismissal. */
      .panel { transform: translateX(100%); transition: transform .22s ease-out; }
      .panel.in { transform: none; }
      .panel.drag { transition: none; }
      /* Voice input: the mic turns coral while listening. Hidden by script
         when the Web Speech API is missing. */
      #mic.on { color: #d97757; background: var(--fill2); }

      /* ── Touch sizing (any coarse pointer: iPhone, iPad without a trackpad) ──
         Apple's comfortable minimum is a 44pt target; the pane's mouse-sized
         controls (24px composer buttons, a 26px send, 11px chip removers)
         missed under a fingertip half the time (seen live 2026-09-01, iPhone
         17 Pro). Targets grow here without the marks growing with them —
         where a bigger box would wreck the layout (header chips, chip and
         history removers) an invisible pseudo-element extends the hit area
         instead — and :active supplies the feedback the gated :hover used to.
         Desktop is untouched: (pointer: coarse) is false for every mouse and
         trackpad, and an iPad with a trackpad attached reports fine too. */
      @media (pointer: coarse) {
        .hdr .ctl { position: relative; }
        .hdr .ctl::before { content: ""; position: absolute; inset: -6px; border-radius: 50%; }
        .row { gap: 4px; margin-top: 6px; }
        .row button { width: 40px; height: 40px; border-radius: 10px; }
        .row button svg { width: 19px; height: 19px; }
        .send { width: 40px; height: 40px; border-radius: 50%; margin-left: 4px; }
        .send svg { width: 17px; height: 17px; }
        button:active { background: var(--fill2); color: var(--ink); }
        .send:active { background: var(--accent); color: #fff; filter: brightness(.85); }
        select { font-size: 14px; min-height: 40px; padding: 8px 6px; }
        .chip { padding: 5px 4px 5px 8px; font-size: 12.5px; max-width: 200px; }
        .chip button, .hi-item button { position: relative; padding: 3px; }
        /* Removers: the target grows less to the LEFT, where the label is — a
           tap on the last word of a chip must not remove it, and a history
           row's delete has no confirm. */
        .chip button::before, .hi-item button::before { content: "";
          position: absolute; inset: -8px -8px -8px -3px; }
        .chip button svg { width: 12px; height: 12px; }
        .hi-item { min-height: 50px; padding: 8px 12px; }
        .hi-item:active { background: var(--fill2); }
        .hi-item button svg { width: 14px; height: 14px; }
        .mi { min-height: 46px; padding: 7px 10px; }
        .mi:active { background: var(--fill2); }
        .sugg { gap: 8px; }
        .sugg .sg { min-height: 40px; padding: 8px 15px; font-size: 13.5px; }
        .empty .addall { min-height: 40px; padding: 8px 16px; font-size: 13.5px; }
        .hubov input { padding: 11px 12px; }
        .hubrow { margin-top: 10px; }
        .hubsave { min-height: 40px; padding: 8px 18px; font-size: 13.5px; }
        .hubsave:active { background: var(--accent); color: #fff; filter: brightness(.85); }
      }

      /* ── Phone layout (iPhone / narrow iPad windows) ──
         The 360px right-anchored pane is desktop furniture: on an iPhone 17
         Pro it left a sliver of page on the left and ignored the notch (seen
         live 2026-09-01). Under 700px the pane becomes an edge-to-edge sheet
         inset by the safe areas and sized to the VISUAL viewport by
         fitViewport(), so the software keyboard shrinks it instead of
         covering the composer; with handset type — 13px is a sidebar size,
         and beside a 17pt system body it read as fine print. The input takes
         16px: anything smaller makes iOS Safari zoom the whole page into the
         field on focus. */
      @media (max-width: 700px) {
        .scrim { display: block; }
        .panel { transform: translateY(100%);
          transition: transform .32s cubic-bezier(.32,.72,0,1); }
        .panel.in { transform: none; }
        /* Opaque composer: the bar zone below it is painted with the same
           --solid on the page root, so sheet and bar read as one surface. */
        .composer { background: var(--solid); }
        /* An iOS sheet, not a slab: rounded top corners over the dimmed page
           (fitViewport() insets the top by SHEET_INSET and extends the bottom
           under Safari's floating bar), a grabber, and no hairline edges. */
        .panel { left: 0; right: 0; width: auto; border-left: none;
          box-shadow: 0 -1px 0 var(--edge), 0 -12px 40px rgba(0,0,0,0.28);
          border-radius: 30px 30px 0 0;
          padding-top: 0;
          padding-bottom: env(safe-area-inset-bottom, 0px);
          --hdr-h: 58px; font-size: 15px; }
        .hdr { position: relative; padding: 12px 12px 0 16px; gap: 8px; }
        .hdr::before { content: ""; position: absolute; top: 7px; left: 50%;
          width: 36px; height: 5px; margin-left: -18px; border-radius: 3px;
          background: var(--ink3); }
        .hdr b { font-size: 17px; letter-spacing: -.01em; }
        .m.c, .m.u { font-size: 16px; line-height: 1.5; }
        .card { border-radius: 22px; padding: 10px 14px 8px; }
        /* iOS text fields do not glow when focused; a lifted border is enough. */
        .card.focus { box-shadow: inset 0 1px 0 var(--spec);
          border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
        .sugg .sg, .empty .addall { border-radius: 999px; }
        .hdr .ctl { width: 34px; height: 34px; }
        .hdr .ctl svg { width: 17px; height: 17px; }
        /* The overlays start below the header and share the sheet's corners. */
        .histov, .hubov { top: var(--hdr-h); border-radius: 30px 30px 0 0; }
        .msgs { padding: 12px 16px 8px; gap: 14px; }
        .empty .hi { font-size: 18px; }
        .empty .sub { font-size: 12.5px; }
        .sugg { max-width: 360px; }
        .m.u { max-width: 92%; padding: 9px 13px; border-radius: 16px 16px 5px 16px; }
        .m.u .att-note { font-size: 12px; }
        .m.c code { font-size: 13px; }
        .m.c pre { font-size: 12.5px; }
        .m.c h4 { font-size: 15px; }
        .m.err { font-size: 13.5px; }
        .hi-item .t { font-size: 15px; }
        .hi-item .d { font-size: 12px; }
        .mi .ti { font-size: 15px; }
        .mi .ho { font-size: 12px; }
        /* --vvh is the visual-viewport height fitViewport() publishes: with
           the keyboard up the @-menu must fit what is left above the composer. */
        .menu { left: 8px; right: 8px;
          max-height: min(260px, calc(var(--vvh, 100vh) - 150px)); }
        textarea, .hubov input { font-size: 16px; }
        .hubov { padding: 18px 16px; }
        .hubov .lede2 { font-size: 13.5px; }
        .hubov label { font-size: 12.5px; }
        .hubstat { font-size: 13px; }
      }
      #file { display: none; }
  `;
  root.innerHTML = `
    <div class="scrim" id="scrim"></div>
    <div class="panel">
      <div class="hdr">
        <img class="spark" src="${SPARK_URL}" alt=""/><b id="brand">Claude</b>
        <select class="provider" id="provider" title="Provider" aria-label="Provider">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <button class="ctl" id="hubbtn" title="Settings" aria-label="Settings">${SVG.gear}</button>
        <button class="ctl" id="hist" title="History" aria-label="History">${SVG.clock}</button>
        <button class="ctl" id="fresh" title="New chat" aria-label="New chat">${SVG.fresh}</button>
        <button class="ctl" id="close" title="Close" aria-label="Close">${SVG.close}</button>
      </div>
      <div class="histov" id="histov"></div>
      <div class="hubov" id="hubov">
        <div class="lede2">Where this panel's selected provider runs. Empty = the local
          Mac's bridge (127.0.0.1:29170). On iPhone/iPad, point it at a hosted
          or mesh hub — see HOSTING.md — with its token. Selecting Codex sends
          that turn's page, attached-tab and uploaded-file context to OpenAI
          through the configured hub.</div>
        <label>Hub URL
          <input id="huburl" type="url" placeholder="http://127.0.0.1:29170" autocomplete="off"/>
        </label>
        <label>Token
          <input id="hubtok" type="password" placeholder="only if the hub sets BRIDGE_TOKEN" autocomplete="off"/>
        </label>
        <div class="hubrow">
          <span class="hubstat" id="hubstat"></span>
          <button class="hubsave" id="hubsave">Save</button>
        </div>
        <div class="sep"></div>
        <div class="lede2">Sites served a Chrome user agent, for the few that
          refuse Safari (also under Safari Settings &gt; Extensions &gt; Claude
          for Safari &gt; Settings). One hostname per line; a bare hostname also covers its
          subdomains. A bare top-level domain is refused, and an international
          domain must be written in its punycode (xn--) form. Everywhere else
          Safari stays honest. Saving applies at once — reload a page that is
          already open.</div>
        <label>Sites served as Chrome
          <textarea id="uasites" rows="6" spellcheck="false" autocapitalize="off"
            autocorrect="off" autocomplete="off" placeholder="example.com"></textarea>
        </label>
        <div class="hubrow">
          <span class="hubstat" id="uastat"></span>
          <button class="hubalt" id="uareset">Restore defaults</button>
          <button class="hubsave" id="uasave">Save</button>
        </div>
      </div>
      <div class="msgs" id="msgs">
        <div class="empty" id="empty">
          <div class="lede">
            <span class="mark"><img class="spark" src="${SPARK_URL}" alt=""/></span>
            <div class="hi">How can I help you today?</div>
            <div class="sub">@ to add tabs&#160;&#160;·&#160;&#160;+ for images &amp; video&#160;&#160;·&#160;&#160;ask it to click, fill or open pages</div>
          </div>
          <div class="sugg" id="sugg"></div>
          <button class="addall" id="addall">Add all tabs</button>
        </div>
      </div>
      <div class="composer">
        <div class="menu" id="menu"></div>
        <div class="card" id="card">
          <div class="chips" id="chips"></div>
          <textarea id="in" rows="1" placeholder="Ask a question about this page…"></textarea>
          <div class="row">
            <button id="attach" title="Attach images or video" aria-label="Attach images or video">${SVG.plus}</button>
            <button id="mention" title="Add a tab as context" aria-label="Add a tab as context">${SVG.at}</button>
            <button id="mic" title="Voice input" aria-label="Voice input">${SVG.mic}</button>
            <span class="gap"></span>
            <select id="model" title="Model">
              <option value="">Default</option>
            </select>
            <button class="send" id="send" title="Send" aria-label="Send">${SVG.up}</button>
          </div>
        </div>
        <input type="file" id="file" multiple="multiple" accept="image/*,video/*"/>
      </div>
    </div>`;
  adoptStyles(root, css);

  const $ = (id) => root.getElementById(id);
  const msgs = $("msgs"), input = $("in"), chips = $("chips"),
        menu = $("menu"), card = $("card");
  const MODELS = {
    claude: [["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]],
    codex: [["gpt-6-astra", "Astra"], ["gpt-5.6-terra", "Terra"], ["gpt-5.6-sol", "Sol"], ["gpt-5.6-luna", "Luna"]],
  };
  function drawProvider(provider, model) {
    chatProvider = provider === "codex" ? "codex" : "claude";
    $("provider").value = chatProvider;
    $("brand").textContent = chatProvider === "codex" ? "Codex" : "Claude";
    const select = $("model");
    select.textContent = "";
    for (const [value, label] of MODELS[chatProvider]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = label;
      select.appendChild(option);
    }
    if (model && MODELS[chatProvider].some(([value]) => value === model)) select.value = model;
  }
  drawProvider(chatProvider);

  const updateEmpty = () => { $("empty").style.display = msgs.querySelector(".m") ? "none" : "flex"; };
  const addMsg = (cls, content, html) => {
    const d = document.createElement("div");
    d.className = "m " + cls;
    if (html) d.innerHTML = content; else d.textContent = content;
    msgs.appendChild(d);
    updateEmpty();
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  };
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 130) + "px"; };

  // ── chips ──
  function drawChips() {
    chips.textContent = "";
    for (const c of tabChips) {
      const el = document.createElement("span");
      el.className = "chip" + (c.bad ? " bad" : "");
      el.innerHTML = `<span class="t"></span><span class="h"></span><button title="Remove">${SVG.x}</button>`;
      el.querySelector(".t").textContent = c.title || hostOf(c.url);
      el.querySelector(".h").textContent = hostOf(c.url);
      const img = faviconImg(c.fav, "fav");
      if (img) el.insertBefore(img, el.firstChild);
      el.querySelector("button").onclick = () => { tabChips = tabChips.filter((x) => x !== c); drawChips(); };
      chips.appendChild(el);
    }
    for (const a of attachments) {
      const el = document.createElement("span");
      el.className = "chip";
      el.innerHTML = (a.type.startsWith("image/")
        ? `<img class="thumb" src="${a.dataUrl}"/>`
        : `<span class="fico">${SVG.film}</span>`) +
        `<span class="t"></span><button title="Remove">${SVG.x}</button>`;
      el.querySelector(".t").textContent = a.name;
      el.querySelector("button").onclick = () => { attachments = attachments.filter((x) => x !== a); drawChips(); };
      chips.appendChild(el);
    }
  }

  // ── attachments ──
  function pickFiles(list) {
    for (const f of Array.from(list || [])) {
      if (attachments.length + tabChips.length >= 6 || attachments.length >= 4) break;
      const isVideo = f.type.startsWith("video/");
      const cap = isVideo ? 25e6 : 10e6;
      if (f.size > cap) { addMsg("err", `"${f.name}" is too large (${isVideo ? "25" : "10"} MB max)`); continue; }
      const r = new FileReader();
      r.onload = () => { attachments.push({ name: f.name, type: f.type || "application/octet-stream", dataUrl: r.result }); drawChips(); };
      r.readAsDataURL(f);
    }
  }
  $("attach").onclick = () => $("file").click();
  $("file").onchange = (e) => { pickFiles(e.target.files); e.target.value = ""; };
  input.addEventListener("paste", (e) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
      e.preventDefault();
      pickFiles(e.clipboardData.files);
    }
  });
  // Drop anywhere on the PANEL, not just the composer card — Safari navigates
  // to a dropped file the moment you miss the card. And dragging an image OFF
  // a webpage carries a URL rather than a file: the background page fetches
  // it (host permissions beat page CORS) and returns a data URL.
  const panelEl = root.querySelector(".panel");

  // ── Viewport fit (touch keyboards) ──
  // iOS does not shrink the LAYOUT viewport for the software keyboard: it
  // shrinks the VISUAL viewport and scrolls the page until the focused field
  // shows. A fixed, full-height sheet is laid out against the layout viewport,
  // so with the keyboard up its composer sat under the keys, Safari scrolled
  // the host page to reach the textarea, and the sheet slid off the top with
  // the page showing through beneath it (seen live 2026-09-01, iPhone 17
  // Pro). Sizing the sheet to the visual viewport on every resize and scroll
  // keeps it exactly over what is visible, keyboard or not. Desktop: NARROW
  // is false, nothing is set, the stylesheet alone applies.
  const vv = window.visualViewport;
  const openScrollY = window.scrollY;
  function fitViewport(e) {
    if (!vv || !NARROW.matches) {
      for (const p of ["top", "height", "bottom", "padding-bottom", "--vvh"]) panelEl.style.removeProperty(p);
      return;
    }
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    // Geometry: the sheet starts SHEET_INSET below the visible top (the
    // dimmed page shows above its rounded corners) and runs to the bottom of
    // the LAYOUT viewport — under Safari's floating bottom bar and under the
    // keyboard — while padding-bottom lifts the composer to the visible
    // bottom. Stopping the box at the visual viewport instead left a band of
    // bare page showing between the composer and the keyboard's accessory bar
    // (seen live 2026-09-02, iPhone 17 Pro), because Safari reserves that band
    // for its URL pill and reports the visual viewport as ending above it.
    const top = vv.offsetTop + SHEET_INSET;
    const gap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    panelEl.style.setProperty("top", top + "px");
    panelEl.style.setProperty("height", Math.max(200, window.innerHeight - top) + "px");
    panelEl.style.setProperty("bottom", "auto");
    panelEl.style.setProperty("padding-bottom", gap + "px");
    panelEl.style.setProperty("--vvh", Math.max(200, vv.height - SHEET_INSET) + "px");
    // The keyboard takes its share from the message list: keep the newest
    // turn in view when the reader was already at the end (a resize), but
    // never yank someone who scrolled up to reread (a plain vv scroll).
    if (e && e.type === "resize" && nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }
  if (vv) { vv.addEventListener("resize", fitViewport); vv.addEventListener("scroll", fitViewport); }
  NARROW.addEventListener("change", fitViewport);
  fitViewport();

  // The band between the composer and Safari's floating bar on the phone is
  // Safari's own bar zone: outside both viewports, so no element can paint
  // there, and Safari fills it with the PAGE's root background (black on a
  // dark article, white on a light page — a strip that made the sheet look
  // bolted on, seen live 2026-09-02). The one lever that reaches it is the
  // root background itself: while the sheet is open the page root takes the
  // sheet's --solid tone and the composer is painted with the same solid,
  // so the zone continues the sheet. Restored exactly on close.
  const de = document.documentElement;
  const scrimEl = $("scrim");
  let rootBgPrev = null, themeMeta = null, themeMetaPrev = null, themeMetaAdded = false;
  if (NARROW.matches) {
    const solid = getComputedStyle(panelEl).getPropertyValue("--solid").trim() || "#1c1c1e";
    rootBgPrev = { value: de.style.getPropertyValue("background-color"), priority: de.style.getPropertyPriority("background-color") };
    de.style.setProperty("background-color", solid, "important");
    themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) { themeMetaPrev = themeMeta.getAttribute("content"); themeMeta.setAttribute("content", solid); }
    else if (document.head) {
      themeMeta = document.createElement("meta"); themeMeta.name = "theme-color"; themeMeta.content = solid;
      document.head.appendChild(themeMeta); themeMetaAdded = true;
    }
  }

  // Everything the sheet did to the window, undone. Both close paths (the X,
  // and a toolbar toggle from the background page) go through
  // panelApi.close, so neither can leave a listener resizing a removed node
  // — or the page scrolled to wherever iOS dragged it to reach the composer:
  // it goes back to where the reader was.
  const teardown = () => {
    if (hostWatch) { try { hostWatch.disconnect(); } catch (e) {} hostWatch = null; }
    if (rec) { try { rec.stop(); } catch {} }
    if (vv) { vv.removeEventListener("resize", fitViewport); vv.removeEventListener("scroll", fitViewport); }
    NARROW.removeEventListener("change", fitViewport);
    if (rootBgPrev) {
      if (rootBgPrev.value) de.style.setProperty("background-color", rootBgPrev.value, rootBgPrev.priority);
      else de.style.removeProperty("background-color");
    }
    if (themeMeta) { if (themeMetaAdded) themeMeta.remove(); else if (themeMetaPrev !== null) themeMeta.setAttribute("content", themeMetaPrev); }
    if (NARROW.matches && window.scrollY !== openScrollY) window.scrollTo(window.scrollX, openScrollY);
  };
  // Close = slide out, then remove. panelHost is cleared at once so a second
  // toolbar click during the exit builds a fresh pane instead of toggling
  // the departing one.
  let closing = false;
  const closePanel = () => {
    if (closing) return;
    closing = true;
    saveConvo(); teardown(); pushPage(false);
    const host = panelHost; panelHost = null; panelApi = null;
    // A dismissal that starts mid-drag must animate from where the finger
    // left the sheet: re-enable the transition first (.drag off), commit
    // that, THEN retarget to the off-screen position.
    panelEl.classList.remove("drag");
    void panelEl.offsetHeight;
    panelEl.classList.remove("in");
    panelEl.style.removeProperty("transform");
    scrimEl.classList.remove("in");
    scrimEl.style.removeProperty("opacity");
    let done = false;
    const finish = () => { if (done) return; done = true; host.remove(); };
    panelEl.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 420);
  };

  // A tap, as distinct from the start of a scroll: touchend within 10px of
  // its touchstart. Handled directly where iOS's synthesised mouse events
  // would arrive only after its own gesture recognition, or would move focus
  // off the composer (the @-menu rows). Touch events never fire for a mouse.
  function onTap(el, fn) {
    let sx = 0, sy = 0;
    el.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      if (Math.abs(t.clientX - sx) < 10 && Math.abs(t.clientY - sy) < 10) { e.preventDefault(); fn(e); }
    });
  }
  // Refocusing after an async completion pops the keyboard over the reply on
  // a phone; on touch the reader taps the field when ready. Desktop keeps the
  // caret in the composer, where the next question goes.
  const focusInput = () => { if (!TOUCH.matches) input.focus(); };

  // Touch: dragging the header (grabber included) moves the sheet with the
  // finger, the scrim fading as it goes; release past 110px, or a quick
  // flick, dismisses, anything less springs back — the gesture an iOS
  // sheet's grabber teaches. (The first cut only checked the distance on
  // touchend, which read as "the pill does nothing".)
  let dragY0 = null, dragT0 = 0, dragDy = 0;
  const hdr = root.querySelector(".hdr");
  hdr.addEventListener("touchstart", (e) => {
    if (!NARROW.matches || e.touches.length !== 1) return;
    dragY0 = e.touches[0].clientY; dragT0 = e.timeStamp; dragDy = 0;
  }, { passive: true });
  hdr.addEventListener("touchmove", (e) => {
    if (dragY0 === null) return;
    dragDy = Math.max(0, e.touches[0].clientY - dragY0);
    panelEl.classList.add("drag");
    panelEl.style.transform = "translateY(" + dragDy + "px)";
    scrimEl.style.opacity = String(Math.max(0, 1 - dragDy / 480));
    e.preventDefault();
  }, { passive: false });
  const endDrag = (e) => {
    if (dragY0 === null) return;
    const flick = dragDy / Math.max(1, e.timeStamp - dragT0) > 0.5;   // px per ms
    dragY0 = null;
    if (dragDy > 110 || (flick && dragDy > 24)) { closePanel(); return; }
    panelEl.classList.remove("drag");
    panelEl.style.removeProperty("transform");
    scrimEl.style.removeProperty("opacity");
    dragDy = 0;
  };
  hdr.addEventListener("touchend", endDrag, { passive: true });
  hdr.addEventListener("touchcancel", endDrag, { passive: true });
  // Tapping the dimmed page above the sheet dismisses it (iOS sheet rule).
  $("scrim").onclick = closePanel;

  // ── Voice input (Web Speech API) ──
  // Dictation into the composer without the keyboard: continuous recognition
  // with interim results streamed into the textarea; a second tap stops. The
  // microphone permission is per SITE (the panel lives in the page), so the
  // first use on a site prompts once. Hidden where the API is absent.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $("mic");
  let rec = null, recBase = "";
  if (!SR) micBtn.style.display = "none";
  micBtn.onclick = () => {
    if (rec) { try { rec.stop(); } catch {} return; }
    if (!SR) return;
    rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    recBase = input.value ? input.value.replace(/\s*$/, " ") : "";
    micBtn.classList.add("on"); micBtn.title = "Stop listening";
    rec.onresult = (e) => {
      let done = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) done += r[0].transcript; else interim += r[0].transcript;
      }
      input.value = recBase + done + interim;
      grow();
    };
    rec.onerror = (e) => {
      const why = e.error === "not-allowed" ? "microphone access was denied for this site" : String(e.error || "unknown");
      addMsg("err", "voice input: " + why);
    };
    rec.onend = () => { rec = null; micBtn.classList.remove("on"); micBtn.title = "Voice input"; grow(); };
    try { rec.start(); } catch (e) {
      rec = null; micBtn.classList.remove("on");
      addMsg("err", "voice input unavailable: " + String((e && e.message) || e));
    }
  };

  // Keyboard events must not escape the panel into the host page.
  //
  // The panel lives in a CLOSED shadow root, so a key event that bubbles out of
  // it is RETARGETED at the document: listeners there see event.target as the
  // host <div>, never our <textarea>. Global-hotkey handlers use exactly that
  // check to decide "is the user typing in a field?", conclude no, and fire
  // their shortcuts while you type. GitHub is the worst case — "/" jumps to
  // search, "t" opens the file finder, "s" and the "g" chords navigate away
  // mid-sentence — but Gmail, Linear, YouTube and Jira all behave the same way.
  //
  // Stopping at the ShadowRoot fixes every such site at once, and is safe for
  // us: this is the last hop INSIDE the shadow tree, so the composer's own
  // handlers (Enter to send, @-menu navigation) sit deeper and have already run
  // by the time the event arrives here on its way out. Native browser
  // shortcuts (Cmd-C/V/W, Cmd-L) are untouched — those are handled by Safari
  // itself, not by page JS, and stopPropagation has no bearing on them.
  //
  // Caveat: this cannot stop a page listener registered in the CAPTURE phase on
  // window/document, which runs before the event ever reaches us. That is rare
  // for hotkeys (GitHub's @github/hotkey binds on bubble) and unfixable from
  // inside a closed shadow root without breaking our own handlers.
  for (const ev of ["keydown", "keyup", "keypress"]) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  for (const ev of ["dragover", "dragenter"]) {
    panelEl.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      card.classList.add("drag");
    });
  }
  panelEl.addEventListener("dragleave", (e) => { e.preventDefault(); card.classList.remove("drag"); });
  panelEl.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    card.classList.remove("drag");
    const dt = e.dataTransfer;
    if (!dt) return;
    let files = Array.from(dt.files || []);
    if (!files.length && dt.items) {
      files = Array.from(dt.items)
        .map((i) => (i.kind === "file" ? i.getAsFile() : null))
        .filter(Boolean);
    }
    if (files.length) { pickFiles(files); return; }
    const url = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").split("\n")[0].trim();
    if (!/^https?:/i.test(url)) return;
    const r = await browser.runtime.sendMessage({ op: "fetchImage", url }).catch((e2) => ({ error: String(e2) }));
    if (r && r.dataUrl) {
      attachments.push({ name: r.name || "image", type: r.type || "image/png", dataUrl: r.dataUrl });
      drawChips();
    } else {
      addMsg("err", "couldn't attach dropped image: " + ((r && r.error) || "unknown"));
    }
  });

  // ── @ tab mentions ──
  let menuItems = [], menuSel = 0, mentionStart = -1;
  const closeMenu = () => { menu.classList.remove("open"); mentionStart = -1; };
  function drawMenu() {
    menu.textContent = "";
    if (!menuItems.length) {
      const d = document.createElement("div");
      d.className = "mi none";
      d.textContent = "no matching tabs (grant the extension website access to see them)";
      menu.appendChild(d);
      return;
    }
    menuItems.forEach((t, i) => {
      const d = document.createElement("div");
      d.className = "mi" + (i === menuSel ? " sel" : "");
      d.innerHTML = '<span class="col"><span class="ti"></span><br/><span class="ho"></span></span>';
      d.querySelector(".ti").textContent = t.title || t.url;
      d.querySelector(".ho").textContent = hostOf(t.url) + (t.active ? " · current" : "");
      const img = faviconImg(t.favIconUrl);
      if (img) d.insertBefore(img, d.firstChild);
      d.onmousedown = (e) => { e.preventDefault(); selectMention(t); };
      onTap(d, () => selectMention(t));
      menu.appendChild(d);
    });
  }
  async function openMenu(query) {
    let tabs = await browser.runtime.sendMessage({ op: "tabsList" }).catch(() => []);
    if (!Array.isArray(tabs)) tabs = [];
    const q = query.toLowerCase();
    menuItems = tabs
      .filter((t) => /^https?:/i.test(t.url || ""))
      .filter((t) => !q || (t.title || "").toLowerCase().includes(q) || (t.url || "").toLowerCase().includes(q))
      .slice(0, 12);
    menuSel = 0;
    drawMenu();
    menu.classList.add("open");
  }
  function selectMention(t) {
    if (!tabChips.some((c) => c.tabId === t.tabId)) tabChips.push({ tabId: t.tabId, title: t.title, url: t.url, fav: t.favIconUrl });
    if (mentionStart >= 0) {
      const end = input.selectionStart;
      input.value = input.value.slice(0, mentionStart) + input.value.slice(end);
      input.selectionStart = input.selectionEnd = mentionStart;
    }
    drawChips(); closeMenu(); grow(); input.focus();
  }
  function checkMention() {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
      const q = before.slice(at + 1);
      if (!/\s/.test(q) && q.length <= 40) { mentionStart = at; openMenu(q); return; }
    }
    closeMenu();
  }
  $("mention").onclick = () => {
    const p = input.selectionStart;
    input.value = input.value.slice(0, p) + "@" + input.value.slice(p);
    input.selectionStart = input.selectionEnd = p + 1;
    input.focus(); checkMention();
  };

  // ── history (browser.storage.local — survives Safari restarts) ──
  // crypto.randomUUID is SECURE-CONTEXT ONLY, and a content script inherits
  // the page's context: on any plain http:// page it is undefined (measured
  // 2026-09-16 on http://192.168.1.8 — isSecureContext false, randomUUID
  // undefined). It was called on the first turn of a chat, so that turn threw
  // before the request was ever sent: the question sat in the transcript, no
  // reply came, and chatBusy stayed true with the send button disabled for the
  // life of the page. The id only has to be unique among this browser's stored
  // conversations.
  const convoId = () => {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  };
  const HKEY = "chatHistory";
  let convo = null;   // { id, provider, model, sessionId, title, updatedAt, msgs: [{r,t}] }
  const note = (r, t) => {
    if (!convo) convo = { id: convoId(), provider: chatProvider, model: $("model").value, sessionId: null, title: null, msgs: [] };
    convo.msgs.push({ r, t: String(t).slice(0, 20000) });
  };
  async function saveConvo() {
    if (!convo || !convo.msgs.some((m) => m.r === "u")) return;
    convo.provider = chatProvider;
    convo.model = $("model").value;
    convo.sessionId = chatSessionId;
    convo.updatedAt = Date.now();
    if (!convo.title) convo.title = (convo.msgs.find((m) => m.r === "u") || { t: "Conversation" }).t.slice(0, 70);
    try {
      const st = await browser.storage.local.get(HKEY);
      const rest = (st[HKEY] || []).filter((c) => c.id !== convo.id);
      rest.unshift({ ...convo, msgs: convo.msgs.slice(-60) });
      await browser.storage.local.set({ [HKEY]: rest.slice(0, 30) });
    } catch {}
  }
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const histov = $("histov");
  const clearMsgs = () => {
    for (const m of Array.from(msgs.querySelectorAll(".m, .think"))) m.remove();
  };
  function loadConvo(c) {
    if (chatBusy) return;
    drawProvider(c.provider || "claude", c.model || "");
    convo = { id: c.id, provider: chatProvider, model: $("model").value,
      sessionId: c.sessionId, title: c.title, msgs: [...c.msgs] };
    chatSessionId = c.sessionId || null;   // --resume picks the thread back up
    clearMsgs();
    for (const m of c.msgs) {
      if (m.r === "c") addMsg("c", md(m.t), true);
      else addMsg(m.r === "u" ? "u" : "err", m.t);
    }
    histov.classList.remove("open");
    updateEmpty(); focusInput();
  }
  async function drawHistory() {
    const st = await browser.storage.local.get(HKEY).catch(() => ({}));
    const h = st[HKEY] || [];
    histov.textContent = "";
    if (!h.length) {
      const d = document.createElement("div");
      d.className = "hi-none"; d.textContent = "No conversations yet";
      histov.appendChild(d); return;
    }
    for (const c of h) {
      const d = document.createElement("div");
      d.className = "hi-item";
      d.innerHTML = `<span class="col"><span class="t"></span><span class="d">${c.provider === "codex" ? "Codex" : "Claude"} · ${ago(c.updatedAt)} · ${c.msgs.filter((m) => m.r === "u").length} message${c.msgs.filter((m) => m.r === "u").length === 1 ? "" : "s"}</span></span><button title="Delete">${SVG.x}</button>`;
      d.querySelector(".t").textContent = c.title || "Conversation";
      d.querySelector("button").onclick = async (e) => {
        e.stopPropagation();
        if (chatBusy) return;
        const st2 = await browser.storage.local.get(HKEY);
        await browser.storage.local.set({ [HKEY]: (st2[HKEY] || []).filter((x) => x.id !== c.id) });
        drawHistory();
      };
      d.onclick = () => loadConvo(c);
      histov.appendChild(d);
    }
  }
  $("hist").onclick = () => {
    $("hubov").classList.remove("open");
    if (histov.classList.toggle("open")) drawHistory();
  };
  browser.storage.local.get(["chatProvider", "chatModel"]).then((st) => {
    if (!convo) drawProvider(st.chatProvider || "claude", st.chatModel || "");
  }).catch(() => {});
  $("provider").onchange = async () => {
    if (chatBusy) return;
    await saveConvo();
    drawProvider($("provider").value);
    await browser.storage.local.set({ chatProvider, chatModel: $("model").value }).catch(() => {});
    convo = null; chatSessionId = null; chatBusy = false;
    clearMsgs(); histov.classList.remove("open"); updateEmpty(); focusInput();
  };
  $("model").onchange = () => {
    if (chatBusy) return;
    browser.storage.local.set({ chatProvider, chatModel: $("model").value }).catch(() => {});
  };

  // ── hub settings ──
  // Local Mac hub by default; a hosted or mesh hub (HOSTING.md)
  // is what makes this panel work on iPhone/iPad, where 127.0.0.1 is the
  // phone itself. Values live in extension storage; background.js reads them
  // for every bridge call and sends the token as a Bearer header.
  const hubov = $("hubov");
  async function pingHub() {
    const el = $("hubstat");
    el.className = "hubstat"; el.textContent = "checking hub…";
    const r = await browser.runtime.sendMessage({ op: "hubping" }).catch(() => null);
    if (r && r.ok) { el.className = "hubstat ok"; el.textContent = "hub reachable — " + (r.hub || "local"); }
    else { el.className = "hubstat bad"; el.textContent = "hub unreachable" + (r && r.error ? " — " + r.error : ""); }
  }
  // ── the site list ──
  // The list is applied by the BACKGROUND page (declarativeNetRequest rules and
  // the MAIN-world script registration are both background-only APIs), so this
  // pane hands over raw text and renders whatever comes back normalised. That
  // keeps one parser, and it means the box shows exactly what is in effect
  // rather than what was typed.
  function drawUaResult(r) {
    const el = $("uastat");
    // NO ANSWER AT ALL is its own case, and a common one. A content script's
    // browser.runtime belongs to whichever context of this extension injected
    // into the page's world first, which can be an older copy Safari is still
    // running beside the current one -- measured 2026-09-16: a page whose world
    // was bound to a 0.34 context, where the site-list ops (0.36) simply do not
    // exist, so sendMessage resolved undefined and this pane said "could not
    // apply" with nothing after it. The Settings page reaches the current copy
    // directly, so send the reader there.
    if (r === undefined) {
      el.className = "hubstat bad";
      el.textContent = "an older copy of the extension owns this page — edit the list in Safari Settings > Extensions > Claude for Safari > Settings";
      return;
    }
    if (!r || r.error) {
      el.className = "hubstat bad";
      el.textContent = "could not apply" + (r && r.error ? " — " + r.error : "");
      return;
    }
    $("uasites").value = (r.sites || []).join("\n");
    const scope = (r.status && r.status.scope) || "";
    const dnrOk = String((r.status && r.status.dnr) || "").startsWith("ok:") ||
      String((r.status && r.status.dnr) || "").startsWith("no-chrome-sites");
    const bits = [];
    bits.push(r.sites && r.sites.length
      ? r.sites.length + (r.sites.length === 1 ? " site" : " sites")
      : "no sites — Safari everywhere");
    if (r.usingDefaults) bits.push("built-in default");
    if (r.rejected && r.rejected.length) bits.push("ignored: " + r.rejected.slice(0, 3).join(", "));
    if (scope === "scripting-unavailable") bits.push("header only (no script scoping on this Safari)");
    else if (String(scope).startsWith("failed:")) bits.push(scope);
    el.className = "hubstat" + ((r.rejected && r.rejected.length) || !dnrOk || String(scope).startsWith("failed:") ? " bad" : " ok");
    el.textContent = bits.join(" · ");
  }
  async function drawUaSites() {
    const el = $("uastat");
    el.className = "hubstat"; el.textContent = "loading…";
    const r = await browser.runtime.sendMessage({ op: "uaSitesGet" }).catch((e) => ({ error: String(e) }));
    drawUaResult(r);
  }
  $("uasave").onclick = async () => {
    const el = $("uastat");
    el.className = "hubstat"; el.textContent = "applying…";
    const r = await browser.runtime.sendMessage({ op: "uaSitesSet", text: $("uasites").value })
      .catch((e) => ({ error: String(e) }));
    drawUaResult(r);
  };
  $("uareset").onclick = async () => {
    const el = $("uastat");
    el.className = "hubstat"; el.textContent = "restoring…";
    const r = await browser.runtime.sendMessage({ op: "uaSitesReset" }).catch((e) => ({ error: String(e) }));
    drawUaResult(r);
  };

  async function drawHub() {
    const st = await browser.storage.local.get(["hubUrl", "hubToken"]).catch(() => ({}));
    $("huburl").value = st.hubUrl || "";
    $("hubtok").value = st.hubToken || "";
    pingHub();
    drawUaSites();
  }
  $("hubbtn").onclick = () => {
    histov.classList.remove("open");
    if (hubov.classList.toggle("open")) drawHub();
  };
  $("hubsave").onclick = async () => {
    const url = $("huburl").value.trim().replace(/\/+$/, "");
    const token = $("hubtok").value.trim();
    if (url) await browser.storage.local.set({ hubUrl: url });
    else await browser.storage.local.remove("hubUrl");
    if (token) await browser.storage.local.set({ hubToken: token });
    else await browser.storage.local.remove("hubToken");
    pingHub();
  };

  // ── send ──
  async function send() {
    const prompt = input.value.trim();
    if (!prompt || chatBusy) return;
    chatBusy = true; $("send").disabled = true;
    $("provider").disabled = true; $("model").disabled = true;
    closeMenu();
    const myTabs = tabChips; const myFiles = attachments;
    tabChips = []; attachments = []; drawChips();
    input.value = ""; grow();

    const noteBits = [];
    if (myTabs.length) noteBits.push(myTabs.length + " tab" + (myTabs.length > 1 ? "s" : ""));
    if (myFiles.length) noteBits.push(myFiles.length + " file" + (myFiles.length > 1 ? "s" : ""));
    const u = addMsg("u", prompt);
    if (noteBits.length) {
      const n = document.createElement("span");
      n.className = "att-note"; n.textContent = "+ " + noteBits.join(" · ");
      u.appendChild(n);
    }
    note("u", prompt + (noteBits.length ? "  [+ " + noteBits.join(" · ") + "]" : ""));
    const think = addMsg("think", "", true);
    think.innerHTML = "<i></i><i></i><i></i>";

    // Capture @-mentioned tabs' content NOW (fresh, per-turn).
    const tabsPayload = [];
    let fetchedTabs = 0;
    for (const c of myTabs) {
      const r = await browser.runtime.sendMessage({ op: "readTab", tabId: c.tabId }).catch((e) => ({ error: String(e) }));
      if (r && !r.error) {
        tabsPayload.push({ url: r.url, title: r.title, text: r.text });
        // A tab Safari had not loaded came back as a fetched copy (see the
        // background page's read fallback): say so in the turn's note rather
        // than as an error, since the words are there.
        if (r.via === "fetch") fetchedTabs++;
      } else {
        addMsg("err", `couldn't read tab "${c.title}": ${(r && r.error) || "unknown"}`);
      }
    }
    if (fetchedTabs) {
      const n = u.querySelector(".att-note");
      const extra = `${fetchedTabs} tab${fetchedTabs > 1 ? "s" : ""} read from a fetched copy (not loaded in Safari)`;
      if (n) n.textContent += " · " + extra; else { const s = document.createElement("span"); s.className = "att-note"; s.textContent = "+ " + extra; u.appendChild(s); }
    }
    const page = (!chatSessionId)
      ? { url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 60000) }
      : null;

    try {
      const r = await browser.runtime.sendMessage({
        op: "chat", provider: chatProvider, prompt, sessionId: chatSessionId, page,
        tabs: tabsPayload, attachments: myFiles, model: $("model").value || undefined,
      });
      think.remove();
      if (r && r.error) { addMsg("err", r.error); note("err", r.error); }
      else {
        const reply = (r && r.reply) || "(empty reply)";
        addMsg("c", md(reply), true);
        if (r && r.sessionId) chatSessionId = r.sessionId;
        note("c", reply);
      }
    } catch (e) {
      think.remove();
      addMsg("err", String((e && e.message) || e));
      note("err", String((e && e.message) || e));
    }
    saveConvo();
    chatBusy = false; $("send").disabled = false;
    $("provider").disabled = false; $("model").disabled = false;
    msgs.scrollTop = msgs.scrollHeight;
    focusInput();
  }

  // ── wiring ──
  input.addEventListener("input", () => { grow(); checkMention(); });
  input.addEventListener("focus", () => card.classList.add("focus"));
  input.addEventListener("blur", () => { card.classList.remove("focus"); setTimeout(closeMenu, 150); });
  input.addEventListener("keydown", (e) => {
    if (menu.classList.contains("open")) {
      if (e.key === "ArrowDown") { e.preventDefault(); menuSel = Math.min(menuSel + 1, menuItems.length - 1); drawMenu(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); menuSel = Math.max(menuSel - 1, 0); drawMenu(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); if (menuItems[menuSel]) selectMention(menuItems[menuSel]); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
    }
    // A software keyboard has no Shift+Enter: on touch, return inserts a
    // newline (as in Messages) and the send button sends. Desktop keeps
    // Enter-to-send, Shift+Enter for a newline.
    if (e.key === "Enter" && !e.shiftKey && !TOUCH.matches) { e.preventDefault(); send(); }
  });
  $("send").onclick = send;
  $("fresh").onclick = async () => {
    if (chatBusy) return;
    await saveConvo();
    convo = null; chatSessionId = null;
    clearMsgs(); histov.classList.remove("open");
    updateEmpty(); focusInput();
  };
  $("close").onclick = closePanel;

  // Attach every open http(s) tab as a context chip — used by the empty-state
  // pill and by a toolbar click made from Safari's Tab Overview.
  async function addAllTabs() {
    const tabs = await browser.runtime.sendMessage({ op: "tabsList" }).catch(() => []);
    if (!Array.isArray(tabs)) return;
    for (const t of tabs) {
      if (!/^https?:/i.test(t.url || "")) continue;
      if (!tabChips.some((c) => c.tabId === t.tabId)) {
        tabChips.push({ tabId: t.tabId, title: t.title, url: t.url, fav: t.favIconUrl });
      }
    }
    drawChips(); focusInput();
  }
  $("addall").onclick = addAllTabs;

  // Starter chips: one tap SENDS. A chip is a shortcut for a question the user
  // has already decided to ask — making them draft it and then press send adds
  // a step to every use for the sake of an edit that is rare. Anything they do
  // want to shape, they type.
  //
  // It still routes through the composer rather than calling the transport
  // directly: value -> grow() -> send(). send() stays the single entry point
  // for a turn (it owns attachments, the @-tab context, history and the empty
  // state), so there is no second send path to keep in sync — the chip just
  // fills the box and presses the same button. Focus goes to the composer
  // afterwards so a follow-up can be typed straight away.
  const sugg = $("sugg");
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "sg";
    b.type = "button";
    b.textContent = s;
    b.onclick = () => {
      input.value = s;
      input.selectionStart = input.selectionEnd = s.length;
      grow();
      send();
      focusInput();
    };
    sugg.appendChild(b);
  }

  panelApi = { addAllTabs, close: closePanel };

  // A panel another script in this world put there is not ours to keep: two
  // hosts would stack two panes over each other. This happens when an older
  // copy of the extension is also running in Safari and its script opened its
  // own panel before this one was asked (measured 2026-09-16).
  const foreign = document.getElementById("claude-safari-panel-host");
  if (foreign && foreign !== panelHost) { try { foreign.remove(); } catch (e) {} }
  document.documentElement.appendChild(panelHost);
  pushPage(true);
  // A page can take the host straight back out: a framework that owns <html>
  // and re-renders it, an anti-injection script that removes what it did not
  // add (measured 2026-09-16 against a MutationObserver doing exactly that).
  // The panel cannot be defended there -- re-inserting it would be a fight
  // with the page -- but the PAGE must not be left shoved 360px aside for a
  // pane that is gone, which is what happened until this. Disconnected in
  // teardown, so our own removal on close does not trip it.
  hostWatch = new MutationObserver(() => {
    if (panelHost && !panelHost.isConnected) closePanel();
  });
  try { hostWatch.observe(document.documentElement, { childList: true }); } catch (e) { hostWatch = null; }
  updateEmpty();
  focusInput();
  // Two frames: the first commits the off-screen start, the second flips to
  // the resting position so the transition actually runs.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!panelHost) return;
    panelEl.classList.add("in"); scrimEl.classList.add("in");
  }));
}

function togglePanel(msg) {
  // A host the PAGE took out of the document is not an open panel. Pages do
  // that: a framework that owns <html> re-renders it away, an anti-injection
  // script removes what it did not put there (measured 2026-09-16 against a
  // MutationObserver that removes foreign children of documentElement). While
  // that counted as open, every second click was spent "closing" a panel that
  // was not on screen, so the button looked broken half the time.
  if (panelHost && !panelHost.isConnected) { panelHost = null; panelApi = null; pushPage(false); }
  if (panelHost) { if (panelApi) panelApi.close(); else { panelHost.remove(); panelHost = null; } }
  else {
    try {
      buildPanel();
    } catch (e) {
      // buildPanel assigns panelHost before it can fail (a document that
      // refuses a shadow root, a stylesheet a WebKit rejects). Leaving that
      // half-built host in place made the NEXT click a close, so the panel
      // could never open again on that page; the error itself belongs to the
      // caller, which puts it on the toolbar badge.
      try { if (panelHost) panelHost.remove(); } catch (e2) {}
      panelHost = null; panelApi = null;
      pushPage(false);
      throw e;
    }
    // Clicked from Tab Overview (the page was hidden): the user is looking at
    // ALL tabs, so start the chat with all of them attached.
    if (msg && msg.withAllTabs && panelApi) panelApi.addAllTabs();
  }
  return { open: !!panelHost };
}

})();
