// Tests of a page's plugin stylesheets (p3 step 0a: `PageStyles`, `styles.ts`) in a real browser (Chromium; skipped
// without one), every frame recorded where it matters: a new stylesheet is fetched inactive before its plugin reloads and
// applied with its new code (a slow one with a renamed class: no frame unstyled), beside its plugin's old one (the
// cascade between plugins kept); a plugin whose new script fails never shows its new stylesheet, not even while another
// plugin's loads; a stylesheet that fails is reported, the new code applied, and loaded again by the next update; one
// past its 10 s that loads later applies; a stalled one ends the wait at 10 s, and at the client's stop, which removes
// what it prepared; a reconnect tries a failed plugin's script again with its stylesheet; and the known limitation for UI
// an object contributes while it restarts. Requests for plugin stylesheets are held back through DevTools.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Browser, CHROMIUM } from "./browser.ts";
import { freePort, signIn, versionedEntry, webApp } from "./support.ts";

/**
 * A web plugin contributing a part `<p id="<id>">` with `text`, of the CSS module's class `css` names first; `throws`
 * makes its script throw unless the page set `globalThis.partReady`.
 */
function partPlugin(id: string, text: string, css: string, throws = false): Record<string, string> {
	const name = /\.([a-z]+)/.exec(css)![1]!;
	return {
		"web.ts": [
			'import { defineFacet } from "@test/app/v1";',
			'import { Parts } from "@test/app/v1/web";',
			'import { createElement } from "react";',
			'import styles from "./part.module.css";',
			...(throws ? ['if (!(globalThis as Record<string, unknown>).partReady) throw new Error("not ready");'] : []),
			"export default defineFacet((_host, self) =>",
			`\tself.contribute(Parts, () => createElement("p", { id: ${JSON.stringify(id)}, className: styles.${name} }, ${JSON.stringify(text)})),`,
			");",
		].join("\n"),
		"part.module.css": css,
	};
}

/** A web plugin contributing a part `<p id="<id>" class="shared">` styled by its global stylesheet `css`. */
function sharedPlugin(id: string, css: string): Record<string, string> {
	return {
		"web.ts": [
			'import { defineFacet } from "@test/app/v1";',
			'import { Parts } from "@test/app/v1/web";',
			'import { createElement } from "react";',
			'import "./shared.css";',
			"export default defineFacet((_host, self) =>",
			`\tself.contribute(Parts, () => createElement("p", { id: ${JSON.stringify(id)}, className: "shared" }, "shared")),`,
			");",
		].join("\n"),
		"shared.css": css,
	};
}

/**
 * A web plugin whose part `<p id="<id>">` an object contributes, the object's routine taking a second to end when the
 * object restarts (its old contribution stays until its successor is live, design §21).
 */
function objectPlugin(id: string, text: string, css: string): Record<string, string> {
	const name = /\.([a-z]+)/.exec(css)![1]!;
	return {
		"web.ts": [
			'import { defineFacet, local } from "@test/app/v1";',
			'import { Parts } from "@test/app/v1/web";',
			'import { createElement } from "react";',
			'import styles from "./part.module.css";',
			'const Part = local("test.object-part", { version: 1, params: {}, members: {} });',
			"export default defineFacet((host) => host.serve(Part, (_params, self) => {",
			"\tself.onLive(async (ctx) => {",
			'\t\tawait new Promise((resolve) => ctx.abortSignal.addEventListener("abort", () => setTimeout(resolve, 1000), { once: true }));',
			"\t});",
			`\tself.contribute(Parts, () => createElement("p", { id: ${JSON.stringify(id)}, className: styles.${name} }, ${JSON.stringify(text)}));`,
			"\treturn {};",
			"}));",
		].join("\n"),
		"part.module.css": css,
	};
}

/**
 * What the page does with a request for a plugin stylesheet: let it through after `ms`, fail it (a network error), answer
 * an HTTP error `status`, or hold it.
 */
type Holding =
	| { readonly kind: "delay"; readonly ms: number }
	| { readonly kind: "fail" }
	| { readonly kind: "status"; readonly status: number }
	| { readonly kind: "stall" };

describe.skipIf(CHROMIUM === undefined)("a page's plugin stylesheets", () => {
	let browser: Browser;
	/** The requests held (`stall`), by request id. */
	const stalled: string[] = [];

	beforeAll(async () => {
		browser = await Browser.start();
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	/** Holds back the page's requests for plugin stylesheets whose URL contains `plugin` as `holding` says. */
	async function hold(plugin: string, holding: Holding): Promise<void> {
		browser.on("Fetch.requestPaused", (params) => {
			// DevTools' `Fetch.requestPaused` params: a request id and the request.
			const { requestId, request } = params as { requestId: string; request: { url: string } };
			const pass = () => browser.call("Fetch.continueRequest", { requestId }).catch(() => {});
			if (!request.url.includes(plugin)) void pass();
			else if (holding.kind === "fail") void browser.call("Fetch.failRequest", { requestId, errorReason: "Failed" });
			else if (holding.kind === "status") {
				const headers = [{ name: "Content-Type", value: "text/css" }];
				void browser.call("Fetch.fulfillRequest", {
					requestId,
					responseCode: holding.status,
					responseHeaders: headers,
					body: "",
				});
			} else if (holding.kind === "delay") setTimeout(() => void pass(), holding.ms);
			else stalled.push(requestId);
		});
		await browser.call("Fetch.enable", { patterns: [{ urlPattern: "*/_chord/web/plugin/*.css" }] });
	}

	/** Lets plugin stylesheets through again, the held ones too. */
	async function release(): Promise<void> {
		for (const requestId of stalled.splice(0))
			await browser.call("Fetch.continueRequest", { requestId }).catch(() => {});
		browser.on("Fetch.requestPaused", undefined);
		await browser.call("Fetch.disable");
	}

	/** A web app with `plugins` at `port`, the browser signed in and its parts shown. */
	async function started(plugins: Record<string, Record<string, string>>, port?: number) {
		const app = await webApp(await versionedEntry("1"), port ?? (await freePort()), { plugins });
		await signIn(browser, app.app.ownerLink());
		await browser.wait(`document.querySelectorAll("#parts > *").length === ${Object.keys(plugins).length}`);
		return app;
	}

	/** Writes `files` into plugin `dir` of `app`'s root and applies the changes once the plugin is dirty. */
	async function edit(app: Awaited<ReturnType<typeof started>>, dir: string, files: Record<string, string>) {
		for (const [name, text] of Object.entries(files)) await writeFile(join(app.root, dir, name), text);
		while (!app.app.plugins.state.value.dirty.includes(`@test/${dir}`))
			await new Promise((resolve) => setTimeout(resolve, 10));
		return app.app.applyChanges(context);
	}

	/** The computed colour of the element with `id`. */
	const color = (id: string): string => `getComputedStyle(document.getElementById(${JSON.stringify(id)})).color`;

	/** Records in every frame the text and colour of the element with `id` (`none` without one) into `frames`. */
	async function recordFrames(id: string): Promise<void> {
		await browser.evaluate(
			`globalThis.frames = []; globalThis.recording = true; (function frame() { if (!recording) return; const element = document.getElementById(${JSON.stringify(id)}); frames.push(element === null ? "none" : element.textContent + " " + getComputedStyle(element).color); requestAnimationFrame(frame); })()`,
		);
	}

	/** Waits until the recorder sampled `sample`, then stops it: the frames recorded. */
	async function framesUntil(sample: string): Promise<string[]> {
		await browser.wait(`frames.includes(${JSON.stringify(sample)})`);
		await browser.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		return browser.evaluate<string[]>("(globalThis.recording = false, frames)");
	}

	/** The `href`s of the stylesheet links of plugin `dir`. */
	const linksOf = (dir: string): string =>
		`Array.from(document.querySelectorAll('link[href*="@test~${dir}."]'), (link) => link.getAttribute("href") + (link.media ? " " + link.media : ""))`;

	it("loads a slow new stylesheet before the reload: a renamed class is styled in its first frame, the old one never missing", async () => {
		const app = await started({ box: partPlugin("part", "v1", ".box { color: rgb(1, 2, 3); }") });
		try {
			await browser.wait(`${color("part")} === "rgb(1, 2, 3)"`);
			await hold("box", { kind: "delay", ms: 1500 });
			await recordFrames("part");
			await edit(app, "box", partPlugin("part", "v2", ".frame { color: rgb(4, 5, 6); }"));
			const frames = await framesUntil("v2 rgb(4, 5, 6)");
			expect([...new Set(frames)]).toEqual(["v1 rgb(1, 2, 3)", "v2 rgb(4, 5, 6)"]);
			// The old code kept showing (styled) while the new sheet loaded.
			expect(frames.filter((frame) => frame === "v1 rgb(1, 2, 3)").length).toBeGreaterThan(10);
			// The old one goes once the page has drawn the new code.
			await browser.wait(`(${linksOf("box")}).length === 1`);
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("inserts a plugin's new stylesheet beside its old one: the cascade between plugins stays", async () => {
		const app = await started({
			a: sharedPlugin("part-a", ".shared { color: rgb(200, 0, 0); }"),
			b: sharedPlugin("part-b", ".shared { color: rgb(0, 0, 200); }"),
		});
		try {
			// `b` comes after `a`: its rule wins for every `.shared`.
			await browser.wait(`${color("part-a")} === "rgb(0, 0, 200)"`);
			const [before] = await browser.evaluate<string[]>(linksOf("a"));
			// Only `a`'s stylesheet changes (its script does not): a new stylesheet all the same.
			await edit(app, "a", { "shared.css": ".shared { color: rgb(200, 0, 0); border-top: 1px solid; }" });
			await browser.wait(`(${linksOf("a")}).length === 1 && (${linksOf("a")})[0] !== ${JSON.stringify(before)}`);
			expect(await browser.evaluate<string>(color("part-a"))).toBe("rgb(0, 0, 200)");
			expect(
				await browser.evaluate<string>('getComputedStyle(document.getElementById("part-a")).borderTopStyle'),
			).toBe("solid");
		} finally {
			await app.app.close(context);
		}
	}, 120_000);

	it("never shows the new stylesheet of a plugin whose new script fails, not while another plugin's loads either", async () => {
		const app = await started({
			c: partPlugin("part-c", "v1", ".c { color: rgb(7, 7, 7); }"),
			d: partPlugin("part-d", "v1", ".d { color: rgb(1, 1, 1); }"),
		});
		try {
			await browser.wait(`${color("part-c")} === "rgb(7, 7, 7)"`);
			const before = await browser.evaluate<string[]>(linksOf("c"));
			// One rollout: `c`'s new script fails, `d`'s stylesheet takes a second.
			await hold("@test~d.", { kind: "delay", ms: 1000 });
			await recordFrames("part-c");
			for (const [name, text] of Object.entries(partPlugin("part-c", "v2", ".c { color: rgb(8, 8, 8); }", true)))
				await writeFile(join(app.root, "c", name), text);
			while (!app.app.plugins.state.value.dirty.includes("@test/c"))
				await new Promise((resolve) => setTimeout(resolve, 10));
			await edit(app, "d", partPlugin("part-d", "v2", ".d { color: rgb(2, 2, 2); }"));
			await browser.wait('document.getElementById("part-d").textContent === "v2"');
			const frames = await framesUntil("v1 rgb(7, 7, 7)");
			expect([...new Set(frames)]).toEqual(["v1 rgb(7, 7, 7)"]);
			expect(await browser.evaluate<string[]>(linksOf("c"))).toEqual(before);
			expect(await browser.evaluate<unknown[]>("globalThis.errors.map(({ kind }) => kind)")).toContain("plugins");
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("reports a stylesheet that fails, applies the new code, and loads the stylesheet again with the next update", async () => {
		const app = await started({
			e: partPlugin("part-e", "v1", ".e { color: rgb(1, 1, 1); }"),
			f: partPlugin("part-f", "v1", ".f { color: rgb(3, 3, 3); }"),
		});
		try {
			await hold("@test~e.", { kind: "fail" });
			await edit(app, "e", partPlugin("part-e", "v2", ".e { color: rgb(2, 2, 2); }"));
			await browser.wait('document.getElementById("part-e").textContent === "v2"');
			expect(
				await browser.evaluate<unknown[]>(
					'globalThis.errors.filter((error) => error.kind === "stylesheet_failed").map(({ plugin, reason }) => [plugin, reason])',
				),
			).toEqual([["@test/e", "error"]]);
			expect(await browser.evaluate<string>(color("part-e"))).toBe("rgb(0, 0, 0)");
			// The server is reachable again; another plugin's update loads `e`'s stylesheet (the same URL) again.
			await release();
			await edit(app, "f", partPlugin("part-f", "v2", ".f { color: rgb(4, 4, 4); }"));
			await browser.wait(`${color("part-e")} === "rgb(2, 2, 2)"`);
			await browser.wait(`(${linksOf("e")}).length === 1`);
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("loads a stylesheet that failed at the page's first load (HTTP 503) again with the next update", async () => {
		await hold("@test~m.", { kind: "status", status: 503 });
		const app = await started({
			m: partPlugin("part-m", "v1", ".m { color: rgb(6, 6, 6); }"),
			n: partPlugin("part-n", "v1", ".n { color: rgb(1, 1, 1); }"),
		});
		try {
			expect(await browser.evaluate<string>(color("part-m"))).toBe("rgb(0, 0, 0)");
			// The server answers again; another plugin's update loads `m`'s stylesheet (the same URL) again.
			await release();
			await edit(app, "n", partPlugin("part-n", "v2", ".n { color: rgb(2, 2, 2); }"));
			await browser.wait(`${color("part-m")} === "rgb(6, 6, 6)"`);
			await browser.wait(`(${linksOf("m")}).length === 1`);
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("applies a stylesheet that loads after its 10 s, without another update", async () => {
		const app = await started({ g: partPlugin("part-g", "v1", ".g { color: rgb(1, 1, 1); }") });
		try {
			await hold("@test~g.", { kind: "delay", ms: 12_000 });
			await edit(app, "g", partPlugin("part-g", "v2", ".g { color: rgb(5, 5, 5); }"));
			await browser.wait('document.getElementById("part-g").textContent === "v2"', 30_000);
			expect(
				await browser.evaluate<unknown[]>(
					'globalThis.errors.filter((error) => error.kind === "stylesheet_failed").map(({ reason }) => reason)',
				),
			).toEqual(["timeout"]);
			await browser.wait(`${color("part-g")} === "rgb(5, 5, 5)"`, 30_000);
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("ends the wait for a stalled stylesheet after 10 s, and at the client's stop, which removes what it prepared", async () => {
		const app = await started({ h: partPlugin("part-h", "v1", ".h { color: rgb(3, 3, 3); }") });
		try {
			await hold("@test~h.", { kind: "stall" });
			const start = Date.now();
			await edit(app, "h", partPlugin("part-h", "v2", ".h { color: rgb(4, 4, 4); }"));
			await browser.wait('document.getElementById("part-h").textContent === "v2"', 30_000);
			expect(Date.now() - start).toBeGreaterThan(9_000);
			// Stalled again, then the client stops: its update ends there, the new code never loaded.
			await edit(app, "h", partPlugin("part-h", "v3", ".h { color: rgb(5, 5, 5); }"));
			await browser.wait(`(${linksOf("h")}).some((link) => link.endsWith(" not all"))`);
			const before = await browser.evaluate<string[]>(linksOf("h"));
			const stopped = await browser.evaluate<number>(
				"(async () => { const at = performance.now(); await globalThis.stop(); return performance.now() - at; })()",
			);
			expect(stopped).toBeLessThan(2_000);
			// The prepared link went; the stalled requests finishing now change nothing.
			const kept = await browser.evaluate<string[]>(linksOf("h"));
			expect(kept).toEqual(before.filter((link) => !link.endsWith(" not all")));
			await release();
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(await browser.evaluate<string[]>(linksOf("h"))).toEqual(kept);
		} finally {
			await release();
			await app.app.close(context);
		}
	}, 120_000);

	it("tries a failed plugin's script again at a reconnect, with its stylesheet, never one without the other", async () => {
		const port = await freePort();
		const first = await started({ k: partPlugin("part-k", "v1", ".k { color: rgb(1, 1, 1); }") }, port);
		await recordFrames("part-k");
		await edit(first, "k", partPlugin("part-k", "v2", ".k { color: rgb(2, 2, 2); }", true));
		await browser.wait('globalThis.errors.some((error) => error.kind === "plugins")');
		expect(await browser.evaluate<string>(color("part-k"))).toBe("rgb(1, 1, 1)");
		// The script may load now; the server restarts with the same set, and the page reconnects.
		await browser.evaluate("globalThis.partReady = true");
		await first.app.close(context);
		const second = await webApp(await versionedEntry("1"), port, { dataDir: first.dataDir, root: first.root });
		try {
			const frames = await framesUntil("v2 rgb(2, 2, 2)");
			expect(
				frames
					.filter((frame) => frame !== "none")
					.every((frame) => ["v1 rgb(1, 1, 1)", "v2 rgb(2, 2, 2)"].includes(frame)),
			).toBe(true);
		} finally {
			await second.app.close(context);
		}
	}, 120_000);

	// A known limitation, kept visible: an object keeps its old contribution until its successor is live (design §21),
	// but the old stylesheet is retired once the page drew a frame after the reload. If this starts failing because the
	// old part stays styled, retirement learned when a plugin's restarts end: update the README, design §21 and this test.
	it("shows UI an object contributes unstyled while that object restarts (known limitation)", async () => {
		const app = await started({ obj: objectPlugin("part-o", "v1", ".old { color: rgb(1, 2, 3); }") });
		try {
			await browser.wait(`${color("part-o")} === "rgb(1, 2, 3)"`);
			await recordFrames("part-o");
			await edit(app, "obj", objectPlugin("part-o", "v2", ".fresh { color: rgb(4, 5, 6); }"));
			const frames = await framesUntil("v2 rgb(4, 5, 6)");
			expect(frames).toContain("v1 rgb(0, 0, 0)");
		} finally {
			await app.app.close(context);
		}
	}, 120_000);
});
