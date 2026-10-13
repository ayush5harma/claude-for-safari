// 2026-10-14: synthetic browser APIs keep screenshots reproducible without
// opening a signed-in profile or reading browsing history.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const { chromium } = await import(process.env.CFS_PLAYWRIGHT || "playwright");

const root = process.env.CFS_SCREENSHOT_ROOT || new URL("../..", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const requested = new URL(req.url, "http://fixture").pathname;
  if (!["/docs/images/fixture.html", "/extension/content.js", "/extension/options.html", "/extension/options.js"].includes(requested)) {
    res.writeHead(404); return res.end();
  }
  const pathname = join(root, requested);
  try { res.writeHead(200, { "content-type": types[extname(pathname)] || "application/octet-stream" }); res.end(await readFile(pathname)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/docs/images/`;
const browser = await chromium.launch({ headless: true });
try {
  const panel = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  await panel.goto(url + "fixture.html");
  await panel.evaluate(() => window.__screenshotFixture.open());
  await panel.waitForTimeout(100);
  await panel.evaluate(() => {
    const host = document.querySelector("#claude-safari-panel-host");
    const input = host.__fixtureShadow.querySelector("#in");
    input.value = "What should the team do next?";
    host.__fixtureShadow.querySelector("#send").click();
  });
  await panel.waitForTimeout(100);
  await panel.screenshot({ path: join(root, "docs/images/chat-panel.png") });

  const settings = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  await settings.addInitScript(() => {
    const store = { profileName: "Personal" };
    window.browser = {
      runtime: { sendMessage: async (message) => {
        if (message.op === "uaSitesGet") return { sites: ["browserstack.com", "app.slack.com"], usingDefaults: true, status: { dnr: "ok: sample", scope: "ok" } };
        return { sites: ["browserstack.com", "app.slack.com"], status: { dnr: "ok: sample", scope: "ok" } };
      } },
      storage: { local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (entries) => Object.assign(store, entries),
        remove: async (key) => delete store[key],
      } },
    };
  });
  await settings.goto(url + "../../extension/options.html");
  await settings.locator("#uasites").waitFor();
  await settings.screenshot({ path: join(root, "docs/images/settings.png") });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
