// Inline artifacts (`artifact_show`, called from a code-mode script) in Chromium: the artifact's pane renders in place
// (right after its script's wheel, before the answer), Markdown as in Markdown views, an html page in its sandboxed
// frame fitted to the content height it reports (capped at 70vh), for the owner and for a guest alike; a deleted
// artifact says so. Fake provider (`codemode <script>`), disposable sessions.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactPage } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

type Shown = { id: string; title: string; kind: "html" | "md"; content: string };

/** A counter page written against `window.p2view`: +1 saves the count (with a function) and selects it. */
const COUNTER = `<!doctype html><html><body style='margin:0'><button id=add>+1</button><p id=n></p><script>
const P2 = window.p2view;
let state = { count: 0 };
const draw = () => { document.getElementById('n').textContent = 'count ' + state.count; };
P2.onState((value) => { state = value || state; draw(); });
document.getElementById('add').addEventListener('click', () => {
	if (P2.readOnly) return;
	P2.setState((current) => ({ ...(current || state), count: (current || state).count + 1 }));
	state = { ...state, count: state.count + 1 };
	draw();
	P2.select('count ' + state.count, { count: state.count });
});
</script></body></html>`;

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;
const card = (id: string) => `document.querySelector('.artifact-inline[data-artifact="${id}"]')`;
const frame = (id: string) => `${card(id)}?.querySelector('iframe')`;

describe("inline artifacts in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: RefIn<typeof Sessions, "owner">;

	/** A new session whose agent writes and shows each of `shown`, a script each, and then runs `then` if given. */
	const publish = async (title: string, shown: Shown[], then?: string): Promise<string> => {
		const id = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		const scripts = [
			...shown.map(
				(each) =>
					`await tools.artifact_write(${JSON.stringify(each)});\nawait tools.artifact_show({ id: ${JSON.stringify(each.id)} });`,
			),
			...(then ? [then] : []),
		];
		for (const [index, code] of scripts.entries()) {
			await chat.send({ text: `codemode ${code}`, requestId: `script-${index}` }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => {
				const done = (view?.entries ?? []).flatMap((entry) =>
					(entry.model ?? []).filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolName === "codemode" && !message.isError,
					),
				);
				return done.length === index + 1 && !(view?.docs["pi.live"] as { run?: unknown })?.run;
			});
		}
		chat.release();
		return id;
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("renders inline Markdown as Markdown views do, in place, without a tap", async () => {
		const id = await publish("Inline Markdown", [
			{ id: "notes", title: "Notes", kind: "md", content: "# Inline heading\n\nSome **bold** text" },
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${card("notes")}?.querySelector('.elanor-markdown strong')?.textContent==='bold'`);
		assert.match(await browser.evaluate<string>(`${card("notes")}.textContent`), /Inline heading/);
		// Where it was shown: right after its script's wheel, before the answer.
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('[data-row]')].map((row)=>row.querySelector('[data-testid=activity]')?'activity':row.querySelector('.artifact-inline')?'inline':row.textContent.includes('Echo:')?'answer':'').filter(Boolean)`,
			),
			["activity", "inline", "activity", "answer"],
		);
	});

	it("runs an html page in its sandboxed frame, fitted to its content and capped at 70vh", async () => {
		const id = await publish("Inline HTML", [
			{
				id: "page",
				title: "Page",
				kind: "html",
				content:
					"<!doctype html><html><head><title>Page</title></head><body style='margin:0'><div style='height:240px;background:#09c'>HTML inline</div></body></html>",
			},
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${frame("page")}?.getBoundingClientRect().height===240`);
		assert.equal(
			await browser.evaluate<string>(`${frame("page")}.getAttribute('sandbox')`),
			"allow-scripts allow-modals allow-pointer-lock",
		);
		assert.equal(
			await browser.evaluate<string>(`${frame("page")}.getAttribute('src')`),
			`/artifact-frame?session=${id}&id=page&version=1`,
		);
		// An opaque origin: the page cannot reach into the frame.
		assert.equal(await browser.evaluate<boolean>(`${frame("page")}.contentDocument===null`), true);
		// Taller content stops at 70vh.
		const tall = await publish("Inline tall HTML", [
			{
				id: "tall",
				title: "Tall",
				kind: "html",
				content: "<!doctype html><html><body style='margin:0'><div style='height:3000px'>tall</div></body></html>",
			},
		]);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${tall}`);
		await browser.wait(`Math.abs(${frame("tall")}?.getBoundingClientRect().height-${Math.round(844 * 0.7)})<=1`);
	});

	it("keeps an inline page's height when it is scrolled out and back in, and the reader's place", async () => {
		const id = await publish("Inline scrolled", [
			{
				id: "tall-page",
				title: "Tall page",
				kind: "html",
				content:
					"<!doctype html><html><body style='margin:0'><div style='height:500px;background:#09c'>tall page</div></body></html>",
			},
		]);
		// Enough transcript below it to scroll it far out of view (beyond the cards' two-viewport margin).
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		for (let index = 0; index < 8; index++) {
			await chat.send(
				{ text: `filler ${index} ${"words to fill the screen ".repeat(120)}`, requestId: `filler-${index}` },
				BACKGROUND_CONTEXT,
			);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: filler ${index}`));
		}
		chat.release();
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		const scroller = "document.querySelector('.scroller.transcript')";
		await browser.wait(`document.querySelector('.rows')?.textContent.includes('Echo: filler 7')`);
		// It opens at the bottom: up to the card (the transcript draws the rows near the reader).
		await browser.evaluate(`(() => { const s = ${scroller}; s.scrollTop = 0; })()`);
		await browser.wait(`${card("tall-page")}`);
		await browser.evaluate(`${card("tall-page")}.scrollIntoView({ block: "start" })`);
		await browser.wait(`${frame("tall-page")}?.getBoundingClientRect().height === 500`);
		// Where the card sits in the transcript's content, and 100px above it: where the test puts the reader.
		const place = await browser.evaluate<number>(
			`(() => { const s = ${scroller}; return Math.round(${card("tall-page")}.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 100); })()`,
		);
		for (let round = 0; round < 3; round++) {
			await browser.evaluate(`(() => { const s = ${scroller}; s.scrollTop = s.scrollHeight; })()`);
			// Far out of view: the page goes (its card may go with its row).
			await browser.wait(`!${frame("tall-page")}`);
			// Back to it, then watch every frame for a while: the card never shrinks, the reader's place never moves.
			const seen = await browser.evaluate<{ heights: number[]; tops: number[] }>(`(async () => {
				const s = ${scroller};
				s.scrollTop = ${place};
				const heights = [], tops = [];
				const until = performance.now() + 2500;
				while (performance.now() < until) {
					await new Promise((resolve) => requestAnimationFrame(resolve));
					const box = ${card("tall-page")};
					if (box) heights.push(Math.round(box.getBoundingClientRect().height));
					tops.push(Math.round(s.scrollTop));
				}
				return { heights, tops };
			})()`);
			assert.ok(seen.heights.length > 0, `round ${round}: the card is drawn again`);
			assert.ok(Math.min(...seen.heights) >= 499, `round ${round}: heights ${[...new Set(seen.heights)]}`);
			assert.deepEqual([...new Set(seen.tops)], [place], `round ${round}: the reader's place`);
			await browser.wait(`${frame("tall-page")}?.getBoundingClientRect().height === 500`);
		}
	});

	it("lets people who may send change an inline page and select in it; a read-only guest's is read-only", async () => {
		const id = await publish(
			"Inline counter",
			[{ id: "counter", title: "Counter", kind: "html", content: COUNTER }],
			'await tools.artifact_html_set_state({ id: "counter", state: { count: 41 } });',
		);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		const inFrame = (page: Browser, expression: string) => page.evaluateInFrame<string>(`id=counter&`, expression);
		const shows = (page: Browser, text: string) =>
			poll(
				() =>
					inFrame(page, "document.getElementById('n').textContent")
						.then((shown) => shown === text)
						.catch(() => false),
				20_000,
				`the page shows ${text}`,
			);
		await shows(browser, "count 41");
		assert.equal(await inFrame(browser, "String(window.p2view.readOnly)"), "false");
		await inFrame(browser, "document.getElementById('add').click()");
		// Saved as beside the chat, and the selection goes with the next message (the composer's chip says so).
		const page = await holdIn(fixture.browser(), ArtifactPage, { session: id, id: "counter" }, "editor");
		await until(page.value, (value) => (value as { count?: number } | null)?.count === 42);
		await browser.wait(`document.querySelector('.views-chip')?.textContent.includes('Selection in Counter')`);
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "what did I pick", requestId: "pick" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) =>
			JSON.stringify(view?.entries ?? []).includes(
				'Selected in html \\"counter\\" (\\"Counter\\") shown in the transcript: count 42',
			),
		);
		chat.release();
		await browser.wait(`!document.querySelector('.views-chip')`);
		// A read-only guest: the page runs, but is read-only and saves nothing.
		const sharing = fixture.browser().hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 1);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 900);
			await guest.open(`http://127.0.0.1:${fixture.server.port}${new URL(links![0]!.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await guest.evaluate(setInput("#name", "Reader"));
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			await shows(guest, "count 42");
			assert.equal(await inFrame(guest, "String(window.p2view.readOnly)"), "true");
			await inFrame(guest, "document.getElementById('add').click()");
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.deepEqual(page.value.value, { count: 42 });
		} finally {
			await guest.close();
			sharing.release();
			page.release();
		}
	});

	it("says when the artifact was deleted", async () => {
		const id = await publish(
			"Inline gone",
			[{ id: "gone", title: "Gone", kind: "md", content: "# Gone" }],
			'await tools.artifact_delete({ id: "gone" });',
		);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${card("gone")}?.textContent.includes('No artifact "gone" (it was deleted)')`);
	});

	it("renders inline html and Markdown for a read-only guest too, without a tap", async () => {
		const id = await publish("Inline for guests", [
			{ id: "notes", title: "Notes", kind: "md", content: "Some **bold** text" },
			{
				id: "page",
				title: "Page",
				kind: "html",
				content:
					"<!doctype html><html><head><title>Page</title></head><body style='margin:0'><div style='height:240px;background:#09c'>HTML inline</div></body></html>",
			},
		]);
		const sharing = fixture.browser().hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 1);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 900);
			// A fresh profile on loopback gets the join form and joins as a guest (loopback-join.test.ts).
			await guest.open(`http://127.0.0.1:${fixture.server.port}${new URL(links![0]!.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await guest.evaluate(setInput("#name", "Reader"));
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			// The page reports its content height: its scripts ran in the frame, so it rendered.
			await guest.evaluate(`${card("page")}?.scrollIntoView({ block: "center" })`);
			await guest.wait(`${frame("page")}?.getBoundingClientRect().height===240`);
			await guest.wait(`${card("notes")}?.querySelector('.elanor-markdown strong')?.textContent==='bold'`);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
