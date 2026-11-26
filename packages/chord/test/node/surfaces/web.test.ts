// Tests of the web surface's server side (slice 11 §1), through the app kit: the base bundle (content-hashed, served
// forever, rebuilt at each start), plugin scripts as registered scripts and one combined file, `WebScripts` updated by
// a rollout, the page through the app's template with the baseline's CSP, signed in unless public.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { hostKind } from "../../../src/contracts/index.ts";
import { createHost, type Reference } from "../../../src/host/index.ts";
import { WebScripts } from "../../../src/index.ts";
import { SignIns } from "../../../src/node/app/index.ts";
import { createHttp } from "../../../src/node/http/index.ts";
import { createPlugins, type RolloutResult } from "../../../src/node/plugins/index.ts";
import { pageBootstrap, pageScripts, webSurface } from "../../../src/node/surfaces/index.ts";
import { tempDir, testApp } from "../app/support.ts";
import { send } from "../http/support.ts";
import { writePlugin } from "../plugins/support.ts";

/** A web entry in a new directory: its path. */
async function entry(text = "globalThis.started = true;\n"): Promise<string> {
	const dir = await tempDir();
	await writeFile(join(dir, "style.css"), ":root { --brand: red; }\n");
	await writeFile(join(dir, "main.ts"), `import "./style.css";\n${text}`);
	return join(dir, "main.ts");
}

/** A web plugin's files: a facet with a stylesheet. */
const WEB_PLUGIN = {
	"web.ts":
		'import { defineFacet } from "@test/app/v1";\nimport "./notes.css";\nexport default defineFacet(() => {});',
	"notes.css": ".notes { color: var(--accent); }",
};

/** The page template of these tests: the assets' tags in a minimal document. */
const page = (request: { readonly nonce: string }, assets: Parameters<typeof pageScripts>[0]): string =>
	`<!doctype html><title>t</title>${pageScripts(assets, request.nonce)}<div id=root></div>`;

/** A kit app with the web surface and `plugins` (a web kind added). */
async function webApp(
	options: {
		readonly plugins?: Record<string, Record<string, string>>;
		readonly public?: boolean;
		readonly main?: string;
	} = {},
) {
	return testApp({
		kinds: { server: { platform: "node" }, worker: { platform: "node" }, web: { platform: "browser" } },
		plugins: options.plugins ?? {},
		web: { entry: options.main ?? (await entry()), page, ...(options.public === true ? { public: true } : {}) },
	});
}

/** A bearer header of a new owner sign-in of `app`. */
async function owner(app: Awaited<ReturnType<typeof webApp>>["app"]): Promise<Record<string, string>> {
	const issued = await app.host.root(
		async (ctx) =>
			(await ctx.get(SignIns, {})).issue({ principal: { kind: "owner" }, label: "t", kind: "device" }, ctx),
		context,
	);
	return { authorization: `Bearer ${issued.token}` };
}

/** The `src`s and `href`s of a page, in order. */
function urlsOf(html: string): string[] {
	return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(([, url]) => url!);
}

describe("the base bundle and the page", () => {
	it("serves the page with the bootstrap, the scripts and the stylesheets; the files forever", async () => {
		const { app, port } = await webApp({ plugins: { notes: WEB_PLUGIN } });
		const headers = await owner(app);
		const answer = await send(port, "GET", "/", { headers });
		expect(answer.status).toBe(200);
		const html = answer.body.toString();
		const nonce = /script-src [^;]*'nonce-([^']+)'/.exec(String(answer.headers["content-security-policy"]))![1]!;
		expect(html).toContain(`<script nonce="${nonce}">globalThis.chordPage={"base":"${app.web!.base}"`);
		expect(String(answer.headers["content-security-policy"])).toContain("style-src 'self'");
		// Scripts from the surface's files and the nonce only, not any same-origin response (Opus L8).
		expect(String(answer.headers["content-security-policy"])).toContain(
			`script-src http://127.0.0.1:${port}/_chord/web/ 'nonce-${nonce}'`,
		);
		const urls = urlsOf(html);
		expect(urls).toEqual([
			`/_chord/web/base.${app.web!.base}.css`,
			expect.stringMatching(/^\/_chord\/web\/plugin\/@test~notes\.[0-9a-f]+\.[0-9a-f]{16}\.css$/),
			expect.stringMatching(/^\/_chord\/web\/plugins\.[0-9a-f]{16}\.js$/),
			`/_chord/web/base.${app.web!.base}.js`,
		]);
		for (const url of urls) {
			const file = await send(port, "GET", url, { headers });
			expect(file.status).toBe(200);
			expect(file.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
		}
		const base = await send(port, "GET", urls[3]!, { headers });
		expect(base.headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect(base.body.toString()).toContain("globalThis.started=!0");
		expect((await send(port, "GET", urls[0]!, { headers })).body.toString()).toContain("--brand:");
		await app.close(context);
	});

	it("answers the current base hash publicly, and refuses the page and files to a request without a sign-in", async () => {
		const { app, port } = await webApp();
		const base = await send(port, "GET", "/_chord/web/base");
		expect([base.status, JSON.parse(base.body.toString()), base.headers["cache-control"]]).toEqual([
			200,
			app.web!.base,
			"no-store",
		]);
		expect((await send(port, "GET", "/")).status).toBe(401);
		expect((await send(port, "GET", `/_chord/web/base.${app.web!.base}.js`)).status).toBe(401);
		await app.close(context);
		const open = await webApp({ public: true });
		expect((await send(open.port, "GET", "/")).status).toBe(200);
		await open.app.close(context);
	});

	it("rebuilds the base bundle at each start: the same code gives the same hash, other code another", async () => {
		const main = await entry();
		const first = await webApp({ main });
		const hash = first.app.web!.base;
		await first.app.close(context);
		const again = await testApp({
			dataDir: first.dataDir,
			root: first.root,
			kinds: { server: { platform: "node" }, web: { platform: "browser" } },
			web: { entry: main, page },
		});
		expect(again.app.web!.base).toBe(hash);
		await again.app.close(context);
		await writeFile(main, 'import "./style.css";\nglobalThis.started = "changed";\n');
		const changed = await testApp({
			dataDir: first.dataDir,
			root: first.root,
			kinds: { server: { platform: "node" }, web: { platform: "browser" } },
			web: { entry: main, page },
		});
		expect(changed.app.web!.base).not.toBe(hash);
		await changed.app.close(context);
	});
});

describe("plugin scripts", () => {
	it("serves each web facet as a script that registers itself, and the set as one combined file; no eval", async () => {
		const { app, port } = await webApp({ plugins: { notes: WEB_PLUGIN } });
		const headers = await owner(app);
		const scripts = await app.host.get(WebScripts, {}, context);
		const set = scripts.set.value;
		expect(set.base).toBe(app.web!.base);
		expect(set.plugins).toEqual([
			{
				name: "@test/notes",
				digest: expect.stringMatching(/^[0-9a-f]+$/),
				url: `/_chord/web/plugin/@test~notes.${set.plugins[0]!.digest}.js`,
				css: expect.stringMatching(
					new RegExp(`^/_chord/web/plugin/@test~notes\\.${set.plugins[0]!.digest}\\.[0-9a-f]{16}\\.css$`),
				),
			},
		]);
		const script = (await send(port, "GET", set.plugins[0]!.url, { headers })).body.toString();
		expect(
			script.startsWith(
				`chordFacet("@test/notes","${set.plugins[0]!.digest}",(function (require, module, exports) {`,
			),
		).toBe(true);
		expect(script).not.toMatch(/\beval\(|new Function/);
		const combined = (await send(port, "GET", set.combined, { headers })).body.toString();
		// The combined file without source maps (a browser reads one per file); each script keeps its own (Fable L8).
		expect(script).toMatch(/\n\/\/# sourceMappingURL=data:application\/json;base64,/);
		expect(combined).not.toContain("sourceMappingURL");
		expect(combined).toBe(script.replace(/\n\/\/# sourceMappingURL=data:[^\n]*/, ""));
		scripts.release();
		await app.close(context);
	});

	it("keeps a plugin's assets while it keeps its old script after failed builds (Opus L4, Fable M3)", async () => {
		const pictured = {
			"web.ts":
				'import { defineFacet } from "@test/app/v1";\nimport icon from "./icon.svg?url";\nexport default defineFacet(() => { void icon; });',
			"icon.svg": "<svg/>",
		};
		const { app, port, root } = await webApp({ plugins: { pictured, notes: WEB_PLUGIN } });
		const headers = await owner(app);
		const asset = (await app.host.get(WebScripts, {}, context)).set.value;
		const script = (
			await send(port, "GET", asset.plugins.find(({ name }) => name === "@test/pictured")!.url, { headers })
		).body.toString();
		const url = /"(\/_chord\/web\/assets\/icon-[^"]+)"/.exec(script)![1]!;
		await writeFile(join(root, "pictured", "web.ts"), "export default {");
		for (let round = 0; round < 6; round++) {
			await writeFile(join(root, "notes", "notes.css"), `.notes { order: ${round}; }`);
			while (!app.plugins.state.value.dirty.includes("@test/notes"))
				await new Promise((resolve) => setTimeout(resolve, 10));
			await app.applyChanges(context);
		}
		expect((await send(port, "GET", url, { headers })).status).toBe(200);
		await app.close(context);
	});

	it("publishes a new set on a rollout without waiting for clients; the previous files stay served", async () => {
		const { app, port, root } = await webApp({ plugins: { notes: WEB_PLUGIN } });
		const headers = await owner(app);
		const scripts = await app.host.get(WebScripts, {}, context);
		const before = scripts.set.value;
		await writeFile(join(root, "notes", "notes.css"), ".notes { color: var(--fg); }");
		while (!app.plugins.state.value.dirty.includes("@test/notes"))
			await new Promise((resolve) => setTimeout(resolve, 10));
		const result = await app.applyChanges(context);
		expect(result.steps.map(({ name }) => name)).toEqual(["server", "web"]);
		expect(result.steps[1]!.hosts).toEqual([
			{
				kind: "reloaded",
				host: "web",
				report: { plugins: { added: [], changed: ["@test/notes"], removed: [] }, failed: [], objects: [] },
			},
		]);
		const after = scripts.set.value;
		expect(after.plugins[0]!.digest).not.toBe(before.plugins[0]!.digest);
		expect(app.plugins.state.value.dirty).toEqual([]);
		for (const url of [before.plugins[0]!.url, before.combined, after.plugins[0]!.url, after.combined]) {
			expect((await send(port, "GET", url, { headers })).status).toBe(200);
		}
		scripts.release();
		await app.close(context);
	});
});

describe("a rollout publishes only what changed (ERNDL-1064)", () => {
	/** A web plugin whose script says `text`, with a stylesheet. */
	const plugin = (text: string, css = ".notes { color: red; }") => ({
		"web.ts": `import { defineFacet } from "@test/app/v1";\nimport "./notes.css";\nexport default defineFacet(() => { globalThis.said = "${text}"; });`,
		"notes.css": css,
	});

	/** Writes `files` into plugin directory `dir` of `root` and waits until the plugin is dirty. */
	async function edit(
		app: Awaited<ReturnType<typeof webApp>>["app"],
		root: string,
		files: Record<string, string>,
		dir = "notes",
	) {
		for (const [file, text] of Object.entries(files)) await writeFile(join(root, dir, file), text);
		while (!app.plugins.state.value.dirty.includes(`@test/${dir}`))
			await new Promise((resolve) => setTimeout(resolve, 10));
	}

	/** Waits until the plugin set changed. */
	async function setChanged(app: Awaited<ReturnType<typeof webApp>>["app"]): Promise<void> {
		while (!app.plugins.state.value.set) await new Promise((resolve) => setTimeout(resolve, 10));
	}

	/** The web step's report of `result`. */
	const webReport = (result: RolloutResult) => {
		const [host] = result.steps.find(({ name }) => name === "web")!.hosts;
		if (host?.kind !== "reloaded") throw new Error(`the web step did not reload: ${JSON.stringify(host)}`);
		return host.report;
	};

	/** A watch of `scripts`' set: the calls it heard. */
	async function heard(
		scripts: Reference<typeof WebScripts>,
	): Promise<{ calls: unknown[]; stop: () => Promise<void> }> {
		const calls: unknown[] = [];
		const watch = await scripts.set.watch(context);
		watch.start(async (call) => {
			calls.push(call);
		});
		return {
			calls,
			stop: async () => {
				await watch.stop();
			},
		};
	}

	it("an apply that changes nothing publishes nothing: the same set, its watchers hear nothing", async () => {
		const { app, root } = await webApp({ plugins: { notes: plugin("a") } });
		const scripts = await app.host.get(WebScripts, {}, context);
		const before = scripts.set.value;
		const watch = await heard(scripts);
		// Nothing pushed: the surface's current-scripts object is never fetched (Opus).
		const gets = vi.spyOn(app.host, "get");
		for (let round = 0; round < 5; round++) {
			await edit(app, root, plugin("a"));
			expect(webReport(await app.applyChanges(context))).toEqual({
				plugins: { added: [], changed: [], removed: [] },
				failed: [],
				objects: [],
			});
		}
		expect(scripts.set.value).toBe(before);
		expect(gets.mock.calls.filter(([type]) => type.name === "chord.web.current")).toEqual([]);
		gets.mockRestore();
		expect(watch.calls).toEqual([]);
		await watch.stop();
		scripts.release();
		await app.close(context);
	});

	it("publishes a change of one byte, in the script or in its stylesheet, and reports the plugin changed", async () => {
		const { app, root } = await webApp({ plugins: { notes: plugin("a") } });
		const scripts = await app.host.get(WebScripts, {}, context);
		const first = scripts.set.value;
		await edit(app, root, plugin("b"));
		expect(webReport(await app.applyChanges(context)).plugins.changed).toEqual(["@test/notes"]);
		const second = scripts.set.value;
		expect(second.plugins[0]!.digest).not.toBe(first.plugins[0]!.digest);
		await edit(app, root, plugin("b", ".notes { color: rad; }"));
		expect(webReport(await app.applyChanges(context)).plugins.changed).toEqual(["@test/notes"]);
		const third = scripts.set.value;
		expect(third.plugins[0]!.css).not.toBe(second.plugins[0]!.css);
		scripts.release();
		await app.close(context);
	});

	// The script's digest stays here, only the stylesheet changes (the asset's name in it): the report compared digests
	// only (Opus), the no-op rule once was mutated to compare digests only (Astra).
	it("publishes an edit of only an asset its stylesheet names, and reports the plugin changed (Astra)", async () => {
		const pictured = { ...plugin("a", ".notes { background: url(./icon.svg); }"), "icon.svg": "<svg>one</svg>" };
		const { app, root, port } = await webApp({ plugins: { notes: pictured }, public: true });
		const scripts = await app.host.get(WebScripts, {}, context);
		const icon = async () => {
			const style = (await send(port, "GET", scripts.set.value.plugins[0]!.css!)).body.toString();
			return (await send(port, "GET", /\/_chord\/web\/assets\/icon-[A-Z0-9]+\.svg/.exec(style)![0])).body.toString();
		};
		expect(await icon()).toBe("<svg>one</svg>");
		await edit(app, root, { "icon.svg": "<svg>two</svg>" });
		expect(webReport(await app.applyChanges(context)).plugins.changed).toEqual(["@test/notes"]);
		expect(await icon()).toBe("<svg>two</svg>");
		scripts.release();
		await app.close(context);
	});

	it("an apply while a plugin's build fails reports it and publishes nothing (Opus)", async () => {
		const { app, root } = await webApp({ plugins: { notes: plugin("a"), other: plugin("o") } });
		const scripts = await app.host.get(WebScripts, {}, context);
		const before = scripts.set.value;
		const watch = await heard(scripts);
		await edit(app, root, { "web.ts": "export default {" }, "other");
		const gets = vi.spyOn(app.host, "get");
		for (let round = 0; round < 2; round++) {
			const report = webReport(await app.applyChanges(context));
			expect(report.plugins).toEqual({ added: [], changed: [], removed: [] });
			expect(report.failed.map(({ plugin }) => plugin)).toEqual(["@test/other"]);
		}
		expect(scripts.set.value).toBe(before);
		expect(gets.mock.calls.filter(([type]) => type.name === "chord.web.current")).toEqual([]);
		gets.mockRestore();
		expect(watch.calls).toEqual([]);
		await watch.stop();
		scripts.release();
		await app.close(context);
	});

	it("publishes a plugin added and a plugin removed (Opus)", async () => {
		const { app, root } = await webApp({ plugins: { notes: plugin("a") } });
		const scripts = await app.host.get(WebScripts, {}, context);
		await writePlugin(root, "other", "@test/other", plugin("o"));
		await setChanged(app);
		expect(webReport(await app.applyChanges(context)).plugins.added).toEqual(["@test/other"]);
		expect(scripts.set.value.plugins.map(({ name }) => name)).toEqual(["@test/notes", "@test/other"]);
		await rm(join(root, "notes"), { recursive: true });
		await setChanged(app);
		expect(webReport(await app.applyChanges(context)).plugins.removed).toEqual(["@test/notes"]);
		expect(scripts.set.value.plugins.map(({ name }) => name)).toEqual(["@test/other"]);
		scripts.release();
		await app.close(context);
	});

	it("pushes a set again whose push failed: an apply cancelled during the push, then one changing nothing (Astra, Opus)", async () => {
		const { app, root, port } = await webApp({ plugins: { notes: plugin("a") }, public: true });
		const scripts = await app.host.get(WebScripts, {}, context);
		const old = scripts.set.value;
		await edit(app, root, plugin("b"));
		const cancelled = withCancel(context);
		const get = app.host.get.bind(app.host);
		// Cancels the apply at the push, right before the surface's current-scripts object is fetched.
		const spy = vi.spyOn(app.host, "get").mockImplementation((type, params, ctx) => {
			if (type.name === "chord.web.current") cancelled.cancel(new Error("caller disconnected"));
			return get(type, params, ctx);
		});
		const first = await app.applyChanges(cancelled.context);
		spy.mockRestore();
		expect(first.stopped?.step).toBe("web");
		expect(scripts.set.value).toBe(old);
		// The plugin stays dirty: the next apply builds the same script, so its set is no new one, and pushes it; its
		// report is against the set pages last got (Opus).
		const retry = await app.applyChanges(context);
		expect(retry.stopped).toBeUndefined();
		expect(webReport(retry).plugins.changed).toEqual(["@test/notes"]);
		expect(scripts.set.value).not.toBe(old);
		expect(scripts.set.value.plugins[0]!.digest).not.toBe(old.plugins[0]!.digest);
		expect((await send(port, "GET", "/")).body.toString()).not.toContain(old.combined);
		scripts.release();
		await app.close(context);
	});
});

describe("an app serving the surface itself (routes: false)", () => {
	it("contributes no routes, and gives the files, the page's assets and the base hash", async () => {
		const root = join(await tempDir(), "plugins");
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, "notes", "package.json"), '{ "name": "notes" }');
		await writeFile(join(root, "notes", "web.ts"), "export default { setup() {} };\n");
		const server = createHost<{ readonly kind: "server" }>({
			address: hostKind("server")(),
			principal: { kind: "server" },
			onError: () => {},
		});
		const plugins = createPlugins(
			{ roots: [root], kinds: { web: { platform: "browser", hostPackages: [] } }, onError: () => {} },
			context,
		);
		const web = webSurface(server, { plugins, entry: await entry(), routes: false });
		const http = createHttp(server, { onError: () => {} }, context);
		try {
			await server.load(
				[
					{ name: "chord.http", facet: http.facet },
					{ name: "chord.web", facet: web.facet },
				],
				context,
			);
			expect((await web.build()).kind).toBe("built");
			// The surface's public route of every app serving it through the HTTP component: none here.
			const asked = await http.fetch(
				new Request("http://127.0.0.1/_chord/web/base", { headers: { host: "127.0.0.1" } }),
				{
					localAddress: "127.0.0.1",
					localPort: 80,
					remoteAddress: "127.0.0.1",
				},
			);
			expect(asked.status).toBe(404);
			const base = await web.base();
			expect(base).toMatch(/^[0-9a-f]{16}$/);
			const assets = await web.pageAssets();
			const scripts = await server.get(WebScripts, {}, context);
			const set = scripts.set.value;
			expect(set.plugins.map(({ name }) => name)).toEqual(["notes"]);
			expect(assets).toEqual({
				bootstrap: pageBootstrap(base!, set),
				script: `/_chord/web/base.${base}.js`,
				plugins: set.combined,
				styles: [`/_chord/web/base.${base}.css`],
			});
			const file = await web.file(set.combined);
			expect(file.kind).toBe("bytes");
			expect((await web.file("/_chord/web/none.js")).kind).toBe("error");
			scripts.release();
		} finally {
			await http.close(context);
			await server.close(context);
			plugins.close();
		}
	});
});
