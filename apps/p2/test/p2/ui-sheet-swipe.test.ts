// Phones: a bottom sheet follows a downward drag and closes on release past a threshold or on a fling; a short pull
// settles back. From its top edge (grip and header) always; from its content when the content is at its top, else the
// drag scrolls it first and the same finger pulls the sheet once it reached its top (src/web/sheet-swipe.ts).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

const point = (selector: string) =>
	`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 12) }; })()`;
const open = `Boolean(document.querySelector('[role=dialog][aria-label="Model"]'))`;

describe("swiping a bottom sheet down", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	/** A touch drag from `from` down by `distance` px in `steps` moves `pause` ms apart. */
	const drag = async (from: { x: number; y: number }, distance: number, steps: number, pause: number) => {
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
		for (let step = 1; step <= steps; step++) {
			await browser.call("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: from.x, y: from.y + (distance * step) / steps }],
			});
			await browser.evaluate(`new Promise((resolve) => setTimeout(resolve, ${pause}))`);
		}
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	};

	it("closes from its top edge or its content at the top, and settles back after a short pull", async () => {
		const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Sheets",
			},
			BACKGROUND_CONTEXT,
		);
		await browser.call("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: true,
		});
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		// The chip is disabled until the model resources arrive; a click before that does nothing.
		await browser.wait(`document.querySelector('button[aria-label="Model and thinking"]')?.disabled === false`);
		const openSheet = async () => {
			await browser.evaluate(`document.querySelector('button[aria-label="Model and thinking"]').click()`);
			await browser.wait(open);
			// The opening slide is over.
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 400))");
		};
		await openSheet();

		// Content that scrolls: taller than the sheet, scrolled down a little.
		const tall = `(() => { const body = document.querySelector('.sheet-body'); const filler = document.createElement('div'); filler.style.height = '2000px'; body.append(filler); body.scrollTop = 150; return true; })()`;
		await browser.evaluate(tall);
		// A drag up in the content scrolls it: the sheet stays.
		const content = await browser.evaluate<{ x: number; y: number }>(point(".sheet-body"));
		const below = { x: content.x, y: content.y + 300 };
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [below] });
		for (let step = 1; step <= 10; step++) {
			await browser.call("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: below.x, y: below.y - step * 20 }],
			});
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 16))");
		}
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 500))");
		assert.ok(await browser.evaluate<boolean>(open), "a drag up in the content keeps the sheet");
		assert.ok((await browser.evaluate<number>("document.querySelector('.sheet-body').scrollTop")) > 150);
		// A drag down in scrolled content scrolls it back to its top, and the same finger then pulls the sheet away.
		await browser.evaluate("document.querySelector('.sheet-body').scrollTop = 150");
		await drag(content, 650, 26, 16);
		await browser.wait(`!${open}`);
		// Opened again, its content at the top: a drag down in it closes it at once.
		await openSheet();
		await drag(await browser.evaluate(point(".sheet-body")), 400, 10, 16);
		await browser.wait(`!${open}`);
		await openSheet();

		// A short, slow pull on the header follows the finger and settles back.
		const header = await browser.evaluate<{ x: number; y: number }>(point(".sheet-head h2"));
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [header] });
		for (let step = 1; step <= 6; step++) {
			await browser.call("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: header.x, y: header.y + step * 10 }],
			});
			await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 40))");
		}
		const moved = await browser.evaluate<string>(`document.querySelector('.sheet').style.transform`);
		assert.match(moved, /translateY\((4\d|5\d)(\.\d+)?px\)/, "the sheet follows the finger");
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 150))");
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 500))");
		assert.ok(await browser.evaluate<boolean>(open), "a short pull keeps the sheet");
		assert.equal(await browser.evaluate<string>(`document.querySelector('.sheet').style.transform`), "");

		// A pull past the threshold on the grip closes it.
		await drag(await browser.evaluate(point(".sheet-grip")), 400, 10, 16);
		await browser.wait(`!${open}`);
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.sheet-layer'))`), false);

		// Wide screens show a dialog: no grip.
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 900);
		await openSheet();
		assert.equal(
			await browser.evaluate<string>(`getComputedStyle(document.querySelector('.sheet-grip')).display`),
			"none",
		);
	});
});
