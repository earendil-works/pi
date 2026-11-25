// The MCP sheet in the browser across a dropped link: the servers stay listed while the page reconnects, a sheet opened
// while the link is down says it is loading, and the servers appear once the page is back.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { MCP_OWNER, Mcp } from "../../plugins/mcp/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));

/** Records the page's sockets; while `p2Blocked`, new ones go to a closed port (the link stays down). */
const SOCKETS = `(() => {
	const Native = WebSocket;
	window.p2Sockets = [];
	window.p2Blocked = false;
	window.WebSocket = class extends Native {
		constructor(url, protocols) {
			super(window.p2Blocked ? String(url).replace(/^ws:\\/\\/[^/]+/, "ws://127.0.0.1:9") : url, protocols);
			window.p2Sockets.push(this);
		}
	};
})();`;

const navItem = (label: string) =>
	`[...document.querySelectorAll('.settings-nav-item')].find((e) => e.textContent === ${JSON.stringify(label)})`;
const PAGE = `document.querySelector('.settings-page[aria-label="MCP servers"]')`;
const LISTED = `${PAGE}?.querySelector('.mcp-server strong')?.textContent === 'fixture' && ${PAGE}.textContent.includes('Connected')`;

describe("MCP sheet across a dropped link", { skip: !browserTests, timeout: 120_000 }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(
			join(fixture.dataDir, "mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } }),
		);
		// Servers run while sessions use them: a session's worker leases the fixture server.
		const owner = fixture.browser();
		const sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		const session = await sessions.create({ cwd: fixture.workspace, title: "MCP" }, BACKGROUND_CONTEXT);
		await holdWith(owner, Chat, { session: session.id, conversation: 1 }, ...CHAT_PARTICIPANT);
		const mcp = await holdWith(owner, Mcp, {}, ...MCP_OWNER);
		await until(mcp.instances, (instances) => instances.some((instance) => instance.status === "connected"));
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: SOCKETS });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("keeps the servers while reconnecting, says Loading… while down, and lists them once back", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector('.drawer-foot .settings-open')`);
		await browser.evaluate(`document.querySelector('.drawer-foot .settings-open').click()`);
		await browser.wait(navItem("MCP servers"));
		await browser.evaluate(`${navItem("MCP servers")}.click()`);
		await browser.wait(LISTED);

		// The link drops and stays down: the servers stay as last seen, never an empty sheet.
		await browser.evaluate(`window.p2Blocked = true; for (const socket of window.p2Sockets) socket.close();`);
		for (let sample = 0; sample < 10; sample++) {
			await browser.wait(LISTED);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		// Opened again while the link is down (the view released, no values yet): it says it is loading.
		await browser.click(".settings-page button[aria-label=Back]");
		await browser.wait(`${navItem("MCP servers")}?.offsetParent && !${PAGE}`);
		await browser.evaluate(`${navItem("MCP servers")}.click()`);
		await browser.wait(`${PAGE}?.querySelector('.empty-note')?.textContent === 'Loading…'`);

		// The page reconnects: the servers appear.
		await browser.evaluate(`window.p2Blocked = false;`);
		await browser.wait(LISTED);
	});
});
