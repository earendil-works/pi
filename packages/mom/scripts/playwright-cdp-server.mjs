#!/usr/bin/env node
/**
 * Exposes Chromium's DevTools Protocol on a local TCP port so you can forward
 * that port from the remote host and attach Chrome (chrome://inspect) or any
 * CDP client. This does not "host" LinkedIn on localhost — it exposes the
 * browser debugger; LinkedIn still loads in that browser tab.
 *
 * Usage:
 *   PLAYWRIGHT_CDP_PORT=9222 npm run playwright:cdp
 *   npm run playwright:cdp -- https://www.linkedin.com/login
 *
 * Then forward PLAYWRIGHT_CDP_PORT from the remote machine and in local Chrome:
 *   chrome://inspect → Discover network targets → add localhost:<forwarded_port>
 *
 * http://127.0.0.1:<port>/ is the CDP API (often a blank tab), not the LinkedIn UI.
 * Use chrome://inspect or the printed devtoolsFrontendUrl for the "page" target.
 */
import { chromium } from "playwright";

const port = process.env.PLAYWRIGHT_CDP_PORT ?? "9222";
const startUrl = process.argv[2] ?? "https://www.linkedin.com/";
const headed = process.env.PLAYWRIGHT_HEADED === "1";

const args = [`--remote-debugging-port=${port}`];

const browser = await chromium.launch({
	headless: !headed,
	args,
});

const page = await browser.newPage();
await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = /** @type {Array<{ type?: string; devtoolsFrontendUrl?: string }>} */ (
	await listRes.json()
);
const pageTarget = targets.find((t) => t.type === "page");
const pageId = pageTarget && "id" in pageTarget ? pageTarget.id : undefined;

/** Local Chrome DevTools (avoids appspot.com); still needs correct WS port after forward. */
const bundledInspector =
	pageId != null
		? `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${port}/devtools/page/${pageId}`
		: "";

const hint = [
	`Chromium remote debugging: http://127.0.0.1:${port}`,
	``,
	`IMPORTANT — "WebSocket disconnected" on appspot DevTools:`,
	`  • devtoolsFrontendUrl uses ws=localhost:${port}. Your port forward must expose THAT same`,
	`    port on your Mac, OR edit the URL: replace localhost:${port} with localhost:<Cursor-local-port>.`,
	`  • If the Playwright/Chromium process on the server stopped, reconnect: restart npm run playwright:cdp`,
	`    and open a NEW devtools URL (page id in /json/list changes).`,
	``,
	`Easiest: Chrome → chrome://inspect → Configure → localhost:<forwarded-port> → Inspect the "page" target.`,
	bundledInspector ? `\nAlternative (local bundled DevTools):\n${bundledInspector}\n` : "",
	pageTarget?.devtoolsFrontendUrl ? `Appspot DevTools (same ws port issue):\n${pageTarget.devtoolsFrontendUrl}\n` : "",
	`Targets: http://127.0.0.1:${port}/json/list`,
	`Close with Ctrl+C.`,
].join("\n");
console.error(hint);

const shutdown = async () => {
	await browser.close().catch(() => {});
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
