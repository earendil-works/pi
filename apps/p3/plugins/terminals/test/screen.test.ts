// The Terminals view's `PlainScreen` (screen.tsx) in a real browser, fed no real process: on a phone, text the keyboard
// or an input method inserts goes to the terminal, once, and the screen stays its output; a key typed on a desktop goes
// once; a rotation sends the new size in cells; a screen to watch only is read only. Runs only with the browser tests
// (P3_BROWSER_TESTS=1 with CHROMIUM_BIN).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BROWSER_SKIP, Browser, PHONE } from "../../chrome/test/browser.ts";

/** The page's script: a `PlainScreen` showing "ready", recording what it sends in `typed` and `sizes`. */
const SCRIPT = `
import { createRoot } from "react-dom/client";
import { PlainScreen } from "./plugins/terminals/screen.tsx";
const subscribe = (onBytes) => { onBytes(new TextEncoder().encode("ready")); return () => {}; };
window.typed = [];
window.sizes = [];
const watch = new URLSearchParams(location.hash.slice(1)).has("watch");
createRoot(document.querySelector("main")).render(
	watch
		? <PlainScreen label="screen" subscribe={subscribe} />
		: <PlainScreen label="screen" subscribe={subscribe} onInput={(data) => window.typed.push(data)}
			onResize={(columns, rows) => window.sizes.push([columns, rows])} />,
);
`;

/** The page: the screen filling the viewport. */
const PAGE =
	'<meta name="viewport" content="width=device-width"><style>textarea{width:90vw;height:90vh;font:14px monospace}</style><main></main>';

describe("the plain terminal screen", { skip: BROWSER_SKIP }, () => {
	let browser: Browser;
	let script: string;

	before(async () => {
		const bundled = await build({
			stdin: { contents: SCRIPT, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "tsx" },
			bundle: true,
			// Never written (`write: false`); esbuild wants a name for the CSS it drops.
			outfile: "screen.js",
			write: false,
			jsx: "automatic",
			loader: { ".css": "empty" },
			define: { "process.env.NODE_ENV": '"production"' },
		});
		script = bundled.outputFiles[0]!.text;
		browser = await Browser.start();
	});

	after(() => browser.close());

	/** Opens the screen at `viewport` (`watch`: with no input). */
	async function opened(viewport: typeof PHONE, watch = false) {
		await browser.size(viewport);
		await browser.open(`data:text/html,${encodeURIComponent(PAGE)}${watch ? "#watch" : ""}`);
		await browser.evaluate(script);
		await browser.wait('document.querySelector("textarea")?.value === "ready"');
	}

	// Astra, round 5: a phone's keyboard inserts text with no key press, and the screen was read only.
	it("sends inserted text on a phone, keeps its output, and sends the new size on a rotation", async () => {
		await opened(PHONE);
		await browser.click("textarea");
		await browser.wait("window.sizes.length > 0");
		const [columns] = (await browser.evaluate("window.sizes.at(-1)")) as [number, number];
		await browser.enter();
		await browser.call("Input.insertText", { text: "ä" });
		await browser.size({ width: PHONE.height, height: PHONE.width, phone: true });
		await browser.wait(`window.sizes.at(-1)[0] > ${columns}`);
		const seen = (await browser.evaluate(
			'({ typed: window.typed, value: document.querySelector("textarea").value })',
		)) as { typed: string[]; value: string };
		assert.deepEqual(seen, { typed: ["\r", "ä"], value: "ready" });
	});

	it("sends a key typed on a desktop once", async () => {
		await opened({ width: 1280, height: 900, phone: false });
		await browser.click("textarea");
		const key = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" };
		await browser.call("Input.dispatchKeyEvent", { type: "keyDown", ...key });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
		assert.deepEqual(await browser.evaluate("window.typed"), ["a"]);
		assert.equal(await browser.evaluate('document.querySelector("textarea").value'), "ready");
	});

	it("is read only with nothing to send to", async () => {
		await opened(PHONE, true);
		assert.equal(await browser.evaluate('document.querySelector("textarea").readOnly'), true);
	});
});
