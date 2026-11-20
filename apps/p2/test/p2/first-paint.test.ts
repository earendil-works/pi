// The first-paint theme scripts, run as served: the app page's (src/hosts/web.ts) and the server pages' (sign-in, join,
// ended share: src/runtime/page.ts). Both apply this origin's stored `pi-theme` unless a host owns the preference
// (src/web/theme.ts): the Radius shell framing the page (the app page also needs the server's shell meta, a plain
// origin) or p2-mac's bridge. A shell frame paints the scheme the shell hinted in its URL (`#pi-shell-scheme=`). A fake
// window stands in for the browser.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { WebSurface } from "@earendil-works/chord/surfaces";
import { createWeb } from "../../src/hosts/web.ts";
import { page } from "../../src/runtime/page.ts";
import type { P2Principal } from "../../src/runtime/principals.ts";

const NONCE = "n0nce";
const SHELL = "https://radius.earendil.com";

/** The app page's HTML for a viewer framed by `shellOrigin` (or none). */
async function appPage(shellOrigin: string | undefined): Promise<string> {
	const surface = {
		pageAssets: async () => ({ bootstrap: "", styles: [], plugins: "/p.js", script: "/s.js" }),
		base: async () => "base",
	} as unknown as WebSurface<P2Principal>;
	const web = createWeb({ nonce: NONCE, surface, root: async () => {}, telemetry: false });
	return new Promise((resolve) => {
		const response = { writeHead: () => {}, end: (body: string) => resolve(body) } as unknown as ServerResponse;
		web.handle({ url: "/", method: "GET" } as IncomingMessage, response, {
			principal: { kind: "owner", access: "local" } as P2Principal,
			shellOrigin,
		});
	});
}

/** The first inline script of `html` (the theme script, before the surface's). */
const themeScript = (html: string): string => /<script nonce="n0nce">([\s\S]*?)<\/script>/.exec(html)![1]!;

type Options = { framed?: boolean; native?: boolean; meta?: string; hash?: string };

/**
 * Runs `script` with `pi-theme` stored dark and a light system, at `/s/x?y=1` plus `hash`: `<html>`'s data and the
 * address after it, with each `replaceState` call.
 */
function run(script: string, options: Options) {
	const html = { dataset: {} as Record<string, string> };
	const window: Record<string, unknown> = {};
	window.parent = options.framed ? {} : window;
	if (options.native) window.webkit = { messageHandlers: { piHost: { postMessage: () => {} } } };
	const location = { pathname: "/s/x", search: "?y=1", hash: options.hash ?? "" };
	const replaced: unknown[][] = [];
	const state = { route: "kept" };
	runInNewContext(script, {
		window,
		URL,
		location,
		history: {
			state,
			replaceState: (...args: unknown[]) => {
				replaced.push(args);
				location.hash = "";
			},
		},
		localStorage: { getItem: (key: string) => (key === "pi-theme" ? "dark" : null) },
		matchMedia: () => ({ matches: false }),
		document: {
			documentElement: html,
			querySelector: (selector: string) =>
				selector === 'meta[name="p2-shell-origin"]' && options.meta !== undefined
					? { content: options.meta }
					: null,
		},
	});
	return { dataset: html.dataset, hash: location.hash, replaced, state };
}

/** `<html data-theme>` after running `script` (see `run`). */
const firstPaint = (script: string, options: Options): string | undefined => run(script, options).dataset.theme;

describe("first paint", () => {
	it("the app page skips its stored theme in the shell's frame or in p2-mac", async () => {
		const plain = themeScript(await appPage(undefined));
		const relayed = themeScript(await appPage(SHELL));
		assert.equal(firstPaint(plain, {}), "dark");
		assert.equal(firstPaint(plain, { framed: true }), "dark");
		assert.equal(firstPaint(relayed, { meta: SHELL }), "dark");
		assert.equal(firstPaint(relayed, { meta: SHELL, framed: true }), "light");
		assert.equal(firstPaint(plain, { native: true }), "light");
		// A meta that is not a plain origin names no shell, as for the shell bridge.
		assert.equal(firstPaint(relayed, { meta: `${SHELL}/pi`, framed: true }), "dark");
		assert.equal(firstPaint(relayed, { meta: "", framed: true }), "dark");
	});

	it("a shell frame paints the scheme the shell hinted in its URL and removes the hint at once", async () => {
		const relayed = themeScript(await appPage(SHELL));
		const frame = { meta: SHELL, framed: true };
		for (const scheme of ["light", "dark"]) {
			const painted = run(relayed, { ...frame, hash: `#pi-shell-scheme=${scheme}` });
			assert.equal(painted.dataset.theme, scheme);
			assert.equal(painted.dataset.colorScheme, scheme);
			// Kept for theme.ts until the shell's hello.
			assert.equal(painted.dataset.piShellScheme, scheme);
			assert.equal(painted.hash, "");
			assert.deepEqual(painted.replaced, [[painted.state, "", "/s/x?y=1"]]);
		}
		// Any other fragment stays, and the system's scheme counts.
		for (const hash of ["#pi-shell-scheme=blue", "#pi-shell-scheme=dark&x", "#other", "#pi-shell-scheme=DARK"]) {
			const painted = run(relayed, { ...frame, hash });
			assert.deepEqual([painted.dataset.theme, painted.hash, painted.replaced], ["light", hash, []], hash);
			assert.equal(painted.dataset.piShellScheme, undefined);
		}
		// Not a shell frame: the hint is ignored and left in place.
		for (const options of [
			{ meta: SHELL },
			{ meta: `${SHELL}/pi`, framed: true },
			{ framed: true },
			{ native: true },
		]) {
			const script = options.meta === undefined ? themeScript(await appPage(undefined)) : relayed;
			const painted = run(script, { ...options, hash: "#pi-shell-scheme=light" });
			assert.deepEqual(
				[painted.hash, painted.replaced, painted.dataset.piShellScheme],
				["#pi-shell-scheme=light", [], undefined],
				JSON.stringify(options),
			);
			// Stored dark where the page owns its theme; the system's light in p2-mac.
			assert.equal(painted.dataset.theme, options.native ? "light" : "dark", JSON.stringify(options));
		}
	});

	it("the server pages skip it in a frame (only the shell may frame them) or in p2-mac", () => {
		const script = themeScript(page({ title: "t", heading: "h", body: "", nonce: NONCE }));
		assert.equal(firstPaint(script, {}), "dark");
		assert.equal(firstPaint(script, { framed: true }), undefined);
		assert.equal(firstPaint(script, { native: true }), undefined);
	});
});
