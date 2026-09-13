// The extension's Settings page: Safari > Settings > Extensions > Claude for
// Safari > Settings (and Settings > Safari > Extensions on iPhone and iPad).
//
// It edits the same "Sites served as Chrome" list as the panel's gear, through
// the same three background ops, so parsing and validation keep ONE home
// (ua-chrome-sites.js via background.js) and both surfaces always show what
// was actually stored. The page exists because Safari offers a Settings button
// only for an extension that declares one, and the list had been reachable
// only inside the chat panel, where it was not found (2026-09-13).
"use strict";

const $ = (id) => document.getElementById(id);
const send = (msg) => browser.runtime.sendMessage(msg).catch((e) => ({ error: String((e && e.message) || e) }));

function draw(r) {
  const el = $("uastat");
  if (!r || r.error) {
    el.className = "stat bad";
    el.textContent = "could not apply" + (r && r.error ? " — " + r.error : "");
    return;
  }
  $("uasites").value = (r.sites || []).join("\n");
  const dnr = String((r.status && r.status.dnr) || "");
  const scope = String((r.status && r.status.scope) || "");
  const dnrOk = dnr.startsWith("ok:") || dnr.startsWith("no-chrome-sites");
  const bits = [];
  bits.push(r.sites && r.sites.length
    ? r.sites.length + (r.sites.length === 1 ? " site" : " sites")
    : "no sites — Safari everywhere");
  if (r.usingDefaults) bits.push("built-in default");
  if (r.rejected && r.rejected.length) bits.push("ignored: " + r.rejected.slice(0, 3).join(", "));
  if (scope === "scripting-unavailable") bits.push("header only (no script scoping on this Safari)");
  else if (scope.startsWith("failed:")) bits.push(scope);
  const bad = (r.rejected && r.rejected.length) || !dnrOk || scope.startsWith("failed:");
  el.className = "stat" + (bad ? " bad" : " ok");
  el.textContent = bits.join(" · ");
}

async function run(label, msg) {
  const el = $("uastat");
  el.className = "stat";
  el.textContent = label;
  draw(await send(msg));
}

$("uasave").addEventListener("click", () => run("applying…", { op: "uaSitesSet", text: $("uasites").value }));
$("uareset").addEventListener("click", () => run("restoring…", { op: "uaSitesReset" }));
run("loading…", { op: "uaSitesGet" });
