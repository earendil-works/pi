// The canvas in real browsers (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server: the
// owner on a desktop and Ada, an invited person who writes, on a phone open the same canvas ("Ideas") as a pane.
// Each sees the other's pointer with their name and the stroke they are drawing while they draw it (events), then the
// committed stroke (a row); Ada draws with her finger, the owner with the mouse, a rectangle and text too; undo takes
// back one's own last shape; with "May draw" off for Ada (the kind's options form) she sees the board read only, at
// once. Screenshots go to `/tmp/p3-base/shots/canvas-*.png` (`P3_SHOTS` names another directory).

import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	Me,
	type P3Principal,
	People,
	Sessions,
	thingOf,
} from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "../../chrome/test/browser.ts";
import { CanvasKind } from "../contract.ts";

/** Where the screenshots go. */
const SHOTS = process.env.P3_SHOTS ?? "/tmp/p3-base/shots";

describe("the canvas in two browsers", { skip: BROWSER_SKIP }, () => {
	let t: TestServer;
	/** The owner's author key and name (their person's). */
	let ownerKey = "";
	let ownerName = "";
	let owner: Host<P3Principal>;
	let mine: Browser;
	let hers: Browser;
	let origin: string;
	let session: string;
	let ada: string;

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		t = await testServer({ dataDir: await mkdtemp(join(tmpdir(), "p3-canvas-page-")) }, context);
		owner = await t.client(context);
		const me = (await owner.get(Me, {}, context)).me.value;
		if (me.kind !== "person") throw new Error("the owner's client is no person");
		ownerKey = `person:${me.id}`;
		ownerName = me.name;
		origin = `http://127.0.0.1:${t.port}`;
		const invited = await (await owner.get(People, {}, context)).invite({ name: "Ada" }, context);
		ada = invited.person;
		session = await (await owner.get(Sessions, {}, context)).create(
			{
				app: "coding",
				title: "Sketches",
				location: { environment: "this-device", folder: t.dataDir },
				members: [{ kind: "person", id: ada, access: "write" }],
				things: [thingOf(CanvasKind, { name: "Ideas" })],
			},
			context,
		);
		mine = await Browser.start();
		await mine.signIn(origin, await t.cookie(context));
		await mine.size(DESKTOP);
		hers = await Browser.start();
		await hers.size(PHONE);
		await hers.open(`${origin}${invited.link}`);
		await hers.wait(`location.pathname === "/coding"`);
	});

	after(async () => {
		await mine?.close();
		await hers?.close();
		await t?.close(context);
	});

	/** Opens the session's board in `browser` from its dialog, as a pane, as `variant`. */
	async function openBoard(browser: Browser, variant: string): Promise<void> {
		await browser.open(`${origin}/coding/${session}`);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.click('[data-thing="canvas.board"] [data-open-thing]');
		// The dialog's backdrop fades out over the pane: drawing waits until it is gone.
		await browser.wait(
			`document.querySelector("[data-things-dialog]") === null && document.querySelector("[data-ending-style]") === null`,
		);
		await browser.wait(`document.querySelector('[data-canvas="${variant}"]')`);
		await browser.evaluate(`document.querySelector("[data-canvas-surface]").scrollIntoView({ block: "center" })`);
	}

	it("shows each the other's pointer, name and stroke as they draw, then the committed strokes", async () => {
		await openBoard(mine, "drawer");
		await openBoard(hers, "drawer");
		// Each sees the canvas by its name.
		for (const browser of [mine, hers]) {
			await browser.wait(`document.querySelector("[data-canvas-name]")?.textContent.startsWith("Ideas")`);
		}
		// The owner draws with the mouse, and stops before letting go.
		const desk = await surface(mine);
		await mouse(mine, "mouseMoved", desk.at(0.2, 0.3), 0);
		await mouse(mine, "mousePressed", desk.at(0.2, 0.3), 1);
		for (let step = 1; step <= 10; step++) {
			await mouse(mine, "mouseMoved", desk.at(0.2 + step * 0.04, 0.3 + Math.sin(step / 2) * 0.1), 1);
		}
		// Ada sees the owner's pointer with their name, and the stroke so far.
		await hers.wait(`document.querySelector('[data-cursor="${ownerKey}"]')?.textContent === "${ownerName}"`);
		await hers.wait(
			`document.querySelector('[data-draft="${ownerKey}"]')?.getAttribute("d")?.split(" ").length > 10`,
		);
		await mouse(mine, "mouseReleased", desk.at(0.6, 0.3), 0);
		await hers.wait(`document.querySelector('[data-shape][data-author="${ownerKey}"]')`);
		await hers.wait(`document.querySelector('[data-draft="${ownerKey}"]') === null`);
		// Ada draws with her finger, and stops before lifting it.
		const phone = await surface(hers);
		await touch(hers, "touchStart", phone.at(0.3, 0.6));
		for (let step = 1; step <= 10; step++)
			await touch(hers, "touchMove", phone.at(0.3 + step * 0.04, 0.6 + step * 0.02));
		await mine.wait(`document.querySelector('[data-cursor="person:${ada}"]')?.textContent === "Ada"`);
		await mine.wait(`document.querySelector('[data-draft="person:${ada}"]')`);
		await mine.screenshot(join(SHOTS, "canvas-desktop.png"));
		await hers.screenshot(join(SHOTS, "canvas-phone.png"));
		await touch(hers, "touchEnd", undefined);
		await mine.wait(`document.querySelector('[data-shape][data-author="person:${ada}"]')`);
		// A lifted finger takes her pointer off the board.
		await mine.wait(`document.querySelector('[data-cursor="person:${ada}"]') === null`);
		for (const browser of [mine, hers]) {
			await browser.wait(`document.querySelectorAll("[data-shape]").length === 2`, 5000);
		}
	});

	it("draws a rectangle and text, and undoes one's own last shape only", async () => {
		const desk = await surface(mine);
		await mine.click('[data-tool="rect"]');
		await mouse(mine, "mouseMoved", desk.at(0.55, 0.55), 0);
		await mouse(mine, "mousePressed", desk.at(0.55, 0.55), 1);
		await mouse(mine, "mouseMoved", desk.at(0.7, 0.65), 1);
		await mouse(mine, "mouseMoved", desk.at(0.85, 0.8), 1);
		await mouse(mine, "mouseReleased", desk.at(0.85, 0.8), 0);
		await hers.wait(`document.querySelector('rect[data-author="${ownerKey}"]')`);
		await mine.click('[data-tool="text"]');
		await mine.type("[data-canvas-text]", "Hello, Ada");
		await mine.click('[data-color="#cf222e"]');
		const placed = desk.at(0.1, 0.15);
		await mouse(mine, "mousePressed", placed, 1);
		await mouse(mine, "mouseReleased", placed, 0);
		await hers.wait(`document.querySelector('text[data-author="${ownerKey}"]')?.textContent === "Hello, Ada"`);
		// Undo takes the last of one's own shapes the board shows committed.
		await mine.wait(`document.querySelector('text[data-author="${ownerKey}"]')`);
		await mine.click("[data-canvas-undo]");
		await hers.wait(`document.querySelector('text[data-author="${ownerKey}"]') === null`);
		await hers.wait(`document.querySelector('rect[data-author="${ownerKey}"]')`);
		await hers.wait(`document.querySelector('[data-shape][data-author="person:${ada}"]')`);
		await mine.colorScheme("dark");
		await mine.evaluate(`document.querySelector("[data-canvas-surface]").scrollIntoView({ block: "center" })`);
		await mine.screenshot(join(SHOTS, "canvas-dark.png"));
		await mine.colorScheme("light");
		await hers.colorScheme("dark");
		await hers.screenshot(join(SHOTS, "canvas-phone-dark.png"));
		await hers.colorScheme("light");
	});

	it("leaves Ada the board read only once the owner turns her drawing off in the options form", async () => {
		await mine.click("[data-things-open]");
		await mine.settled("[data-things-dialog]");
		await mine.click("[data-options-open]");
		await mine.wait(`document.querySelector("[data-canvas-options]")`);
		// The form for Ada: her own options, "May draw" off.
		await mine.click('[data-thing-options] [data-field="whose"]');
		await mine.click(`[data-choice="person:${ada}"]`);
		await mine.wait(
			`document.querySelector('[data-thing-options] [data-field="whose"]')?.textContent.includes("Ada")`,
		);
		await mine.click('[data-canvas-options] [data-option="draw"]');
		await mine.click("[data-canvas-options] [data-options-save]");
		await hers.wait(`document.querySelector('[data-canvas="viewer"]')`);
		await hers.wait(`document.querySelector("[data-canvas-tools]") === null`);
		await mine.screenshot(join(SHOTS, "canvas-options-desktop.png"));
		await hers.screenshot(join(SHOTS, "canvas-viewer-phone.png"));
	});

	it("leaves nothing reported on the server, and no error in either page", () => {
		assert.deepEqual(t.errors, []);
		assert.deepEqual(mine.console, []);
		assert.deepEqual(hers.console, []);
	});
});

/** A point on the board as a fraction of its width and height. */
type At = (x: number, y: number) => { readonly x: number; readonly y: number };

/** The board's surface in `browser`'s viewport: `at` gives a point on it in CSS pixels. */
async function surface(browser: Browser): Promise<{ readonly at: At }> {
	const box = await browser.evaluate<{ left: number; top: number; width: number; height: number }>(
		`(() => { const r = document.querySelector("[data-canvas-surface]").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
	);
	return { at: (x, y) => ({ x: box.left + box.width * x, y: box.top + box.height * y }) };
}

/** A mouse event of `type` at `at`, with `buttons` held. */
async function mouse(browser: Browser, type: string, at: { x: number; y: number }, buttons: number): Promise<void> {
	await browser.call("Input.dispatchMouseEvent", { type, ...at, button: "left", buttons, clickCount: 1 });
}

/** A touch event of `type` with one finger at `at` (none: lifted). */
async function touch(browser: Browser, type: string, at: { x: number; y: number } | undefined): Promise<void> {
	await browser.call("Input.dispatchTouchEvent", { type, touchPoints: at === undefined ? [] : [at] });
}
