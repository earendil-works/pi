// The canvas's board view in Chromium (guide 8.10; `kindE2E`: p3's real server on a copy of the built-in plugins, a
// browser signed in per person; runs with P3_BROWSER_TESTS=1 and CHROMIUM_BIN, as the chrome plugin's page test): a
// drawer draws with the pen, the box and text, undoes their own last shape and clears; a viewer (Draw withheld) sees
// the drawer's shapes and named pointer live, and the pointer go when the drawer's mouse leaves, on a desktop and a
// phone; Moderate without Draw shows Clear alone, live as the ticks change; a touch the browser cancels is dropped and
// one that ends is drawn, a stroke as text, on a phone; what a drawer picked (the tool, a text not placed yet) survives an apply of the
// web facet, and does not follow them to another board; a refusal is said as its message (a full board, whose 20
// pages are all loaded). Screenshots, light and dark, go to `/tmp/p3-base/shots/` (`P3_SHOTS` names another).

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "../../chrome/test/browser.ts";
import { SignIns } from "../../sign-in/contract.ts";
import { Me, OPEN, type Party } from "../../things/contract.ts";
import { type KindE2E, kindE2E } from "../../things/test/kind-e2e.ts";
import { Canvas, CanvasKind, MAX_SHAPES, type Shape } from "../kind.ts";

/** Where the screenshots go. */
const SHOTS = process.env.P3_SHOTS ?? "/tmp/p3-base/shots";

/** The canvas plugin's name. */
const PLUGIN = "@earendil-works/p3-canvas";

/** A small box. */
const BOX: Shape = { kind: "rect", color: "#0969da", x: 10, y: 10, w: 20, h: 20, fill: false };

describe("the board view", { skip: BROWSER_SKIP }, () => {
	let e: KindE2E;
	let origin: string;
	/** The owner's browser: every tick on every board. */
	let owner: Browser;
	/** The owner's name, as the things store has it. */
	let ownerName: string;

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		e = await kindE2E(context);
		origin = `http://127.0.0.1:${e.t.port}`;
		owner = await Browser.start();
		await owner.size(DESKTOP);
		await owner.signIn(origin, await e.t.cookie(context));
	});

	after(async () => {
		await owner?.close();
		await e?.close();
	});

	/** Opens board `thing` in `browser` and waits for its view as `mode` (`drawer`, `viewer`, `moderator`). */
	async function open(browser: Browser, thing: string, mode: string): Promise<void> {
		await browser.open(`${origin}/w/${e.pi}/t/${thing}`);
		await browser.wait(
			`location.pathname.endsWith(${JSON.stringify(`/t/${thing}`)}) && document.querySelector('[data-canvas="${mode}"] [data-canvas-surface]')?.getBoundingClientRect().width > 0`,
		);
	}

	/** A browser signed in as `principal`, at the desktop's size. */
	async function signedIn(principal: P3Principal): Promise<Browser> {
		const signIns = await e.t.host.get(SignIns, {}, context);
		const { cookie } = await signIns.issue({ principal, kind: "browser", label: "test" }, context);
		const browser = await Browser.start();
		await browser.size(DESKTOP);
		await browser.signIn(origin, cookie.split(";")[0]!);
		return browser;
	}

	/** Drags across the board in `browser` from (`x1`, `y1`) to (`x2`, `y2`), as shares of its size. */
	async function stroke(browser: Browser, x1: number, y1: number, x2: number, y2: number): Promise<void> {
		const box = await browser.box("[data-canvas-surface]");
		await browser.call("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: box.x + box.width * x1,
			y: box.y + box.height * y1,
		});
		await browser.drag("[data-canvas-surface]", box.x + box.width * x2, box.y + box.height * y2);
	}

	/** Waits until `browser` shows `count` committed shapes. */
	const shapes = (browser: Browser, count: number) =>
		browser.wait(`document.querySelectorAll("[data-shape]").length === ${count}`);

	/** Screenshots `browser` as `name` in light and dark. */
	async function shots(browser: Browser, name: string): Promise<void> {
		await browser.screenshot(join(SHOTS, `${name}.png`));
		await browser.colorScheme("dark");
		await browser.screenshot(join(SHOTS, `${name}-dark.png`));
		await browser.colorScheme("light");
	}

	/** The rows board `thing` has, read by the owner's client. */
	async function rows(thing: string): Promise<number> {
		const board = await (await e.t.client(context)).get(Canvas, { workspace: e.pi, thing }, context);
		return (await board.page({}, context)).rows.length;
	}

	it("lets a drawer draw with the pen, the box and text, undo their own last shape and clear", async () => {
		const me = await until((await (await e.t.client(context)).get(Me, {}, context)).me, () => true, context);
		ownerName = me.kind === "person" ? me.name : "";
		const board = await e.thingIn(CanvasKind.name, "Drawing");
		await open(owner, board, "drawer");
		await stroke(owner, 0.2, 0.2, 0.5, 0.4);
		await shapes(owner, 1);
		await owner.click('[data-tool="rect"]');
		await stroke(owner, 0.6, 0.5, 0.8, 0.8);
		await shapes(owner, 2);
		await owner.wait(`document.querySelector("rect[data-shape]") !== null`);
		await owner.click('[data-tool="text"]');
		await owner.type("[data-canvas-text]", "hello");
		await owner.click("[data-canvas-surface]");
		await shapes(owner, 3);
		await owner.wait(`document.querySelector("text[data-shape]")?.textContent === "hello"`);
		await shots(owner, "11-canvas-drawer-desktop");
		await owner.click("[data-canvas-undo]");
		await shapes(owner, 2);
		await owner.click("[data-canvas-clear]");
		await shapes(owner, 0);
		assert.equal(await rows(board), 0);
	});

	it("shows a viewer the drawer's shapes and named pointer live, and the pointer go; desktop and phone", async () => {
		const board = await e.thingIn(CanvasKind.name, "Shown");
		const dee = await e.person("Dee");
		const party: Party = { kind: "person", person: dee.id };
		// Draw withheld from Dee (everyone's Draw does not reach her, item 106); `@open` lets her look.
		await e.ticks(board, party, ["draw"], false);
		await e.ticks(board, party, [OPEN], true);
		const viewer = await signedIn(dee);
		try {
			await open(owner, board, "drawer");
			await open(viewer, board, "viewer");
			assert.equal(await viewer.evaluate<boolean>(`!!document.querySelector("[data-canvas-tools]")`), false);
			await stroke(owner, 0.2, 0.7, 0.4, 0.5);
			await shapes(viewer, 1);
			// The owner's mouse over the board: Dee sees the pointer with the owner's name, not a fallback.
			const box = await owner.box("[data-canvas-surface]");
			for (const step of [0.45, 0.5]) {
				const point = { x: box.x + box.width * step, y: box.y + box.height / 2 };
				await owner.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			}
			await viewer.wait(`document.querySelector("[data-cursor]")?.textContent === ${JSON.stringify(ownerName)}`);
			await shots(viewer, "11-canvas-viewer-desktop");
			// The mouse leaves the board: its pointer goes from Dee's.
			await owner.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.width / 2, y: 2 });
			await viewer.wait(`document.querySelector("[data-cursor]") === null`);
			await viewer.size(PHONE);
			await viewer.wait(`document.querySelector('[data-canvas="viewer"]')?.offsetParent !== null`);
			await shots(viewer, "11-canvas-viewer-phone");
			await owner.size(PHONE);
			await owner.wait(`document.querySelector('[data-canvas="drawer"]')?.offsetParent !== null`);
			await shots(owner, "11-canvas-drawer-phone");
		} finally {
			await owner.size(DESKTOP);
			await viewer.close();
		}
	});

	it("shows Clear alone to a moderator without Draw, live as the ticks change (Astra, round 2)", async () => {
		const board = await e.thingIn(CanvasKind.name, "Moderated");
		const cy = await e.person("Cy");
		const party: Party = { kind: "person", person: cy.id };
		await (await e.client(cy))
			.get(Canvas, { workspace: e.pi, thing: board }, context)
			.then((canvas) => canvas.add!({ shapes: [BOX] }, context));
		await e.ticks(board, party, [OPEN, "moderate"], true);
		await e.ticks(board, party, ["draw"], false);
		const moderator = await signedIn(cy);
		try {
			await open(moderator, board, "moderator");
			await moderator.wait(`document.querySelector("[data-canvas-clear]") !== null`);
			assert.equal(
				await moderator.evaluate<boolean>(
					`!!document.querySelector("[data-tool], [data-canvas-undo]") || document.querySelector("[data-canvas-name]").textContent.includes("View only")`,
				),
				false,
			);
			// Moderate taken back: a viewer, on the same page.
			await e.ticks(board, party, ["moderate"], false);
			await moderator.wait(
				`document.querySelector('[data-canvas="viewer"]') && !document.querySelector("[data-canvas-tools]")`,
			);
			// Draw given back: a drawer without Clear.
			await e.ticks(board, party, ["draw"], true);
			await moderator.wait(
				`document.querySelector('[data-canvas="drawer"] [data-tool]') && !document.querySelector("[data-canvas-clear]")`,
			);
			// Moderate again: Clear works.
			await e.ticks(board, party, ["moderate"], true);
			await moderator.click("[data-canvas-clear]");
			await shapes(moderator, 0);
			assert.equal(await rows(board), 0);
		} finally {
			await moderator.close();
		}
	});

	it("drops a touch the browser cancels and draws one that ends, a stroke or text, on a phone (Astra, round 2)", async () => {
		const board = await e.thingIn(CanvasKind.name, "Touched");
		await owner.size(PHONE);
		try {
			await open(owner, board, "drawer");
			const box = await owner.box("[data-canvas-surface]");
			const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			const touch = (type: string, points: readonly object[]) =>
				owner.call("Input.dispatchTouchEvent", { type, touchPoints: points });
			await touch("touchStart", [at]);
			await owner.wait(`document.querySelector('[data-draft="me"]') !== null`);
			await touch("touchMove", [{ x: at.x + 30, y: at.y + 15 }]);
			await touch("touchCancel", []);
			await owner.wait(`document.querySelector('[data-draft="me"]') === null`);
			assert.equal(await rows(board), 0);
			await owner.swipe(at.x, at.y, at.x + 40, at.y + 20);
			await shapes(owner, 1);
			assert.equal(await rows(board), 1);
			// A text's tap cancelled places nothing; one that ends places it (Astra, round 2, second look).
			await owner.click('[data-tool="text"]');
			await owner.type("[data-canvas-text]", "tapped");
			await touch("touchStart", [at]);
			await touch("touchCancel", []);
			await touch("touchStart", [{ x: at.x, y: at.y + 40 }]);
			await touch("touchEnd", []);
			await owner.wait(`document.querySelector("text[data-shape]")?.textContent === "tapped"`);
			assert.equal(await rows(board), 2);
		} finally {
			await owner.size(DESKTOP);
		}
	});

	it("keeps what a drawer picked across an apply of the web facet, for that board only (Astra, round 2)", async () => {
		const [first, second] = [await e.thingIn(CanvasKind.name, "First"), await e.thingIn(CanvasKind.name, "Second")];
		await open(owner, first, "drawer");
		await owner.click('[data-tool="text"]');
		await owner.type("[data-canvas-text]", "keep this label");
		await owner.evaluate(`window.sameDocument = true; document.querySelector("[data-canvas]").mounted = true`);
		const applied = await e.reload("canvas", PLUGIN, "web.tsx");
		assert.equal(applied.stopped, undefined);
		// The view mounted anew (the facet's new code), in the same document.
		await owner.wait(`document.querySelector("[data-canvas]")?.mounted === undefined`);
		assert.equal(await owner.evaluate<boolean>("window.sameDocument === true"), true);
		await owner.wait(`document.querySelector("[data-canvas-text]")?.value === "keep this label"`);
		// Another board starts with nothing picked and no one else's pointer.
		await (await e.client({ kind: "person", id: (await e.person("Eve")).id, name: "Eve" }))
			.get(Canvas, { workspace: e.pi, thing: first }, context)
			.then((canvas) => canvas.point({ x: 100, y: 100, draft: null }, context));
		await open(owner, second, "drawer");
		assert.deepEqual(
			await owner.evaluate<unknown>(
				`({ text: !!document.querySelector("[data-canvas-text]"), cursor: !!document.querySelector("[data-cursor]") })`,
			),
			{ text: false, cursor: false },
		);
	});

	it("says a refusal as its message: a full board, every one of its pages loaded", async () => {
		const board = await e.thingIn(CanvasKind.name, "Full");
		const canvas = await (await e.t.client(context)).get(Canvas, { workspace: e.pi, thing: board }, context);
		for (let i = 0; i < MAX_SHAPES / 100; i++) await canvas.add!({ shapes: Array(100).fill(BOX) }, context);
		await open(owner, board, "drawer");
		await shapes(owner, MAX_SHAPES);
		await stroke(owner, 0.3, 0.3, 0.6, 0.6);
		await owner.wait(
			`document.querySelector("[data-canvas-error]")?.textContent === ("This canvas is full: it holds ${MAX_SHAPES} shapes at most.")`,
		);
		await shapes(owner, MAX_SHAPES);
	});
});
