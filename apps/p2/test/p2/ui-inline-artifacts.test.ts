// Inline artifacts (`artifact` with `inline: true`) in Chromium: the call's version renders below its card, Markdown
// as in the viewer, SVG and HTML drawings filling the sandboxed frame's width, the frame fitted to the content height
// they report (capped at 70vh), for the owner and for a guest alike; the card still opens the full viewer; a version
// the route cannot serve says so. Fake provider (`artifact <json>`), disposable sessions.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

type Call = { name: string; title: string; type: "html" | "svg" | "markdown" | "text"; content: string };

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;
const frame = (name: string) => `document.querySelector('.inline-artifact[data-artifact="${name}:1"] iframe')`;

/** The drawing's rendered size inside an SVG preview (its viewBox through the root's scale) and the frame's. */
type Drawn = { width: number; height: number; frameWidth: number; frameHeight: number };
const DRAWN =
	"(()=>{const root=document.documentElement,box=root.viewBox.baseVal,scale=root.getScreenCTM().a;return {width:box.width*scale,height:box.height*scale,frameWidth:innerWidth,frameHeight:innerHeight}})()";

const DIAGRAM =
	"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 200'><rect width='400' height='200' fill='#eef'/><line x1='100' y1='40' x2='100' y2='190' stroke='#333'/><line x1='300' y1='40' x2='300' y2='190' stroke='#333'/><text x='100' y='30' text-anchor='middle'>Client</text><text x='300' y='30' text-anchor='middle'>Server</text><path d='M100 80 H300' stroke='#06c' marker-end='url(#a)'/><defs><marker id='a' markerWidth='8' markerHeight='8' refX='8' refY='4' orient='auto'><path d='M0 0 L8 4 L0 8 z' fill='#06c'/></marker></defs></svg>";

describe("inline artifacts in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: RefIn<typeof Sessions, "owner">;

	/** A new session whose agent publishes `calls` with `inline: true`, each to the end of its run. */
	const publish = async (title: string, calls: Call[]): Promise<string> => {
		const id = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		for (const [index, call] of calls.entries()) {
			await chat.send(
				{ text: `artifact ${JSON.stringify({ ...call, inline: true })}`, requestId: `${call.name}-${index}` },
				BACKGROUND_CONTEXT,
			);
			await until(chat.view, (view) => {
				const done = (view?.entries ?? []).flatMap((entry) =>
					(entry.model ?? []).filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolName === "artifact",
					),
				);
				return done.length === index + 1 && !(view?.docs["pi.live"] as { run?: unknown })?.run;
			});
		}
		chat.release();
		return id;
	};

	/**
	 * Waits until the drawing inside a preview frame (`expression` gives its rendered size and the frame's viewport, read
	 * inside the frame) fills the frame's width and height, and the iframe element on the page has that size too. The
	 * frame's own viewport follows the element's size a moment later (another process).
	 */
	const fitsFrame = async (url: string, expression: string, element: string): Promise<void> => {
		let last: { drawn?: Drawn; box?: { width: number; height: number } } = {};
		await poll(
			async () => {
				const drawn = await browser.evaluateInFrame<Drawn>(url, expression);
				const box = await browser.evaluate<{ width: number; height: number }>(
					`(({width,height})=>({width,height}))(${element}.getBoundingClientRect())`,
				);
				last = { drawn, box };
				return (
					Math.abs(drawn.width - box.width) <= 2 &&
					Math.abs(drawn.height - box.height) <= 2 &&
					Math.abs(drawn.frameWidth - box.width) <= 2 &&
					Math.abs(drawn.frameHeight - box.height) <= 2
				);
			},
			10_000,
			`${url}: the drawing fills its frame`,
		).catch(() => assert.fail(`${url}: the drawing fills its frame, got ${JSON.stringify(last)}`));
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("renders inline Markdown with the viewer's Markdown component, without a tap", async () => {
		const id = await publish("Inline Markdown", [
			{ name: "notes", title: "Notes", type: "markdown", content: "# Inline heading\n\nSome **bold** text" },
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(
			`document.querySelector('.inline-artifact[data-artifact="notes:1"] .md h3')?.textContent==='Inline heading'`,
		);
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.inline-artifact[data-artifact="notes:1"] .md strong').textContent`,
			),
			"bold",
		);
		// Below its card, which stays.
		assert.equal(
			await browser.evaluate<boolean>(
				`document.querySelector('.file-tool .file-card + .inline-artifact')?.dataset.artifact==='notes:1'`,
			),
			true,
		);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.viewer-panel').length`), 0);
	});

	it("fills the frame's width with an inline SVG drawing, fits the frame to it, and the card opens the viewer", async () => {
		const id = await publish("Inline SVG", [
			{ name: "flow", title: "Flow", type: "svg", content: DIAGRAM },
			// No viewBox, a small absolute size: scaled up to the width all the same.
			{
				name: "badge",
				title: "Badge",
				type: "svg",
				content:
					"<svg xmlns='http://www.w3.org/2000/svg' width='200' height='80'><rect width='200' height='80' fill='#cde'/><text x='10' y='50'>badge</text></svg>",
			},
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${frame("flow")} && ${frame("badge")}`);
		const flow = frame("flow");
		assert.equal(
			await browser.evaluate<string>(`${flow}.getAttribute('sandbox')`),
			"allow-scripts allow-modals allow-pointer-lock",
		);
		assert.equal(
			await browser.evaluate<string>(`${flow}.getAttribute('src')`),
			`/artifact?session=${id}&name=flow&version=1`,
		);
		// An opaque origin: the page cannot reach into the frame.
		assert.equal(await browser.evaluate<boolean>(`${flow}.contentDocument===null`), true);
		for (const [name, aspect] of [
			["flow", 0.5],
			["badge", 0.4],
		] as const) {
			await browser.evaluate(`${frame(name)}.scrollIntoView({ block: "center" })`);
			await browser.wait(
				`Math.abs(${frame(name)}.getBoundingClientRect().height-${frame(name)}.clientWidth*${aspect})<=2`,
			);
			await fitsFrame(`session=${id}&name=${name}&`, DRAWN, frame(name));
		}
		await browser.evaluate(
			`document.querySelector('button[aria-label="Open Flow"]').scrollIntoView({ block: "center" })`,
		);
		await browser.click('button[aria-label="Open Flow"]');
		await browser.wait(`document.querySelector('.viewer-panel iframe')`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.viewer-head').textContent`),
			/svg · version 1/,
		);
		await browser.click('button[aria-label="Close viewer"]');
		await browser.wait(`!document.querySelector('.viewer-panel')`);
	});

	it("fills the width with an HTML page's only SVG and caps tall drawings at 70vh", async () => {
		const id = await publish("Inline HTML and tall SVG", [
			{
				name: "page",
				title: "Page",
				type: "html",
				content: `<!doctype html><html><head><title>Page</title></head><body style="margin:0">${DIAGRAM}</body></html>`,
			},
			{
				name: "tall",
				title: "Tall",
				type: "svg",
				content:
					"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 1000'><rect width='100' height='1000'/></svg>",
			},
		]);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${frame("page")} && ${frame("tall")}`);
		await browser.evaluate(`${frame("page")}.scrollIntoView({ block: "center" })`);
		await browser.wait(`Math.abs(${frame("page")}.getBoundingClientRect().height-${frame("page")}.clientWidth/2)<=2`);
		await fitsFrame(
			`session=${id}&name=page&`,
			`(()=>{const r=document.querySelector('svg').getBoundingClientRect();return {width:r.width,height:r.height,frameWidth:innerWidth,frameHeight:innerHeight}})()`,
			frame("page"),
		);
		// Taller content stops at 70vh.
		const tall = frame("tall");
		await browser.wait(`parseFloat(${tall}.style.height)>=${tall}.clientWidth*10-2`);
		const box = await browser.evaluate<number>(`${tall}.getBoundingClientRect().height`);
		assert.ok(Math.abs(box - 844 * 0.7) <= 1, `capped at 70vh, got ${box}`);
	});

	it("says when the call's version is unavailable", async () => {
		const id = await publish("Inline gone", [
			{ name: "gone", title: "Gone", type: "svg", content: DIAGRAM },
			{ name: "lost", title: "Lost", type: "markdown", content: "# Lost" },
		]);
		for (const name of ["gone", "lost"])
			rmSync(join(fixture.dataDir, "artifacts", id, name, "1"), { recursive: true, force: true });
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		for (const name of ["gone", "lost"])
			await browser.wait(
				`document.querySelector('.inline-artifact[data-artifact="${name}:1"] .notice.error')?.textContent==='Artifact unavailable'`,
			);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.inline-artifact iframe').length`), 0);
	});

	it("renders inline SVG and HTML for a guest too, without a tap", async () => {
		const id = await publish("Inline for guests", [
			{ name: "flow", title: "Flow", type: "svg", content: DIAGRAM },
			{
				name: "page",
				title: "Page",
				type: "html",
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
			// Both report their content height: their scripts ran in the frame, so they rendered.
			await guest.wait(
				`Math.abs(${frame("flow")}?.getBoundingClientRect().height-${frame("flow")}?.clientWidth/2)<=2`,
			);
			await guest.wait(`${frame("page")}?.getBoundingClientRect().height===240`);
			assert.equal(
				await guest.evaluate<boolean>(
					`[...document.querySelectorAll('.inline-artifact button')].some((button)=>/show/i.test(button.textContent))`,
				),
				false,
			);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
