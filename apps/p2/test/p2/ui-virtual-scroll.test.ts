// The transcript is a virtual list (src/web/use-chat-scroll.ts): a long conversation with images renders only the
// rows near the viewport, and dragging through it moves the content exactly with the finger. Rows rendered for the
// first time, older pages arriving and images never move what the reader looks at, while the finger is down and when
// the scroll settles.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions, SessionTransfer } from "../../plugins/sessions/contract.ts";
import { bigSessionEntries } from "../fixtures/big-session.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

/** A solid-color PNG, as base64. */
function png(width: number, height: number, shade: number): string {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, shade)]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

/** The big session, every third input with images of different shapes. */
function entriesWithImages(): EntryDraft[] {
	const shapes = [
		[800, 600],
		[300, 900],
		[1600, 400],
	] as const;
	let input = 0;
	return bigSessionEntries(360, 3_000).map((entry) => {
		const message = entry.model?.[0];
		if (entry.kind !== "p2.input" || message?.role !== "user" || input++ % 3 !== 0) return entry;
		const [width, height] = shapes[input % shapes.length] ?? [800, 600];
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return {
			...entry,
			model: [
				{
					...message,
					content: [...content, { type: "image", mimeType: "image/png", data: png(width, height, 40 + input) }],
				},
			],
		} as EntryDraft;
	});
}

/** The first row whose top is in the viewport: its key and screen position. */
const VISIBLE_ROW = `(() => {
	const scroller = document.querySelector('.scroller');
	const top = scroller.getBoundingClientRect().top;
	const row = [...document.querySelectorAll('.row')].find((element) => element.getBoundingClientRect().top >= top + 40);
	return row ? { key: row.dataset.row, top: row.getBoundingClientRect().top } : null;
})()`;
const rowTop = (key: string) =>
	`document.querySelector('.row[data-row="${key}"]')?.getBoundingClientRect().top ?? null`;
const AT_TOP = "document.querySelector('.scroller').scrollTop < 2";
/** Whether the transcript is at its end. */
const AT_END =
	"((s) => Boolean(s) && s.scrollHeight - s.clientHeight - s.scrollTop < 2)(document.querySelector('.scroller'))";
/** Resolves once the transcript's scroll position stayed the same for five frames. */
const STILL = `(async () => {
	const scroller = document.querySelector('.scroller');
	let previous = scroller.scrollTop, still = 0;
	for (let frame = 0; frame < 300 && still < 5; frame++) {
		await new Promise(requestAnimationFrame);
		still = scroller.scrollTop === previous ? still + 1 : 0;
		previous = scroller.scrollTop;
	}
})()`;
/**
 * A height near `y` (searching down, then up, in 10px steps) where a touch at `x` lands on the transcript but clear of
 * a turn's activity wheel, which takes vertical drags itself (Elanor's Ticker; in Chromium a touch a few pixels
 * beside it does not scroll either), and of buttons (scroll down).
 */
const besideActivity = (x: number, y: number) =>
	`(() => { const clear = (at) => [-16, 0, 16].every((d) => !document.elementFromPoint(${x}, at + d)?.closest('.el-ticker')); for (let d = 0; d < 300; d += 10) for (const at of [${y} + d, ${y} - d]) { const e = document.elementFromPoint(${x}, at); if (e?.closest('.scroller') && !e.closest('button') && clear(at)) return at; } return ${y}; })()`;
const frames = (count: number) =>
	`new Promise((resolve) => { let n = ${count}; const step = () => (--n <= 0 ? resolve(true) : requestAnimationFrame(step)); requestAnimationFrame(step); })`;

describe("virtual transcript", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		if (sessions.variant !== "owner") throw new Error("owner expected");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Images" }, BACKGROUND_CONTEXT)).id;
		const entries = entriesWithImages();
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(SessionTransfer, { session })).seed({ entries }, ctx),
			BACKGROUND_CONTEXT,
		);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			// Page errors by phase, including the browser's "ResizeObserver loop" reports.
			source: `window.__errors = []; addEventListener('error', (e) => window.__errors.push((window.__phase ?? 'load') + ': ' + String(e.message) + ' ' + (e.error?.stack ?? ''))); addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason?.stack ?? e.reason)));`,
		});
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("keeps a fast wheel scroll going into each older page until the conversation's start", async () => {
		// Older pages load ahead of the reader, and one arriving mid-scroll never stops it at the top edge: without
		// either, a scroll that never pauses stays at the first page's top.
		await browser.metrics(1200, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Fixed module')`);
		await browser.wait(AT_END);
		const start = `document.querySelector('.history-edge')?.textContent === 'Start of conversation'`;
		let reached = false;
		for (let step = 0; step < 600 && !reached; step++) {
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: 600,
				y: 400,
				deltaX: 0,
				deltaY: -1500,
			});
			reached = await browser.evaluate<boolean>(`${start} && ${AT_TOP}`);
		}
		assert.ok(reached, "the wheel reached the conversation's start without pausing");
		assert.ok(
			await browser.evaluate<boolean>(
				`document.querySelector('.messages').textContent.includes('module 1 and fix')`,
			),
		);
	});

	it("renders only the rows near the viewport and moves the content exactly with a dragging finger", async () => {
		await browser.call("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: true,
		});
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Fixed module')`);
		await browser.wait(AT_END);
		const rendered = await browser.evaluate<number>(`document.querySelectorAll('.row').length`);
		assert.ok(rendered > 2 && rendered < 40, `rendered rows: ${rendered}`);

		const x = 200;
		const STEP = 50;
		let largest = 0;
		let settleShift = 0;
		let reachedTop = false;
		for (let drag = 0; drag < 400 && !reachedTop; drag++) {
			await browser.evaluate(`window.__phase = 'drag ${drag}'`);
			// Any momentum of the last drag ends first: a touch landing on a fling stops it, which reads as a move.
			await browser.evaluate(STILL);
			const y = await browser.evaluate<number>(besideActivity(x, 100));
			await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			// The first move takes the touch slop; from then on the content follows the finger.
			await browser.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + STEP }] });
			await browser.evaluate(frames(2));
			for (let step = 2; step <= 14; step++) {
				const tracked = await browser.evaluate<{ key: string; top: number } | null>(VISIBLE_ROW);
				const scrollTop = await browser.evaluate<number>(`document.querySelector('.scroller').scrollTop`);
				await browser.call("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: y + step * STEP }],
				});
				await browser.evaluate(frames(2));
				const now = await browser.evaluate<number>(`document.querySelector('.scroller').scrollTop`);
				// At the top the scroll position stops, and the content with it.
				if (!tracked || now === scrollTop || (await browser.evaluate<boolean>(AT_TOP))) continue;
				const top = await browser.evaluate<number | null>(rowTop(tracked.key));
				if (top === null) continue;
				const error = Math.abs(top - tracked.top - STEP);
				largest = Math.max(largest, error);
				if (error >= 1.5) {
					// What the transcript looked like, for the failure message.
					const state = await browser.evaluate<string>(
						`JSON.stringify({ before: ${scrollTop}, now: document.querySelector('.scroller').scrollTop, transform: document.querySelector('.rows').style.transform, rows: document.querySelector('.rows').dataset.rows })`,
					);
					assert.fail(`drag ${drag}: row ${tracked.key} moved ${top - tracked.top}px for ${STEP}px ${state}`);
				}
			}
			// Lift without a fling, then let the scroll settle: a held correction is written without a visible move.
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 120))");
			const tracked = await browser.evaluate<{ key: string; top: number } | null>(VISIBLE_ROW);
			await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 400))");
			if (tracked) {
				const top = await browser.evaluate<number | null>(rowTop(tracked.key));
				if (top !== null) settleShift = Math.max(settleShift, Math.abs(top - tracked.top));
			}
			reachedTop = await browser.evaluate<boolean>(`${AT_TOP} && !document.querySelector('.earlier')`);
		}
		assert.ok(reachedTop, "dragged up to the conversation's start");
		assert.ok(settleShift < 1.5, `settling moved the content by ${settleShift}px`);
		assert.ok(
			await browser.evaluate<boolean>(
				`document.querySelector('.messages').textContent.includes('module 1 and fix')`,
			),
		);
		// Still only the rows near the viewport, with images that reserved their box.
		const after = await browser.evaluate<number>(`document.querySelectorAll('.row').length`);
		assert.ok(after < 40, `rendered rows at the top: ${after}`);
		assert.ok(largest < 1.5);
		// Opening the page reports "ResizeObserver loop" notices without the virtual list too; scrolling reports none.
		assert.deepEqual(
			await browser.evaluate<string[]>("window.__errors.filter((error) => !error.startsWith('load:'))"),
			[],
			"no page errors while scrolling",
		);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
	});

	it("flings up and back down to the bottom without a held offset or blank space", async () => {
		// The browser keeps the reader's place for rows measured and pages loaded above them (scroll anchoring), so no
		// correction is held while flinging, and the bottom has no space to snap away when the scroll settles.
		await browser.call("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: true,
		});
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Fixed module')`);
		await browser.wait(AT_END);
		await browser.evaluate(`(() => {
			window.__frames = { held: 0, blank: 0 };
			const tick = () => {
				const scroller = document.querySelector('.scroller');
				const rect = scroller.getBoundingClientRect();
				const dock = document.querySelector('.dock').getBoundingClientRect().top;
				if (document.querySelector('.rows').style.transform) window.__frames.held++;
				for (const y of [rect.top + 40, dock - 30])
					if (document.elementFromPoint(rect.left + 30, y)?.closest('.row-space')) window.__frames.blank++;
				requestAnimationFrame(tick);
			};
			tick();
		})()`);
		const fling = async (dy: number) => {
			const from = await browser.evaluate<number>(besideActivity(200, dy > 0 ? 200 : 650));
			await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: from }] });
			for (let step = 1; step <= 8; step++) {
				await browser.call("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: 200, y: from + (dy * step) / 8 }],
				});
				await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 8))");
			}
			await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
		};
		// Up past 2000px from the end: a turn is short (its tool calls one activity row), so it may take more flings
		// than the five it took with a card per call.
		const fromEnd = `((s) => s.scrollHeight - s.clientHeight - s.scrollTop)(document.querySelector('.scroller'))`;
		for (let index = 0; index < 15 && (index < 5 || (await browser.evaluate<number>(fromEnd)) <= 2000); index++)
			await fling(400);
		const up = await browser.evaluate<number>(fromEnd);
		assert.ok(up > 2000, `flung up ${up}px from the end`);
		for (let index = 0; index < 30; index++) {
			if (await browser.evaluate<boolean>(AT_END)) break;
			await fling(-400);
		}
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 500))");
		assert.ok(await browser.evaluate<boolean>(AT_END), "at the bottom");
		assert.deepEqual(await browser.evaluate("window.__frames"), { held: 0, blank: 0 });
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
	});

	it("scrolls down to the end with the scroll-down button and follows from there", async () => {
		await browser.evaluate(
			`((s) => { s.scrollTop = s.scrollHeight - s.clientHeight - 3000; })(document.querySelector('.scroller'))`,
		);
		await browser.wait(`Boolean(document.querySelector('button[aria-label="Scroll to bottom"]'))`);
		await browser.evaluate(`document.querySelector('button[aria-label="Scroll to bottom"]').click()`);
		await browser.wait(`${AT_END} && !document.querySelector('button[aria-label="Scroll to bottom"]')`);
		assert.ok(
			await browser.evaluate<boolean>(
				`document.querySelector('.rows').lastElementChild.previousElementSibling.textContent.includes('Fixed module')`,
			),
		);
	});
});

describe("virtual transcript feedback", { skip: !browserTests }, () => {
	it("settles when rendering a row at the range's start moves the scroll position", async () => {
		// Rendering a row at the start moves the content down a few pixels and dropping it moves it back
		// (`edge-row.ts`, as scroll anchoring did for a row of a real transcript). Where the range's start lies within
		// that distance of a row, each render would flip it: the list must settle instead of rendering every frame.
		const fixture = await startFixture({ web: true });
		const browser = await Browser.start();
		await browser.signIn(fixture.owner);
		try {
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("edge-row.ts");
			await browser.wait("typeof window.showEdgeRows==='function'");
			await browser.evaluate("window.showEdgeRows()");
			await browser.wait(`document.querySelectorAll('.row').length > 0 && ${AT_END}`);
			const result = await browser.evaluate<{ positions: number; looping: number[] }>(`(async () => {
				const scroller = document.querySelector('.scroller');
				const frame = () => new Promise(requestAnimationFrame);
				let changes = 0;
				new MutationObserver(() => changes++).observe(document.querySelector('.rows'), { childList: true });
				const looping = [];
				let positions = 0;
				// Every position of a stretch of the transcript, a pixel apart, each left to settle.
				const from = scroller.scrollTop - 1500;
				for (let top = from; top < from + 100; top++, positions++) {
					scroller.scrollTop = top;
					for (let settle = 0; settle < 4; settle++) await frame();
					changes = 0;
					for (let idle = 0; idle < 10; idle++) await frame();
					if (changes > 2) looping.push(top);
				}
				return { positions, looping };
			})()`);
			assert.deepEqual(result.looping, [], `still rendering after settling, at ${result.positions} positions`);
		} finally {
			await browser.close();
			await fixture.close();
		}
	});
});
