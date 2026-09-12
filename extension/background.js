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
        const call = await r.json();
        try {
          const result = await handleCall(call);
          await postResult(call.id, { result });
        } catch (e) {
          await postResult(call.id, { error: String((e && e.message) || e) });
        }
      }
      // 204 = long-poll timeout with nothing queued; loop straight back in.
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
    browser.browserAction.setBadgeText({ text: "" });
    browser.browserAction.setTitle({ title: "Claude — open chat panel" });
  } catch (e) {
    // Badge as the only in-chrome signal we have; the title carries the why.
    browser.browserAction.setBadgeText({ text: "!" });
    browser.browserAction.setTitle({ title: "Claude: " + String((e && e.message) || e) });
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
  if (msg.op === "hubping") {
    return hubFetch("/health")
      .then((r) => r.json())
      .then((j) => ({ ok: !!j.ok, hub: hub.url === HUB_DEFAULT ? "local Mac" : hub.url }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  }
  return undefined;
});

// ── Per-site Chrome user agent (header half) ───────────────────────────────
// Safari's default UA stays honest — leave Safari's own CustomUserAgent
// preference unset — and the Chrome spoof lives HERE, scoped to the sites in
// ua-chrome-sites.js (the inversion story and the measurements live in that
// file's header). These dynamic rules set the Chrome User-Agent header on
// every request to those domains; the JS half is ua-consistency.js, and both
// read the one generated string (ua-chrome.js) so header and navigator can
// never disagree.
//
// main_frame IS covered. An earlier comment here claimed Safari applies
// modifyHeaders to subresources but not the top-level navigation; re-measured
// 2026-09-01 with a server-side header echo, Safari 27 rewrites the
// main_frame User-Agent too. What remains true is the LAUNCH RACE: rules
// installed from this background page cannot be relied on for pages loaded
// immediately after a cold Safari launch, so a listed site's first load can
// go out as honest Safari. That now fails soft and visible (the site's own
// "unsupported browser" banner; a reload fixes it) instead of the old
// direction's invisible Cloudflare token poisoning — the accepted trade.
//
// THE CHROME STRING IS NOT HARDCODED here: build-app.sh regenerates
// ua-chrome.js into the build copy of the extension from $SAFARI_USER_AGENT
// or the $SAFARI_UA_CACHE file, and the tracked ua-chrome.js is the committed
// default it falls back to.
(function () {
  const api = (typeof browser !== "undefined" ? browser : chrome);
  const dnr = api && api.declarativeNetRequest;
  // "Did the rules install" must stay answerable after the fact; from the
  // background page's console: browser.storage.local.get("uaSpoofStatus").
  // (Replaces the exception-era uaExceptionStatus key, removed below so a
  // stale success can never be read as current.)
  const note = (m) => {
    try {
      api.storage.local.set({ uaSpoofStatus: m });
      api.storage.local.remove("uaExceptionStatus");
    } catch (e) {}
  };
  if (!dnr || !dnr.updateDynamicRules) { note("dnr-unavailable"); return; }

  const ua = (typeof chromeUA === "function" && chromeUA()) || "";
  const domains = (typeof UA_CHROME_SITES !== "undefined") ? UA_CHROME_SITES : [];

  // Dynamic rules PERSIST in extension storage across updates, so the
  // exception-era rules (five 9200s restoring Safari on claude.ai et al) and
  // the client-hint probes must be swept even though this build never adds
  // them — and swept even when there is nothing to add, or an emptied list
  // would leave the last build's rules running forever.
  const sweep = Array.from({ length: 100 }, (_, i) => 9200 + i).concat([9001, 9100]);

  if (!domains.length || !/Chrome\/\d+\./.test(ua)) {
    dnr.updateDynamicRules({ removeRuleIds: sweep })
      .then(() => note(domains.length ? "no-chrome-ua" : "no-chrome-sites"))
      .catch((e) => note("failed: " + (e && e.message)));
    return;
  }

  // One rule per domain. requestDomains matches the domain AND its
  // subdomains, so "example.com" covers app.example.com without an extra
  // entry.
  const rules = domains.map((d, i) => ({
    id: 9200 + i,
    priority: 100,                              // beat anything added later
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "user-agent", operation: "set", value: ua }],
    },
    condition: {
      requestDomains: [d],
      resourceTypes: [
        "main_frame", "sub_frame", "xmlhttprequest", "script",
        "stylesheet", "image", "font", "media", "websocket", "other",
      ],
    },
  }));

  dnr.updateDynamicRules({ removeRuleIds: sweep, addRules: rules })
    .then(() => note("ok:" + domains.join(",")))
    .catch((e) => note("failed: " + (e && e.message)));
})();

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



