// Browser interactions for the faithful mobile drawer and new-session surface. All providers and data are disposable.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;

describe("drawer and new-session parity", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		await fixture
			.browser()
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("hides the new-session title, opens sign-in and the model sheet, selects cwd, and sends an attached first message", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		assert.equal(
			await browser.evaluate<string>(`getComputedStyle(document.querySelector('.topbar .title')).visibility`),
			"hidden",
		);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.hero input').length`), 0);
		await browser.wait(
			`[...document.querySelectorAll('.hero button')].some(e=>e.textContent==='Sign in to a provider')`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.hero button')].find(e=>e.textContent==='Sign in to a provider').classList.add('test-signin')`,
		);
		await browser.click(".test-signin");
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Providers]')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
		await browser.click('button[aria-label="Model and thinking"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Model] input[aria-label="Search models"]')`);
		await browser.evaluate(setInput('input[aria-label="Search models"]', "faux"));
		await browser.wait(
			`document.querySelector('.model-list .empty-note')?.textContent==='No models match. Only signed-in providers are listed.'`,
		);
		await browser.click("[role=dialog] button[aria-label=Close]");
		await browser.click(".cwd-pick");
		await browser.wait(`document.querySelector('.directory-use:not(:disabled)')`);
		await browser.evaluate(setInput("input[aria-label=Directory]", fixture.workspace));
		await browser.evaluate(`document.querySelector('input[aria-label=Directory]').form.requestSubmit()`);
		await browser.wait(
			`document.querySelector('.directory-use:not(:disabled)')?.textContent.trim()===${JSON.stringify(`Use ${fixture.workspace}`)}`,
		);
		await browser.click(".directory-use");
		await browser.wait(`!document.querySelector('[role=dialog]')`);
		writeFileSync(join(fixture.workspace, "first.txt"), "First-message attachment\n");
		const document = (await browser.call("DOM.getDocument")) as { root: { nodeId: number } };
		const node = (await browser.call("DOM.querySelector", {
			nodeId: document.root.nodeId,
			selector: ".composer input[type=file]",
		})) as { nodeId: number };
		await browser.call("DOM.setFileInputFiles", {
			nodeId: node.nodeId,
			files: [join(fixture.workspace, "first.txt")],
		});
		await browser.wait(`document.querySelector('.attachment-name')?.textContent==='first.txt'`);
		await browser.evaluate(setInput(".composer textarea", "First prompt"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(
			`location.pathname.startsWith('/s/') && document.querySelector('.messages .bubble-files')?.textContent.includes('first.txt')`,
		);
		await browser.wait(`document.querySelector('.messages .assistant')?.textContent.includes('Echo: First prompt')`);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent.startsWith('First prompt')`);
		assert.equal(await browser.evaluate<string>(`document.querySelector('.composer textarea').value`), "");
	});

	it("collapses and reopens the desktop sidebar without a navigation step; closes the phone drawer through Back and scrim", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('.collapse-sidebar') && !document.querySelector('.offline')`);
		const length = await browser.evaluate<number>("history.length");
		await browser.click('button[aria-label="Collapse sidebar"]');
		await browser.wait(`getComputedStyle(document.querySelector('.drawer')).display==='none'`);
		assert.equal(
			await browser.evaluate<number>('document.querySelector(".main").getBoundingClientRect().width'),
			1280,
		);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`!document.querySelector('.sidebar-collapsed')`);
		assert.equal(await browser.evaluate<number>("history.length"), length);
		await browser.metrics(390, 844);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.app.drawer-open')`);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('.app.drawer-open')`);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.drawer').getBoundingClientRect().left>=-1`);
		await browser.clickPoint(380, 300);
		await browser.wait(`!document.querySelector('.app.drawer-open')`);
	});

	it("groups cwd identities, orders pinned sessions first, expands child rows in the header, and keeps child busy dots visible when collapsed", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const second = join(fixture.workspace, "second");
		mkdirSync(second);
		const pinned = await sessions.create({ cwd: fixture.workspace, title: "Pinned parent" }, BACKGROUND_CONTEXT);
		const recent = await sessions.create({ cwd: fixture.workspace, title: "Recent sibling" }, BACKGROUND_CONTEXT);
		const other = await sessions.create({ cwd: second, title: "Other directory" }, BACKGROUND_CONTEXT);
		await sessions.pin({ id: pinned.id, pinned: true }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(async (ctx) => {
			const catalog = await ctx.get(Catalog, {});
			await catalog.activity({ id: pinned.id, timestamp: Date.now() + 1000 }, ctx);
			await catalog.activity({ id: recent.id, timestamp: Date.now() + 2000 }, ctx);
			await catalog.activity({ id: other.id, timestamp: Date.now() + 3000 }, ctx);
		}, BACKGROUND_CONTEXT);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${pinned.id}`);
		await browser.wait(`[...document.querySelectorAll('.session-title')].some(e=>e.textContent==='Pinned parent')`);
		const groups = await browser.evaluate<{ cwd: string; titles: string[] }[]>(
			`[...document.querySelectorAll('.session-scroll .group')].map(g=>({cwd:g.querySelector('h3').title,titles:[...g.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)}))`,
		);
		assert.equal(groups[0].cwd, second);
		assert.deepEqual(groups.find((group) => group.cwd === fixture.workspace)?.titles.slice(0, 2), [
			"Pinned parent",
			"Recent sibling",
		]);
		const chat = await holdIn(owner, Chat, { session: pinned.id, conversation: 1 }, "participant");
		await chat.send({ text: "subagent", requestId: "drawer-child" }, BACKGROUND_CONTEXT);
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const children = await until(agents.children, (children) => Boolean(children?.[pinned.id]?.length));
		const child = children?.[pinned.id]?.[0];
		assert(child);
		await browser.wait(`document.querySelector('.session-header.has-subagents .subagent-toggle')`);
		assert.equal(
			await browser.evaluate<number>(
				`document.querySelectorAll('.drawer button[aria-label="Session options"]').length`,
			),
			0,
		);
		await browser.click(".session-header.has-subagents .subagent-toggle");
		await browser.wait(
			`document.querySelector('.subagent-row') && !document.querySelector('.subagent-row').parentElement.hidden`,
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('.subagent-row .session-meta').textContent.trim()`),
			"faux-1",
		);
		await browser.click(".session-header.has-subagents .subagent-toggle");
		const childChat = await holdIn(
			owner,
			Chat,
			{ session: pinned.id, conversation: child.conversationId },
			"participant",
		);
		await childChat.send({ text: "slow child", requestId: "drawer-busy" }, BACKGROUND_CONTEXT);
		await browser.wait(`document.querySelector('.session-header.has-subagents .live-dot')`);
		await browser.click(".session-header.has-subagents .subagent-toggle");
		await browser.wait(`document.querySelector('.subagent-row .live-dot')`);
		await browser.click(".subagent-row");
		await browser.wait(
			`location.pathname.endsWith('/c/${child.conversationId}') && document.querySelector('.subagent-row.active')`,
		);
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await childChat.stop(BACKGROUND_CONTEXT);
		await until(status.statuses, (states) => !states?.[pinned.id]?.busy.includes(child.conversationId));
		// With `/tree` branches as well, the one control shows the branch rows, then the subagents, and hides both.
		await until(status.statuses, (states) => states?.[pinned.id]?.tasks === 0);
		const tree = await holdIn(owner, SessionTree, { session: pinned.id }, "owner");
		const first = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find((node) => node.role === "user")!;
		await tree.navigate({ entry: first.entry }, BACKGROUND_CONTEXT);
		await tree.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		tree.release();
		const toggle = `document.querySelector('.subagent-toggle[aria-controls="branches-${pinned.id} subagents-${pinned.id}"]')`;
		await browser.wait(`${toggle}?.getAttribute('aria-label')==='Collapse branches and subagents'`);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.getElementById('branches-${pinned.id}').parentElement.children].slice(1).map(e=>e.id+(e.hidden?':hidden':''))`,
			),
			[`branches-${pinned.id}`, `subagents-${pinned.id}`],
		);
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(
			`document.getElementById('branches-${pinned.id}').hidden && document.getElementById('subagents-${pinned.id}').hidden`,
		);
		assert.equal(
			await browser.evaluate<string>(`${toggle}.getAttribute('aria-label')`),
			"Expand branches and subagents",
		);
	});

	it("preserves rename, pin and archive after moving actions out of session rows", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Options original" }, BACKGROUND_CONTEXT);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		await browser.click('.main button[aria-label="Session options"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Session] input[aria-label=Title]')`);
		await browser.evaluate(setInput("input[aria-label=Title]", "Options renamed"));
		await browser.click("[role=dialog] button[type=submit]");
		await browser.wait(`document.querySelector('.topbar h1')?.textContent==='Options renamed'`);
		await browser.click('.main button[aria-label="Session options"]');
		await browser.click("[role=dialog] .list .row-button:nth-child(3)");
		await until(sessions.sessions, (list) => Boolean(list?.find((row) => row.id === session.id)?.pinned));
		await browser.click("[role=dialog] .row-button.danger");
		await browser.wait(`location.pathname==='/' && !document.querySelector('[role=dialog]')`);
		await until(sessions.sessions, (list) => Boolean(list?.find((row) => row.id === session.id)?.archivedAt));
		await browser.click(".drawer-foot .foot-button");
		await browser.wait(
			`[...document.querySelectorAll('.session-main .session-title')].some(e=>e.textContent==='Options renamed')`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.session-main')].find(e=>e.querySelector('.session-title').textContent==='Options renamed').classList.add('test-restored')`,
		);
		await browser.click(".test-restored");
		await browser.wait(`location.pathname==='/s/${session.id}'`);
		await until(sessions.sessions, (list) => list?.find((row) => row.id === session.id)?.archivedAt === null);
	});

	it("drags the phone drawer open from anywhere on the chat and closed on the drawer, never while scrolling, mirrored in RTL", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Swipe target" }, BACKGROUND_CONTEXT);
		const touch = (type: string, x?: number, y?: number) =>
			browser.call("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y }] });
		// A drag from (x0, y0) to (x1, y1) in `steps` moves `ms` apart; `during` runs before the finger lifts. A flick
		// lifts right after its last move, as a finger does; otherwise a slow test run looks like a finger that rested.
		const swipe = async (
			[x0, y0, x1, y1]: [number, number, number, number],
			{
				steps = 12,
				ms = 16,
				during,
				flick = false,
			}: { steps?: number; ms?: number; during?: () => Promise<void>; flick?: boolean } = {},
		) => {
			await touch("touchStart", x0, y0);
			for (let step = 1; step <= steps; step++) {
				const moved = touch("touchMove", x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps);
				if (flick && step === steps) break;
				await moved;
				await new Promise((resolve) => setTimeout(resolve, ms));
			}
			await during?.();
			await touch("touchEnd");
		};
		const rect = `document.querySelector('.drawer').getBoundingClientRect()`;
		const settled = (open: boolean, rtl = false) =>
			browser.wait(
				`${open ? "" : "!"}document.querySelector('.app.drawer-open') && !document.querySelector('.drawer').style.transform && ${
					rtl
						? open
							? `${rect}.right>=389`
							: `${rect}.left>=389`
						: open
							? `${rect}.left>=-1`
							: `${rect}.right<=1`
				}`,
			);
		const scrollTop = () => browser.evaluate<number>(`document.querySelector('.test-scroll').scrollTop`);
		const untouched = async () =>
			assert.equal(await browser.evaluate<string>(`document.querySelector('.drawer').style.transform`), "");
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		try {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			await browser.wait(`document.querySelector('.scroller') && !document.querySelector('.offline')`);
			assert.equal(
				await browser.evaluate<string>(`getComputedStyle(document.querySelector('.scroller')).touchAction`),
				"pan-y pinch-zoom",
			);
			// A vertical scroller in the chat column styled like the transcript (whose own layout is not this test's
			// business), holding an element that handles its own touches (touch-action: none, like the terminal) and a
			// code block wider than the screen.
			await browser.evaluate(
				`document.querySelector('.main').insertAdjacentHTML('beforeend', '<div class="test-scroll" style="position:fixed;inset:120px 0 0 0;z-index:10;overflow-y:auto;touch-action:pan-y pinch-zoom;background:var(--bg)"><div class="test-own-drag" style="height:200px;touch-action:none"></div><pre class="test-code" style="overflow-x:auto;height:150px;margin:0"><code>' + 'x'.repeat(400) + '</code></pre><div style="height:3000px"></div></div>')`,
			);
			assert.ok(
				await browser.evaluate<boolean>(`document.elementFromPoint(200, 700).closest('.test-scroll') !== null`),
			);

			// A steep diagonal scrolls the transcript and never moves the drawer, even when it turns flat.
			await swipe([200, 700, 260, 600], {
				during: async () => {
					await untouched();
					await touch("touchMove", 380, 600);
					await untouched();
				},
			});
			assert.ok((await scrollTop()) > 50, "the steep drag scrolled");
			await settled(false);
			// Right after the fling, the touch that stops it cannot cancel its moves; a flat drag still opens the drawer.
			await swipe([40, 700, 300, 680]);
			await settled(true);
			await browser.evaluate(`history.back()`);
			await settled(false);
			// A flat diagonal drags the drawer and never scrolls, even when it turns steep.
			let before = -1;
			await poll(
				async () => {
					const now = await scrollTop();
					const resting = now === before;
					before = now;
					return resting;
				},
				5000,
				"the transcript at rest",
			);
			await swipe([40, 700, 300, 620], {
				during: async () => {
					await touch("touchMove", 300, 400);
					assert.equal(await scrollTop(), before, "the swipe did not scroll");
				},
			});
			await settled(true);
			await browser.evaluate(`history.back()`);
			await settled(false);
			await browser.evaluate(`document.querySelector('.test-scroll').scrollTop = 0`);

			// Drags toward the inline start and drags on an element that handles its own touches stay with the page.
			await swipe([300, 700, 40, 700]);
			await swipe([60, 220, 380, 220]);
			await settled(false);
			// A code block scrolled away from its start scrolls back first; at its start the drawer takes the drag.
			await browser.evaluate(`document.querySelector('.test-code').scrollLeft = 120`);
			const code = await browser.evaluate<number>(
				`document.querySelector('.test-code').getBoundingClientRect().top + 75`,
			);
			await swipe([60, code, 300, code]);
			await settled(false);
			assert.ok((await browser.evaluate<number>(`document.querySelector('.test-code').scrollLeft`)) < 120);
			await browser.evaluate(`document.querySelector('.test-code').scrollLeft = 0`);
			await swipe([60, code, 300, code]);
			await settled(true);
			await browser.evaluate(`history.back()`);
			await settled(false);

			// The drawer follows the finger from mid-screen; a slow, short drag settles back closed.
			await swipe([200, 700, 320, 700], {
				steps: 20,
				ms: 30,
				during: async () => {
					const right = await browser.evaluate<number>(`${rect}.right`);
					assert.ok(right > 80 && right < 120, `drawer edge at ${right}`);
				},
			});
			await settled(false);

			await swipe([150, 700, 380, 700]);
			await settled(true);
			// Opening is a navigation step: Back closes it.
			await browser.evaluate(`history.back()`);
			await settled(false);
			await swipe([150, 700, 380, 700]);
			await settled(true);
			// A quick flick toward the start on the drawer closes it, though it moved less than half its width.
			await swipe([250, 700, 150, 700], { steps: 5, flick: true });
			await settled(false);

			await browser.evaluate(`document.documentElement.dir='rtl'`);
			await settled(false, true);
			await swipe([100, 700, 370, 700]);
			await settled(false, true);
			await swipe([300, 700, 40, 700]);
			await settled(true, true);
			await swipe([150, 700, 380, 700]);
			await settled(false, true);
		} finally {
			await browser.evaluate(`document.documentElement.removeAttribute('dir')`);
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		}
	});
});

describe("guest drawer in Chromium", { skip: !browserTests }, () => {
	it("shows only the shared session, guest identity and theme; no owner actions or search", async () => {
		const directory = mkdtempSync(join(tmpdir(), "p2-guest-browser-"));
		const key = join(directory, "key.pem"),
			cert = join(directory, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=guest.test",
			],
			{ stdio: "ignore" },
		);
		let fixture: Fixture | undefined;
		const sockets = new Set<Duplex>();
		const proxy = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, response) => {
			const upstream = request(
				{
					hostname: "127.0.0.1",
					port: fixture!.server.port,
					path: incoming.url,
					method: incoming.method,
					headers: incoming.headers,
				},
				(result) => {
					response.writeHead(result.statusCode ?? 502, result.headers);
					result.pipe(response);
				},
			);
			upstream.on("error", () => {
				response.writeHead(502);
				response.end();
			});
			incoming.pipe(upstream);
		});
		proxy.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		proxy.on("upgrade", (incoming, socket, head) => {
			const upstream = connect(fixture!.server.port, "127.0.0.1", () => {
				upstream.write(
					`${incoming.method} ${incoming.url} HTTP/1.1\r\n${incoming.rawHeaders.reduce((out, value, i, all) => (i % 2 === 0 ? `${out}${value}: ${all[i + 1]}\r\n` : out), "")}\r\n`,
				);
				if (head.length) upstream.write(head);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			socket.on("close", () => upstream.destroy());
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		assert(address && typeof address === "object");
		const host = `guest.test:${address.port}`;
		let browser: Browser | undefined;
		try {
			fixture = await startFixture({ web: true, allowedHosts: [host] });
			const owner = fixture.browser(),
				sessions = await holdIn(owner, Sessions, {}, "owner");
			const shared = await sessions.create({ cwd: fixture.workspace, title: "Shared visible" }, BACKGROUND_CONTEXT);
			await sessions.create({ cwd: fixture.workspace, title: "Private hidden" }, BACKGROUND_CONTEXT);
			const sharing = owner.hold(Sharing, { session: shared.id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
			const links = await until(sharing.links, (links) => Boolean(links?.length));
			assert(links?.[0]);
			browser = await Browser.start([
				"--ignore-certificate-errors",
				"--no-proxy-server",
				"--host-resolver-rules=MAP guest.test 127.0.0.1",
			]);
			await browser.metrics(390, 844);
			await browser.open(links[0].url);
			await browser.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await browser.evaluate(setInput("#name", "Guest browser"));
			await browser.click("#join button");
			await browser.wait(
				`document.querySelector('nav[aria-label="Shared session"]') && !document.querySelector('.offline')`,
			);
			await browser.click(".topbar button[aria-label=Sessions]");
			await browser.wait(`document.querySelector('.drawer').getBoundingClientRect().left>=-1`);
			const state = await browser.evaluate<{
				identity: string;
				titles: string[];
				ownerButtons: number;
				search: boolean;
			}>(
				`(()=>{const n=document.querySelector('nav[aria-label="Shared session"]');return {identity:n.querySelector('.empty-note').textContent,titles:[...n.querySelectorAll('.session-title')].map(e=>e.textContent),ownerButtons:n.querySelectorAll('.new-session,.foot-button,.collapse-sidebar').length,search:Boolean(n.querySelector('.search'))};})()`,
			);
			assert.match(state.identity, /Joined as Guest browser\s*Read-only/);
			assert.deepEqual(state.titles, ["Shared visible"]);
			assert.equal(state.ownerButtons, 0);
			assert.equal(state.search, false);
			await browser.click('nav[aria-label="Shared session"] .theme-toggle');
			await browser.wait(`document.documentElement.dataset.theme==='light'`);
			// A shared session installs as a home-screen app too, and can poll the current bundle manifest.
			const fetched = await browser.evaluate<{ manifest: number; icon: number; bundle: number; title: string }>(
				`Promise.all(['/manifest.webmanifest','/icons/icon-192.png','/__p2_web'].map((path)=>fetch(path).then((r)=>r.status))).then(([manifest,icon,bundle])=>({manifest,icon,bundle,title:document.title}))`,
			);
			assert.deepEqual(fetched, { manifest: 200, icon: 200, bundle: 200, title: "Pi" });
			assert.equal(
				await browser.evaluate<string>(`document.querySelector('link[rel=manifest]').getAttribute('href')`),
				"/manifest.webmanifest",
			);
			// The owner resets the link: the page says so (Pi Mobile's text) instead of reconnecting forever.
			await sharing.link({ mode: "view", reset: true }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.toast')?.textContent === 'This share has ended.'`);
			assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.messages .user').length`), 0);
		} finally {
			await browser?.close();
			await fixture?.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
