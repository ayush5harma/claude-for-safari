// Claude for Safari — background page.
//
// Long-polls the local bridge hub (see ../bridge/claude-safari-bridge.js) for
// tool calls issued by Claude Code MCP sessions, executes them against Safari
// (tabs API here, DOM work via the content script), and posts results back.
// The hub binds 127.0.0.1 by default (a configured remote hub is token-gated;
// see the hub block below); this loop is the ONLY writer to /pull and
// /result, and the hub rejects those endpoints for callers that carry a web
// Origin (page JavaScript always does; this background page's requests carry
// a safari-web-extension:// origin).
//
// MV2 persistent background page on purpose: Safari suspends MV3 service
// workers aggressively, which kills a long-poll loop mid-flight.

// The hub address is CONFIGURABLE (panel gear > hub settings) so the panel
// can work where 127.0.0.1 is not the Mac — iOS/iPadOS, another machine.
// {hubUrl, hubToken} live in extension storage; the token rides as a Bearer
// header, which the bridge REQUIRES whenever its side sets BRIDGE_TOKEN
// (mandatory off-loopback — see HOSTING.md).
const HUB_DEFAULT = "http://127.0.0.1:29170";
const hub = { url: HUB_DEFAULT, token: "" };
(async () => {
  try {
    const st = await browser.storage.local.get(["hubUrl", "hubToken"]);
    hub.url = st.hubUrl || HUB_DEFAULT;
    hub.token = st.hubToken || "";
  } catch (e) {}
})();
browser.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.hubUrl) hub.url = ch.hubUrl.newValue || HUB_DEFAULT;
  if (ch.hubToken) hub.token = ch.hubToken.newValue || "";
});
const hubFetch = (path, opts = {}) => {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (hub.token) o.headers.authorization = "Bearer " + hub.token;
  return fetch(hub.url + path, o);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default target: the active tab of the last focused window; a call may pin
// an explicit tabId instead (from claude_safari_tabs).
async function targetTab(args) {
  if (args && args.tabId != null) {
    return browser.tabs.get(args.tabId);
  }
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) throw new Error("no active Safari tab");
  return tabs[0];
}

// content.js may not be in a tab (page opened before the extension, or the
// site has no access grant) — and Safari resolves sendMessage to a missing
// receiver with UNDEFINED rather than throwing, so absence must be probed
// with a ping, then repaired by injecting content.js on demand. A toolbar
// click grants activeTab, so injection works on the clicked tab even before
// any site-wide permission.
async function ensureContent(tabId) {
  const ping = await browser.tabs.sendMessage(tabId, { op: "ping" }).catch(() => undefined);
  if (ping && ping.ok) return;
  try {
    await browser.tabs.executeScript(tabId, { file: "content.js" });
  } catch (e) {
    // Two causes look identical from here: a tab Safari has NOT LOADED (a
    // tab restored from the last session is a snapshot until it is opened;
    // iOS does this to every background tab, the Mac after a relaunch) and
    // a site with no website-access grant.
    throw new Error(
      "cannot run in this tab: Safari has not loaded it (open the tab once, then try again), " +
      "or the site has no website-access grant for the extension " +
      "(Settings > Safari > Extensions > Claude for Safari > Allow on All Websites): " +
      String((e && e.message) || e)
    );
  }
  const again = await browser.tabs.sendMessage(tabId, { op: "ping" }).catch(() => undefined);
  if (!(again && again.ok)) {
    throw new Error("content script did not answer after injection (Safari-internal or blocked page?)");
  }
}

async function askContent(tabId, msg) {
  await ensureContent(tabId);
  const r = await browser.tabs.sendMessage(tabId, msg);
  if (r === undefined) throw new Error("content script gave no response for op " + msg.op);
  return r;
}

const handlers = {
  async tabs() {
    const tabs = await browser.tabs.query({});
    return tabs.map((t) => ({
      tabId: t.id, windowId: t.windowId, active: t.active,
      url: t.url, title: t.title,
      // The tab's OWN icon, which Safari has already fetched. The panel used to
      // build a google.com/s2/favicons URL from each hostname instead, which
      // told a third party every host the user had open, every time the picker
      // was drawn. May be absent (a tab Safari has not loaded, a site with no
      // icon); the panel then draws no icon.
      favIconUrl: t.favIconUrl || "",
    }));
  },

  async read(args) {
    const tab = await targetTab(args);
    const maxChars = (args && args.maxChars) || 120000;
    try {
      const page = await askContent(tab.id, { op: "read", maxChars });
      return { tabId: tab.id, url: tab.url, title: tab.title, ...page };
    } catch (e) {
      // FALLBACK for a tab content.js cannot run in (see ensureContent): fetch
      // the tab's URL from this page instead. Host permissions let the
      // background page fetch any http(s) URL, and the request carries the
      // profile's cookies, so a signed-in page comes back as the user sees it
      // in the markup. Not the rendered DOM — no script ran — but for an
      // article, a search page or a document it is the same words, and it
      // beats "couldn't read tab" on every @-mentioned tab that was merely
      // asleep (what the phone showed on 2026-09-02).
      let fetched;
      try {
        fetched = await fetchAsText(tab.url, maxChars);
      } catch (e2) {
        throw new Error(String((e && e.message) || e) + " — and fetching a copy failed too: " + String((e2 && e2.message) || e2));
      }
      return { tabId: tab.id, url: tab.url, title: tab.title || fetched.title, text: fetched.text,
        truncated: fetched.truncated, selection: "", links: [], via: "fetch" };
    }
  },

  async click(args) {
    const tab = await targetTab(args);
    return askContent(tab.id, { op: "click", selector: args.selector, text: args.text });
  },

  async fill(args) {
    const tab = await targetTab(args);
    return askContent(tab.id, { op: "fill", selector: args.selector, value: args.value });
  },

  async eval(args) {
    const tab = await targetTab(args);
    return askContent(tab.id, { op: "eval", code: args.code });
  },

  async navigate(args) {
    if (args.newTab) {
      const t = await browser.tabs.create({ url: args.url });
      return { tabId: t.id, url: args.url, opened: "new tab" };
    }
    const tab = await targetTab(args);
    await browser.tabs.update(tab.id, { url: args.url });
    return { tabId: tab.id, url: args.url, opened: "current tab" };
  },

  async screenshot(args) {
    const tab = await targetTab(args);
    await browser.tabs.update(tab.id, { active: true });
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { tabId: tab.id, dataUrl };
  },
};

// A tab's page as text without running anything in it: fetch + parse +
// strip the non-content elements. `credentials: include` is what makes a
// signed-in page come back signed in.
async function fetchAsText(url, max) {
  if (!/^https?:/i.test(url || "")) throw new Error("not an http(s) page");
  const r = await fetch(url, { credentials: "include", headers: { accept: "text/html,*/*;q=0.5" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), "text/html");
  for (const el of doc.querySelectorAll("script,style,noscript,template,svg,iframe")) el.remove();
  const text = String((doc.body && (doc.body.innerText || doc.body.textContent)) || "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: doc.title || "", text: text.slice(0, max), truncated: text.length > max };
}

async function handleCall(call) {
  const fn = handlers[call.tool];
  if (!fn) throw new Error("unknown tool: " + call.tool);
  return fn(call.args || {});
}

async function postResult(id, payload) {
  await hubFetch("/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...payload }),
  });
}

let hubUp = false;
// The toolbar badge, written only when it CHANGES: the poll loop runs
// continuously, and setBadgeText on every iteration would be a needless call
// per long-poll. The click handler writes the same badge for its own errors.
//
// The dedupe key is text AND title. On text alone a second "!" carrying a
// different reason was dropped, so the hover text kept naming the first problem
// after the hub had started failing for another one — the badge would say
// "unauthorized" while the hub was actually refusing the extension's version.
let pollBadgeKey = null;
function pollBadge(text, title) {
  const key = text + " " + (title || "");
  if (pollBadgeKey === key) return;
  pollBadgeKey = key;
  try {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setTitle({ title: text ? (title || "Claude") : "Claude — open chat panel" });
  } catch (e) {}
}

async function loop() {
  for (;;) {
    try {
      // POST, not GET, since 0.35. The hub answers /pull to POST only because a
      // web page can reach any GET with <img>, <script> or a no-cors fetch and
      // send no Origin at all -- byte-identical to this extension's own fetch,
      // measured on Safari 27 -- while a cross-origin POST always carries the
      // page's Origin, which the hub rejects. Nothing is sent in the body.
      const r = await hubFetch("/pull", { method: "POST" });
      hubUp = true;
      if (r.status === 200) {
        pollBadge("");
        const call = await r.json();
        try {
          const result = await handleCall(call);
          await postResult(call.id, { result });
        } catch (e) {
          await postResult(call.id, { error: String((e && e.message) || e) });
        }
      } else if (r.status === 204) {
        // Long-poll timeout with nothing queued: the healthy idle case. Loop
        // straight back in, and clear any badge a previous failure raised.
        pollBadge("");
      } else {
        // ANY other status is an answering hub that is refusing us, and this
        // loop has no natural pacing for that: /pull returns at once, so the
        // next iteration starts immediately. Measured in the persistent
        // background page: a 403 from a 0.35 hub polled by a 0.34 extension ran
        // at 619 requests per second until Safari was quit. A 401 (a token
        // configured on the hub but not in the gear) does the same. Back off
        // like an unreachable hub, and put the hub's own explanation on the
        // toolbar badge, which is the only in-chrome signal available here.
        hubUp = false;
        let why = "HTTP " + r.status;
        try {
          const body = await r.json();
          if (body && body.error) why = String(body.error);
        } catch (e) {}
        pollBadge("!", "Claude: the bridge refused this extension — " + why);
        await sleep(3000);
      }
    } catch (e) {
      hubUp = false;   // hub not running (it self-starts with the next Claude session)
      await sleep(3000);
    }
  }
}
loop();

// ── The chat panel (Claude-for-Chrome-style) ─────────────────────────────────
// Safari has no sidePanel API, so the toolbar button toggles a shadow-DOM
// panel injected by content.js. The panel's chat turns are relayed here
// (content scripts can't reach localhost) and POSTed to the hub's /chat,
// which runs the real `claude -p` with --resume for multi-turn memory.
browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    await ensureContent(tab.id);
    // In Safari's Tab Overview the active page reports itself hidden — the
    // only overview signal an extension gets. A click from there means "chat
    // about all my tabs", so the panel opens with every tab attached.
    const ping = await browser.tabs.sendMessage(tab.id, { op: "ping" }).catch(() => null);
    const fromOverview = !!(ping && ping.hidden);
    await browser.tabs.sendMessage(tab.id, { op: "togglePanel", withAllTabs: fromOverview });
    pollBadge("");
  } catch (e) {
    // Badge as the only in-chrome signal we have; the title carries the why.
    // Through pollBadge so the poll loop and the click handler share one idea
    // of what the badge currently says.
    pollBadge("!", "Claude: " + String((e && e.message) || e));
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  if (msg.op === "status") return Promise.resolve({ hubUp });
  // The panel's @-mention picker and per-turn tab capture. Content scripts
  // can't use the tabs API, so both hop through here.
  if (msg.op === "tabsList") {
    return handlers.tabs().catch((e) => ({ error: String((e && e.message) || e) }));
  }
  if (msg.op === "readTab") {
    return handlers.read({ tabId: msg.tabId, maxChars: 30000 })
      .catch((e) => ({ error: String((e && e.message) || e) }));
  }
  // Dragging an image OFF a webpage carries a URL, not a file. The content
  // script can't reliably fetch it (page CSP/CORS applies there); this
  // background page has <all_urls> host permission, so it fetches and hands
  // back a data URL for the attachment chip.
  if (msg.op === "fetchImage") {
    return (async () => {
      const resp = await fetch(msg.url);
      const blob = await resp.blob();
      if (!/^image\//.test(blob.type)) return { error: "dropped link is not an image (" + (blob.type || "unknown type") + ")" };
      if (blob.size > 10e6) return { error: "dropped image is larger than 10 MB" };
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error("could not encode image"));
        fr.readAsDataURL(blob);
      });
      let name = "image";
      try { name = decodeURIComponent(new URL(msg.url).pathname.split("/").pop()) || "image"; } catch {}
      return { dataUrl, type: blob.type, name: name.slice(0, 80) };
    })().catch((e) => ({ error: String((e && e.message) || e) }));
  }
  if (msg.op === "chat") {
    return hubFetch("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: msg.prompt, sessionId: msg.sessionId, page: msg.page,
        tabs: msg.tabs, attachments: msg.attachments, model: msg.model,
      }),
    })
      .then((r) => r.json())
      // The hub is a resident launchd agent (install.sh registers it from
      // launchd/com.ayushsharma.claude-safari-bridge.plist.template). The
      // bridge's stdio MCP mode also starts a hub on demand, but a panel turn
      // can happen with no Claude Code session running at all, so the agent is
      // what the panel depends on.
      .catch((e) => ({ error: "bridge unreachable — run: launchctl kickstart -k gui/$UID/com.ayushsharma.claude-safari-bridge  (" + (e && e.message) + ")" }));
  }
  // ── The gear's "Sites served as Chrome" pane ──
  // The panel lives in a content script, which cannot reach declarativeNet-
  // Request or scripting, so it hands the raw textarea text here and gets back
  // what was actually stored. Parsing and validation therefore have ONE home
  // (ua-chrome-sites.js), and the pane renders the normalised result rather
  // than its own idea of it.
  if (msg.op === "uaSitesGet") {
    return (async () => {
      let saved = null;
      try {
        const st = await browser.storage.local.get(UA_SITES_KEY);
        if (Array.isArray(st[UA_SITES_KEY])) saved = st[UA_SITES_KEY];
      } catch (e) {}
      return {
        sites: saved || UA_CHROME_SITES.slice(),
        defaults: UA_CHROME_SITES.slice(),
        usingDefaults: saved === null,
        status: uaStatus,
      };
    })();
  }
  if (msg.op === "uaSitesSet") {
    return (async () => {
      const { sites, rejected } = parseSiteList(msg.text);
      await browser.storage.local.set({ [UA_SITES_KEY]: sites });
      uaLastApplied = null;          // a save always re-applies, even if equal
      await applyUaSites();
      return { sites, rejected, defaults: UA_CHROME_SITES.slice(), usingDefaults: false, status: uaStatus };
    })().catch((e) => ({ error: String((e && e.message) || e) }));
  }
  if (msg.op === "uaSitesReset") {
    return (async () => {
      await browser.storage.local.remove(UA_SITES_KEY);
      uaLastApplied = null;
      const sites = await applyUaSites();
      return { sites, rejected: [], defaults: UA_CHROME_SITES.slice(), usingDefaults: true, status: uaStatus };
    })().catch((e) => ({ error: String((e && e.message) || e) }));
  }
  if (msg.op === "hubping") {
    return hubFetch("/health")
      .then((r) => r.json())
      .then((j) => ({ ok: !!j.ok, hub: hub.url === HUB_DEFAULT ? "local Mac" : hub.url }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  }
  return undefined;
});

// ── Per-site Chrome user agent ─────────────────────────────────────────────
// Safari's default UA stays honest — leave Safari's own CustomUserAgent
// preference unset — and the Chrome spoof lives HERE, scoped to an effective
// site list: the user's own (browser.storage.local "uaChromeSites", edited in
// the panel's gear) or, when nothing is saved, the UA_CHROME_SITES default in
// ua-chrome-sites.js, whose header carries the inversion story and the
// measurements.
//
// TWO LAYERS, ONE LIST, BOTH APPLIED LIVE (0.36):
//
//   header    a declarativeNetRequest rule setting the Chrome User-Agent on
//             every request to the listed domains. These rules were ALWAYS
//             dynamic — this extension ships no static rule_resources — so the
//             2026-09-01 server-side echo that measured Safari 27 rewriting the
//             main_frame User-Agent was measuring a DYNAMIC rule. Rebuilding
//             them from a new list therefore changes nothing about that result.
//
//   navigator ua-consistency.js and webrtc-legacy-compat.js, registered through
//             scripting.registerContentScripts with world "MAIN", document_start
//             and `matches` built from the same list.
//
// WHY registerContentScripts RATHER THAN A STATIC content_scripts ENTRY. The
// MAIN world has no extension APIs at all, and browser.storage has no
// synchronous read, so a statically injected document_start script cannot learn
// a runtime list in time — the page can read navigator.userAgent before any
// async answer arrives. Scoping the registration solves that by construction:
// the scripts run only where they are registered and carry no list of their
// own. The API is the constraint, and it is met here — per MDN's compat data
// the scripting namespace is Safari 15.4+ and "available for use in Manifest V2
// or later" (unlike Chrome, where it is MV3-only), with
// registerContentScripts and RegisteredContentScript.world both Safari 16.4+.
// This project already requires macOS 14, i.e. Safari 17+. If the API is
// missing anyway, the header layer still applies and uaScopeStatus records
// "scripting-unavailable" rather than failing silently.
//
// THE LAUNCH RACE remains, unchanged: neither layer can be relied on for pages
// loaded immediately after a cold Safari launch, so a listed site's first load
// can go out as honest Safari. That fails soft and visible (the site's own
// "unsupported browser" banner; a reload fixes it) instead of the old
// direction's invisible Cloudflare token poisoning — the accepted trade. The
// same is true right after a list change: a page already open keeps whatever it
// loaded with until it is reloaded.
//
// THE CHROME STRING IS NOT HARDCODED here: build-app.sh regenerates
// ua-chrome.js into the build copy of the extension from $SAFARI_USER_AGENT
// or the $SAFARI_UA_CACHE file, and the tracked ua-chrome.js is the committed
// default it falls back to.
const UA_SITES_KEY = "uaChromeSites";
const UA_SCRIPT_ID = "ua-chrome-main";
// ua-chrome-sites.js is deliberately NOT in this list: the registration's
// `matches` is the scope, so the site list no longer travels into web pages.
const UA_MAIN_WORLD_JS = ["ua-chrome.js", "ua-consistency.js", "webrtc-legacy-compat.js"];

const uaApi = (typeof browser !== "undefined" ? browser : chrome);

// "Did it apply" must stay answerable after the fact; from the background
// page's console: browser.storage.local.get(["uaSpoofStatus","uaScopeStatus"]).
// (uaSpoofStatus replaces the exception-era uaExceptionStatus, removed here so
// a stale success can never be read as current.)
let uaStatus = { dnr: "pending", scope: "pending" };
function noteUaStatus(part, value) {
  uaStatus = { ...uaStatus, ...(part === "dnr" ? { dnr: value } : { scope: value }) };
  try {
    uaApi.storage.local.set({ uaSpoofStatus: uaStatus.dnr, uaScopeStatus: uaStatus.scope });
    uaApi.storage.local.remove("uaExceptionStatus");
  } catch (e) {}
}

// The effective list: the saved one when there is one, else the built-in
// default. A saved EMPTY array is a real answer — "spoof nothing" — and must
// not fall through to the default.
async function effectiveUaSites() {
  try {
    const st = await uaApi.storage.local.get(UA_SITES_KEY);
    const v = st && st[UA_SITES_KEY];
    if (Array.isArray(v)) return v.map(normaliseHost).filter(Boolean);
  } catch (e) {}
  return UA_CHROME_SITES.slice();
}

async function applyUaHeaderRule(sites) {
  const dnr = uaApi && uaApi.declarativeNetRequest;
  if (!dnr || !dnr.updateDynamicRules) return noteUaStatus("dnr", "dnr-unavailable");
  const ua = (typeof chromeUA === "function" && chromeUA()) || "";
  const rule = buildUaHeaderRule(sites, ua);
  try {
    // The sweep runs even when there is nothing to add: dynamic rules persist
    // across updates AND across a list change, so without it a domain the user
    // has just removed would keep the previous rule forever.
    await dnr.updateDynamicRules(rule
      ? { removeRuleIds: UA_RULE_SWEEP_IDS, addRules: [rule] }
      : { removeRuleIds: UA_RULE_SWEEP_IDS });
    noteUaStatus("dnr", rule ? "ok:" + sites.join(",") : (sites.length ? "no-chrome-ua" : "no-chrome-sites"));
  } catch (e) {
    noteUaStatus("dnr", "failed: " + String((e && e.message) || e));
  }
}

async function applyUaMainWorldScripts(sites) {
  const sc = uaApi && uaApi.scripting;
  if (!sc || !sc.registerContentScripts) return noteUaStatus("scope", "scripting-unavailable");
  // Unregister first, unconditionally: register() rejects an id that already
  // exists and update() rejects one that does not, and after a crash or an
  // update either state is possible. Unregistering an absent id throws, which
  // is why this is swallowed rather than checked.
  try { await sc.unregisterContentScripts({ ids: [UA_SCRIPT_ID] }); } catch (e) {}
  const matches = siteMatchPatterns(sites);
  if (!matches.length) return noteUaStatus("scope", "no-chrome-sites");
  try {
    await sc.registerContentScripts([{
      id: UA_SCRIPT_ID,
      js: UA_MAIN_WORLD_JS,
      matches,
      runAt: "document_start",
      allFrames: true,           // the shims must reach cross-origin iframes
      world: "MAIN",             // an isolated world's navigator is not the page's
      // The background page re-registers from storage at every start, so a
      // registration persisted from an older list would only ever be stale.
      persistAcrossSessions: false,
    }]);
    noteUaStatus("scope", "ok:" + sites.join(","));
  } catch (e) {
    noteUaStatus("scope", "failed: " + String((e && e.message) || e));
  }
}

// Applying is idempotent, and both a direct save and the storage listener call
// it; the key guard keeps the second call from churning a registration.
//
// TWO THINGS THE OBVIOUS VERSION GETS WRONG, both fixed here. (1) Recording the
// key BEFORE doing the work makes a transient failure permanent: if
// updateDynamicRules rejects once, the guard says "already applied" from then
// on and nothing retries until the user opens the gear and saves again. The key
// is therefore recorded only when BOTH layers came back without a "failed:"
// status, and cleared otherwise so the next trigger really re-applies.
// (2) These are async and can be triggered twice in a row (a save writes
// storage AND calls this, so the listener fires too): two applies for different
// lists could interleave and leave the rule from one list beside the
// registration from the other. Every call therefore goes through one in-flight
// chain, so they run strictly in order.
let uaLastApplied = null;
let uaApplyChain = Promise.resolve();

async function applyUaSitesNow() {
  let sites = [];
  try {
    sites = await effectiveUaSites();
    const key = JSON.stringify(sites);
    if (key === uaLastApplied) return sites;
    await applyUaHeaderRule(sites);
    await applyUaMainWorldScripts(sites);
    const failed = String(uaStatus.dnr).startsWith("failed:") ||
      String(uaStatus.scope).startsWith("failed:");
    uaLastApplied = failed ? null : key;
  } catch (e) {
    uaLastApplied = null;
    noteUaStatus("dnr", "failed: " + String((e && e.message) || e));
  }
  return sites;
}

function applyUaSites() {
  // Both slots run the same work: the next apply must happen whether or not the
  // previous one settled cleanly, and a rejected chain would otherwise stall
  // every later call.
  const run = () => applyUaSitesNow();
  uaApplyChain = uaApplyChain.then(run, run);
  return uaApplyChain;
}

uaApi.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch[UA_SITES_KEY]) applyUaSites();
});
applyUaSites();

// NOTE — Sec-CH-UA headers are NOT set here, and cannot be.
// Real Chrome sends sec-ch-ua / -mobile / -platform on every request; Safari
// sends none, so a Chrome user agent is permanently header-inconsistent. The
// obvious fix (declarativeNetRequest modifyHeaders) was implemented and Safari
// rejected it outright at rule-install time:
//   "Rule with id 9001 is invalid. The header `sec-ch-ua` is not recognized."
// Safari allowlists which headers an extension may modify and the client
// hints are not on it. Blocking webRequest is likewise unavailable. That
// permanent inconsistency (together with the TLS/JA3 and HTTP/2 fingerprints,
// which always say Safari) is one of the reasons the spoof is confined to the
// few sites that demand it instead of being global. Leaving this comment so
// the attempt is not repeated.



