// Tests of `startServer` (slice 13 §1, §4, §5): the layout and the start-data object, start and close, a server without
// workers (and without `principal.worker`), an owner refused (not strict JSON, the server's principal), two worker
// kinds, `applyChanges`, a required root failing, a worker entry that does not build, the base marks (a worker base's
// inputs among them), and export, import and delete per address (documents, tables and files round-trip with the
// server's records and rows belonging to the address; an existing address refused unless replaced).

import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { arr, hostKind, local, method, obj, remote, str, unknown } from "../../../src/contracts/index.ts";
import { ChordError } from "../../../src/data/index.ts";
import { invalid } from "../../../src/data/internal.ts";
import { addressParam, HostData } from "../../../src/node/app/data.ts";
import { AppInfo, type AppOptions } from "../../../src/node/app/index.ts";
import { PluginWatcher } from "../../../src/node/plugins/watcher.ts";
import { changesOf, flushed, rejection } from "../../support.ts";
import { send } from "../http/support.ts";
import { gitRepository, writePlugin } from "../plugins/support.ts";
import {
	ECHO_SERVER,
	NOTES_PLUGIN,
	Notes,
	Project,
	startTestApp,
	tempDir,
	testApp,
	type UserPrincipal,
	userOwnerApp,
	WORKER_ENTRY,
} from "./support.ts";

const ada: UserPrincipal = { kind: "user", id: "u1" };

const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });

/** The meta plugin's server object (`META_PLUGIN`), declared again for the tests (contracts are data). */
const MetaStore = local("test.meta-store", {
	version: 1,
	params: {},
	members: {
		set: method(obj({ id: str(), title: str(), label: str() })),
		get: method(str(), obj({ title: str(), labels: arr(str()) })),
	},
});

/** A plugin keeping data about projects on the server: a document and table rows keyed by the project's address. */
const META_PLUGIN: Readonly<Record<string, string>> = {
	"server.ts": [
		'import { arr, defineFacet, defineState, defineTable, eq, host, hostKind, local, method, obj, query, str } from "@test/app/v1";',
		'const Project = hostKind("project", { id: str() });',
		'const Meta = defineState("test.meta", { schema: obj({ title: str() }), version: 1, initial: () => ({ title: "" }), keyed: Project, persist: true, checkpointWhen: () => false });',
		'const Labels = defineTable("test.labels", { version: 1, columns: { project: host(Project), label: str() }, key: ["project", "label"] });',
		'const MetaStore = local("test.meta-store", { version: 1, params: {}, members: { set: method(obj({ id: str(), title: str(), label: str() })), get: method(str(), obj({ title: str(), labels: arr(str()) })) } });',
		"export default defineFacet((h) => h.serve(MetaStore, (_params, self) => {",
		"	const meta = self.state(Meta);",
		"	const labels = self.table(Labels);",
		"	return {",
		"		set: async ({ id, title, label }, ctx) => { await self.tx(async (tx) => { (await tx.draft(meta, Project({ id }))).title = title; tx.put(labels, { project: Project({ id }), label }); }, ctx); return null; },",
		'		get: async (id, ctx) => ({ title: (await meta.get(Project({ id }), ctx))?.title ?? "", labels: (await labels.page(query(Labels).where((t) => eq(t.project, Project({ id }))), 10, ctx)).items.map((row) => row.label) }),',
		"	};",
		"}));",
	].join("\n"),
};

describe("starting and closing", () => {
	it("lays out the data directory, serves AppInfo and the server's plugins, and closes everything", async () => {
		const { app, dataDir, port } = await testApp({ plugins: { echo: { "server.ts": ECHO_SERVER } } });
		expect((await readdir(dataDir)).sort()).toEqual(["cache", "logs", "owner-token", "plugins", "server", "workers"]);
		expect((await readdir(join(dataDir, "server"))).filter((name) => !name.startsWith("."))).toEqual(
			expect.arrayContaining(["cookie-secret", "store.sqlite"]),
		);
		const info = await app.host.get(AppInfo, {}, context);
		expect([info.dataDir.value, info.name.value, info.version.value, info.owner.value]).toEqual([
			dataDir,
			"chord-test",
			"v1",
			{ kind: "owner" },
		]);
		expect((await app.host.get(Echo, {}, context)).text.value).toBe("echo");
		expect(app.ownerLink()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/_chord/owner#[A-Za-z0-9_-]{43}$`));
		expect(app.workers.size).toBe(0);
		await app.close(context);
		// HTTP closed first: the port answers nothing any more; a second close is the same close.
		await expect(send(port, "GET", "/")).rejects.toThrow();
		await app.close(context);
	});

	it("refuses a second server on the same data directory while the first runs", async () => {
		const first = await testApp();
		const second = await rejection(testApp({ dataDir: first.dataDir, root: first.root }));
		expect(String(second)).toContain(`another server runs on ${first.dataDir}`);
		await first.app.close(context);
		const third = await testApp({ dataDir: first.dataDir, root: first.root });
		await third.app.close(context);
	});

	it("refuses a second server on the same data directory through a symbolic link (review L3)", async () => {
		const first = await testApp();
		const link = join(await tempDir(), "link");
		await symlink(first.dataDir, link);
		expect(String(await rejection(testApp({ dataDir: link, root: first.root })))).toContain("another server runs on");
		await first.app.close(context);
	});

	it("makes the data directory private at every start, also when it existed looser (review M3)", async () => {
		const dataDir = join(await tempDir(), "data");
		await mkdir(join(dataDir, "server"), { recursive: true, mode: 0o775 });
		await chmod(dataDir, 0o755);
		await chmod(join(dataDir, "server"), 0o775);
		const { app } = await testApp({ dataDir });
		const mode = async (path: string) => (await stat(join(dataDir, path))).mode & 0o777;
		const paths = [
			".",
			"server",
			"workers",
			"plugins",
			"logs",
			"cache",
			"cache/workers",
			"cache/node",
			"server/store.sqlite",
			"server/cookie-secret",
			"owner-token",
		];
		expect(await Promise.all(paths.map(mode))).toEqual([
			0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o700, 0o600, 0o600, 0o600,
		]);
		await app.close(context);
		await chmod(join(dataDir, "server", "store.sqlite"), 0o644);
		await chmod(join(dataDir, "owner-token"), 0o644);
		const again = await testApp({ dataDir });
		expect([await mode("server/store.sqlite"), await mode("owner-token")]).toEqual([0o600, 0o600]);
		await again.app.close(context);
	});

	it("refuses a data directory the kit must not tighten: home, root, another user's, also through a link (recheck N4)", async () => {
		const homeMode = (await stat(homedir())).mode & 0o777;
		expect(String(await rejection(testApp({ dataDir: homedir() })))).toContain("is the home directory");
		expect(String(await rejection(testApp({ dataDir: "/" })))).toContain("is a file system's root");
		const link = join(await tempDir(), "home-link");
		await symlink(homedir(), link);
		expect(String(await rejection(testApp({ dataDir: link })))).toContain("is the home directory");
		expect((await stat(homedir())).mode & 0o777).toBe(homeMode);
		if (process.getuid?.() !== 0) {
			// `/tmp`'s owner is root.
			expect(String(await rejection(testApp({ dataDir: "/tmp" })))).toContain("belongs to another user");
		}
	});

	it("names the address listened on in the owner link (review L4)", async () => {
		const { app } = await testApp({ listen: { host: "::1", port: 0 } });
		expect(app.ownerLink()).toMatch(/^http:\/\/\[::1\]:\d+\/_chord\/owner#/);
		await app.close(context);
	});

	it("rejects when a plugin of the app's root fails, with everything closed", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "broken", "@test/broken", { "server.ts": "export default {" });
		const dataDir = join(base, "data");
		const error = await rejection(testApp({ root, dataDir }));
		expect(error).toMatchObject({ name: "PluginError" });
		expect(String(error)).toContain('"@test/broken"');
		// Closed: the data directory's lock is free again (a second start fails only on the same plugin).
		expect(await rejection(testApp({ root, dataDir }))).toMatchObject({ name: "PluginError" });
	});

	it("starts without worker kinds and without `principal.worker`; worker kinds need it (a type error)", async () => {
		const { app } = await startTestApp<UserPrincipal>({ server: { kind: "server" }, owner: ada }, {});
		expect(app.workers.size).toBe(0);
		await app.close(context);
		// Type-checked only: the `@ts-expect-error` below is the test.
		const worker = { kind: Project, entry: WORKER_ENTRY, start: () => null, authorize: () => true };
		const principal: { server: UserPrincipal; owner: UserPrincipal } = { server: { kind: "server" }, owner: ada };
		void ((options: AppOptions<UserPrincipal>) => {
			// @ts-expect-error worker kinds without `principal.worker`
			const refused: AppOptions<UserPrincipal> = { ...options, principal, workers: [worker] };
			return refused;
		});
	});

	it("refuses an owner that is not strict JSON or is the server's principal, before it opens anything", async () => {
		const notJson = await rejection(userOwnerApp({ kind: "user", id: "u1", name: undefined }));
		expect(String(notJson)).toContain("principal.owner must be strict JSON");
		const server = await rejection(userOwnerApp({ kind: "server" }));
		expect(String(server)).toContain("principal.owner must not be the server's principal");
	});
});

describe("workers", () => {
	it("starts a worker per address with the kit's start data and its own directory; two kinds side by side", async () => {
		const Team = hostKind("team", { id: str() });
		const Members = remote("test.members", {
			version: 1,
			params: { id: str() },
			hostAddress: ({ id }) => Team({ id }),
			variants: { main: { state: { start: unknown() } } },
		});
		const team = [
			'import { defineFacet, hostKind, remote, str, unknown, WorkerInfo } from "@test/app/v1";',
			'const Team = hostKind("team", { id: str() });',
			'const Members = remote("test.members", { version: 1, params: { id: str() }, hostAddress: ({ id }) => Team({ id }), variants: { main: { state: { start: unknown() } } } });',
			"export default defineFacet((host) => host.serve(Members, (_params, _principal, self) => {",
			"\tconst info = self.get(WorkerInfo, {});",
			'\treturn { variant: "main", members: { start: self.derive([info.start], ([value]) => value) } };',
			"}));",
		].join("\n");
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		await writePlugin(root, "team", "@test/team", { "teamworker.ts": team });
		const { app, dataDir } = await testApp({
			root,
			withWorkers: true,
			kinds: { server: { platform: "node" }, worker: { platform: "node" }, teamworker: { platform: "node" } },
			workers: [
				{
					kind: Project,
					entry: WORKER_ENTRY,
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: (address) => ({ project: address.key }),
					authorize: () => true,
				},
				{
					kind: Team,
					entry: WORKER_ENTRY,
					facet: "teamworker",
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: (address) => ({ team: address.key }),
					authorize: () => true,
				},
			],
		});
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		const members = await app.host.get(Members, { id: "t1" }, context);
		expect([notes.start.value, members.start.value]).toEqual([{ project: "project|p1" }, { team: "team|t1" }]);
		expect(await readdir(join(dataDir, "workers"))).toEqual(["project", "team"]);
		expect(await readdir(join(dataDir, "workers", "project"))).toEqual(["project%7Cp1"]);
		notes.release();
		members.release();
		await app.close(context);
	}, 60_000);

	it("applies changes: builds the dirty plugins and rolls them out to the server, then the workers", async () => {
		const { app, root } = await testApp({ plugins: { echo: { "server.ts": ECHO_SERVER } } });
		const echo = await app.host.get(Echo, {}, context);
		await writeFile(join(root, "echo", "server.ts"), ECHO_SERVER.replace('"echo"', '"changed"'));
		while (!app.plugins.state.value.dirty.includes("@test/echo"))
			await new Promise((resolve) => setTimeout(resolve, 10));
		const result = await app.applyChanges(context);
		expect(result.stopped).toBeUndefined();
		expect(result.steps.map(({ name }) => name)).toEqual(["server"]);
		// Restarted: the new attempt goes live once the old one ended.
		await flushed();
		expect(echo.text.value).toBe("changed");
		expect(app.plugins.state.value.dirty).toEqual([]);
		await app.close(context);
	});
});

describe("applying changes one after another", () => {
	it("starts a later applyChanges after the earlier one rolled out, so the newest build stays deployed", async () => {
		const { app, root } = await testApp({ plugins: { echo: { "server.ts": ECHO_SERVER } } });
		const echo = await app.host.get(Echo, {}, context);
		const component = app.plugins.component;
		const build = component.build.bind(component);
		const rollout = component.rollout.bind(component);
		const events: string[] = [];
		const built = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		// The first build read its files, then waits: unserialized, the second would build and roll out meanwhile.
		component.build = async (names, ctx) => {
			const n = events.filter((event) => event.startsWith("build")).length + 1;
			events.push(`build ${n}`);
			const result = await build(names, ctx);
			if (n === 1) {
				built.resolve();
				await gate.promise;
			}
			return result;
		};
		component.rollout = async (steps, result, ctx) => {
			events.push("rollout");
			return rollout(steps, result, ctx);
		};
		const marks = changesOf(await app.plugins.state.watch(context));
		const edit = async (text: string): Promise<void> => {
			const seen = marks.length;
			await writeFile(join(root, "echo", "server.ts"), ECHO_SERVER.replace('"echo"', JSON.stringify(text)));
			await vi.waitFor(() => expect(marks.length).toBeGreaterThan(seen), { timeout: 5_000 });
		};
		try {
			await edit("v2");
			const first = app.applyChanges(context);
			await built.promise;
			await edit("v3");
			const second = app.applyChanges(context);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(events).toEqual(["build 1"]);
			gate.resolve();
			await first;
			await second;
			expect(events).toEqual(["build 1", "rollout", "build 2", "rollout"]);
			await flushed();
			expect(echo.text.value).toBe("v3");
		} finally {
			echo.release();
			await app.close(context);
		}
	});
});

describe("base code", () => {
	it("compares the server's own code from its entry, the start script and what it imports, with no `base` given", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "helper.ts"), 'export const label = "v1";\n');
		// The server marks `base` for an edit of a module the start script imports, and clears at the revert.
		const helper = JSON.stringify(join(dir, "helper.ts"));
		const stdout = await runStart(
			dir,
			['import { label } from "./helper.ts";'],
			[
				"await started.baseWatched;",
				"console.log(label, started.plugins.state.value.base);",
				`await writeFile(${helper}, 'export const label = "v2";\\n');`,
				"await until(true);",
				`await writeFile(${helper}, 'export const label = "v1";\\n');`,
				"await until(false);",
				'console.log("marked and cleared");',
			],
		);
		expect(stdout).toEqual(["v1 false", "marked and cleared"]);
	}, 60_000);

	it("starts with an entry whose inactive optional import is missing: the import is left out, the rest compared", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "helper.ts"), 'export const label = "v1";\n');
		const stdout = await runStart(
			dir,
			[
				'import { label } from "./helper.ts";',
				'if (process.env.CHORD_TEST_OPTIONAL === "yes") await import("./optional-feature-not-installed.mjs");',
				'if (process.env.CHORD_TEST_OPTIONAL === "yes") await import("optional-package-not-installed");',
			],
			[
				"await started.baseWatched;",
				'console.log("started", label, errors.length);',
				`await writeFile(${JSON.stringify(join(dir, "helper.ts"))}, 'export const label = "v2";\\n');`,
				"await until(true);",
				'console.log("marked");',
			],
		);
		expect(stdout).toEqual(["started v1 0", "marked"]);
	}, 60_000);

	it("starts when the scan of its entry fails (a lazy import of a file it cannot parse): reported, not compared", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "broken.mjs"), "export const = ;\n");
		const stdout = await runStart(
			dir,
			['if (process.env.CHORD_TEST_NEVER === "yes") await import("./broken.mjs");'],
			[
				'console.log("started", errors.length);',
				"await started.baseWatched;",
				'console.log("scanned", errors.map(({ kind }) => kind).join(" "));',
			],
		);
		expect(stdout).toEqual(["started 0", "scanned server_scan"]);
	}, 60_000);

	it.skipIf(process.platform !== "linux")(
		"answers before the scan of its own code finished: the scan runs after the start",
		async () => {
			const dir = await tempDir();
			// A file only the scan reads (Node never runs the import): a pipe, so the scan waits until it is written.
			execFileSync("mkfifo", [join(dir, "held.mjs")]);
			const stdout = await runStart(
				dir,
				['if (process.env.CHORD_TEST_NEVER === "yes") await import("./held.mjs");'],
				[
					'const owner = await fetch(new URL(started.ownerLink()).origin + "/_chord/owner");',
					'console.log("answered", owner.status);',
					// The pipe is fed from now on: each read of it (the scan's, the watcher's first comparison) gets the file.
					`let feeding = true; void (async () => { while (feeding) { try { const fd = openSync(${JSON.stringify(join(dir, "held.mjs"))}, constants.O_WRONLY | constants.O_NONBLOCK); writeSync(fd, "export {};"); closeSync(fd); } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); } })();`,
					"await started.baseWatched;",
					"feeding = false;",
					'console.log("scanned");',
				],
			);
			expect(stdout).toEqual(["answered 200", "scanned"]);
		},
		60_000,
	);

	it.skipIf(process.platform !== "linux")(
		"closes without waiting for a scan of its own code stalled on a read",
		async () => {
			const dir = await tempDir();
			execFileSync("mkfifo", [join(dir, "held.mjs")]);
			const stdout = await runStart(
				dir,
				['if (process.env.CHORD_TEST_NEVER === "yes") await import("./held.mjs");'],
				[
					// Once the scan reads the pipe (a non-blocking open for writing succeeds; kept open, it ends nothing yet).
					`let fd = -1; for (;;) { try { fd = openSync(${JSON.stringify(join(dir, "held.mjs"))}, constants.O_WRONLY | constants.O_NONBLOCK); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }`,
					"const origin = new URL(started.ownerLink()).origin;",
					"const at = performance.now();",
					"await started.close(context);",
					'console.log("closed", performance.now() - at < 2000);',
					// Closed: HTTP answers no more while the scan is still stalled.
					'console.log("http", await fetch(origin + "/_chord/owner").then(() => "answered", () => "refused"));',
					// The scan's read ends only when the pipe is written (the process can exit then); its result is dropped.
					'writeSync(fd, "export {};");',
					"closeSync(fd);",
					"await started.baseWatched;",
					'console.log("errors", errors.length, "base", started.plugins.state.value.base);',
				],
			);
			expect(stdout).toEqual(["closed true", "http refused", "errors 0 base false"]);
		},
		60_000,
	);

	it("marks a file of its own code edited right after the start, before the scan read it (Node loaded the old)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "helper.ts"), 'export const label = "v1";\n');
		const stdout = await runStart(
			dir,
			['import { label } from "./helper.ts";'],
			[
				`await writeFile(${JSON.stringify(join(dir, "helper.ts"))}, 'export const label = "v2";\\n');`,
				"await started.baseWatched;",
				"console.log(label, started.plugins.state.value.base);",
			],
		);
		expect(stdout).toEqual(["v1 true"]);
	}, 60_000);

	it("does not mark a file of its own code stamped in the future: compared by its bytes (Astra)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "helper.ts"), 'export const label = "v1";\n');
		const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
		await utimes(join(dir, "helper.ts"), tomorrow, tomorrow);
		const stdout = await runStart(
			dir,
			['import { label } from "./helper.ts";'],
			["await started.baseWatched;", "console.log(label, started.plugins.state.value.base);"],
		);
		expect(stdout).toEqual(["v1 false"]);
	}, 60_000);

	it("settles baseWatched only once the base bundles' records were compared (an edit right after the start)", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "worker.ts"), 'export const label = "v1";\n');
		const worker = { kind: Project, entry: join(dir, "worker.ts"), start: () => null, authorize: () => true };
		// Edit after the build but before its first comparison, not after baseWatched may already have settled.
		const recordBase = PluginWatcher.prototype.recordBase;
		let edits = 0;
		const recording = vi.spyOn(PluginWatcher.prototype, "recordBase").mockImplementation(async function (
			this: PluginWatcher,
			inputs,
		) {
			if (inputs.has(worker.entry)) {
				edits++;
				await writeFile(worker.entry, 'export const label = "v2";\n');
			}
			return recordBase.call(this, inputs);
		});
		try {
			const { app } = await testApp({ workers: [worker] });
			try {
				await app.baseWatched;
				expect(edits).toBe(1);
				expect(app.plugins.state.value.base).toBe(true);
			} finally {
				await app.close(context);
			}
		} finally {
			recording.mockRestore();
		}
	});

	it("marks base for a change of `base`'s files and directories and of a file a worker kind's base was built from, not for a rewrite with the same bytes", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "api"));
		await writeFile(join(dir, "api", "v1.ts"), "export {};");
		await writeFile(join(dir, "start.ts"), "export {};");
		await writeFile(join(dir, "worker.ts"), 'import "./shared.ts";');
		await writeFile(join(dir, "shared.ts"), "export {};");
		const worker = { kind: Project, entry: join(dir, "worker.ts"), start: () => null, authorize: () => true };
		// The entry last: its change drops its import.
		const changes = [
			join(dir, "api", "v1.ts"),
			join(dir, "start.ts"),
			join(dir, "shared.ts"),
			join(dir, "worker.ts"),
		];
		for (const changed of changes) {
			const { app } = await testApp({ base: [join(dir, "api"), join(dir, "start.ts")], workers: [worker] });
			try {
				expect(app.plugins.state.value.base).toBe(false);
				await writeFile(changed, await readFile(changed));
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(app.plugins.state.value.base).toBe(false);
				await writeFile(changed, "export const changed = 1;");
				await vi.waitFor(() => expect(app.plugins.state.value.base).toBe(true), { timeout: 5_000 });
			} finally {
				await app.close(context);
			}
		}
	});
});

describe("bases built after the listen", () => {
	/** A pipe at `path` read by a base build: fed from now on (each read gets `text`) until `stop` is called. */
	function feed(path: string, text: string): { stop(): void } {
		let feeding = true;
		void (async () => {
			while (feeding) {
				try {
					// Succeeds only while a reader waits (a build, the watcher's first comparison).
					const fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
					writeSync(fd, text);
					closeSync(fd);
				} catch {}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		})();
		return {
			stop: () => {
				feeding = false;
			},
		};
	}

	/** Whether `promise` is still pending after 300 ms. */
	async function pending(promise: Promise<unknown>): Promise<boolean> {
		const later = Symbol("pending");
		return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(later), 300))])) === later;
	}

	it.skipIf(process.platform !== "linux")(
		"answers its owner page before the web base is built; a page request waits for its base",
		async () => {
			const dir = await tempDir();
			// The entry imports a pipe: its build waits until the pipe is written.
			execFileSync("mkfifo", [join(dir, "held.ts")]);
			await writeFile(join(dir, "main.ts"), 'import "./held.ts";\nglobalThis.started = true;\n');
			const page = (_request: unknown, assets: { readonly script: string }) => `<p>${assets.script}</p>`;
			const { app, port } = await testApp({
				unbuilt: true,
				kinds: { server: { platform: "node" }, web: { platform: "browser" } },
				web: { entry: join(dir, "main.ts"), page, public: true },
			});
			try {
				expect((await send(port, "GET", "/_chord/owner")).status).toBe(200);
				expect(app.web).toEqual({ base: undefined });
				const answer = send(port, "GET", "/");
				expect(await pending(answer)).toBe(true);
				expect(await pending(app.basesBuilt)).toBe(true);
				const fed = feed(join(dir, "held.ts"), "export {};");
				try {
					const { status, body } = await answer;
					expect([status, body.toString()]).toEqual([200, `<p>/_chord/web/base.${app.web!.base}.js</p>`]);
					await app.baseWatched;
				} finally {
					fed.stop();
				}
			} finally {
				await app.close(context);
			}
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"answers before a worker kind's base is built; a worker start waits for its base",
		async () => {
			const dir = await tempDir();
			execFileSync("mkfifo", [join(dir, "held.ts")]);
			await writeFile(join(dir, "worker.ts"), `import "./held.ts";\nimport ${JSON.stringify(WORKER_ENTRY)};\n`);
			const starts: string[] = [];
			const worker = {
				kind: Project,
				entry: join(dir, "worker.ts"),
				execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				start: (address: { readonly key: string }) => {
					starts.push(address.key);
					return { project: address.key };
				},
				authorize: () => true,
			};
			const { app, port } = await testApp({ unbuilt: true, plugins: { notes: NOTES_PLUGIN }, workers: [worker] });
			try {
				expect((await send(port, "GET", "/_chord/owner")).status).toBe(200);
				const notes = app.host.get(Notes, { id: "p1" }, context);
				expect(await pending(notes)).toBe(true);
				// The app's start data is asked for only once the base is built.
				expect(starts).toEqual([]);
				const fed = feed(join(dir, "held.ts"), "export {};");
				try {
					(await notes).release();
					expect(starts).toEqual(["project|p1"]);
					await app.baseWatched;
				} finally {
					fed.stop();
				}
			} finally {
				await app.close(context);
			}
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"a closed start's late worker-base build never touches the next start's directory: its worker still lazy-imports",
		async () => {
			const dir = await tempDir();
			execFileSync("mkfifo", [join(dir, "held.mjs")]);
			await writeFile(join(dir, "old.mjs"), 'import "./held.mjs";\n');
			// The next start's worker: the fixture worker, plus a lazy import once the test asks for it (file `go`).
			const lazily = [
				`import ${JSON.stringify(WORKER_ENTRY)};`,
				'import { existsSync, writeFileSync } from "node:fs";',
				"const poll = setInterval(async () => {",
				`\tif (!existsSync(${JSON.stringify(join(dir, "go"))})) return;`,
				"\tclearInterval(poll);",
				'\tconst label = await import("./lazy.mjs").then(({ label }) => label, (error) => "ERROR " + error.code);',
				`\twriteFileSync(${JSON.stringify(join(dir, "result"))}, label);`,
				"}, 10);",
			].join("\n");
			await writeFile(join(dir, "new.mjs"), lazily);
			await writeFile(join(dir, "lazy.mjs"), 'export const label = "lazy";\n');
			const worker = (entry: string) => ({
				kind: Project,
				entry,
				execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
				start: (address: { readonly key: string }) => ({ project: address.key }),
				authorize: () => true,
			});
			const plugins = { notes: NOTES_PLUGIN };
			const old = await testApp({ unbuilt: true, plugins, workers: [worker(join(dir, "old.mjs"))] });
			// The old start's build reads the pipe (an open for writing succeeds now); it is held until the pipe is written.
			let fd = -1;
			while (fd < 0) {
				try {
					fd = openSync(join(dir, "held.mjs"), constants.O_WRONLY | constants.O_NONBLOCK);
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			await old.app.close(context);
			const next = await testApp({
				dataDir: old.dataDir,
				root: old.root,
				plugins,
				workers: [worker(join(dir, "new.mjs"))],
			});
			try {
				// A worker of the next start runs from `cache/workers/project/`.
				(await next.app.host.get(Notes, { id: "p1" }, context)).release();
				writeSync(fd, "export {};");
				closeSync(fd);
				fd = -1;
				await old.app.basesBuilt;
				await writeFile(join(dir, "go"), "");
				await vi.waitFor(async () => expect(await readFile(join(dir, "result"), "utf8")).toBe("lazy"), {
					timeout: 5_000,
				});
			} finally {
				if (fd >= 0) closeSync(fd);
				await next.app.close(context);
			}
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"an aborted Apply waiting at the web step for the initial build stops there; the build goes on (Sol)",
		async () => {
			const dir = await tempDir();
			execFileSync("mkfifo", [join(dir, "held.ts")]);
			await writeFile(join(dir, "main.ts"), 'import "./held.ts";\nglobalThis.started = true;\n');
			const { app, port } = await testApp({
				unbuilt: true,
				kinds: { server: { platform: "node" }, web: { platform: "browser" } },
				web: { entry: join(dir, "main.ts"), page: () => "<p>page</p>", public: true },
			});
			try {
				const controller = new AbortController();
				const applied = app.applyChanges(withAbortSignal(controller.signal, context));
				expect(await pending(applied)).toBe(true);
				controller.abort(new Error("cancel Apply"));
				const result = await applied;
				expect([result.stopped?.step, (result.stopped?.error as Error).message]).toEqual(["web", "cancel Apply"]);
				const fed = feed(join(dir, "held.ts"), "export {};");
				try {
					expect((await send(port, "GET", "/")).status).toBe(200);
					await app.baseWatched;
				} finally {
					fed.stop();
				}
			} finally {
				await app.close(context);
			}
		},
		30_000,
	);

	it("reports a base that fails after the listen and runs on: the page answers 503, the kind's workers fail their start", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "main.ts"), "export const broken = ;\n");
		await writeFile(join(dir, "worker.ts"), "export const broken = ;\n");
		const worker = { kind: Project, entry: join(dir, "worker.ts"), start: () => null, authorize: () => true };
		const page = () => "<p>page</p>";
		const { app, port, errors } = await testApp({
			kinds: { server: { platform: "node" }, worker: { platform: "node" }, web: { platform: "browser" } },
			web: { entry: join(dir, "main.ts"), page, public: true },
			workers: [worker],
		});
		try {
			const reported = errors as { kind: string; base?: string; error?: Error }[];
			expect(reported.map(({ kind, base }) => `${kind} ${base}`).sort()).toEqual([
				"base_build project",
				"base_build web",
			]);
			expect(reported.every(({ error }) => /Unexpected ";"/.test(String(error?.message)))).toBe(true);
			expect(app.web).toEqual({ base: undefined });
			expect((await send(port, "GET", "/")).status).toBe(503);
			expect((await send(port, "GET", "/_chord/web/base")).status).toBe(503);
			expect((await send(port, "GET", "/_chord/owner")).status).toBe(200);
			const notes = app.host.hold(Notes, { id: "p1" }, context);
			await vi.waitFor(() => expect(notes.state.value.kind).toBe("failed"));
			expect(notes.state.value).toMatchObject({ cause: { error: { message: "worker failed to start" } } });
			notes.release();
		} finally {
			await app.close(context);
		}
	});
});

describe("installs", () => {
	it("installs a plugin from git into the user's root; applying changes loads it", async () => {
		const tools = await tempDir();
		await writeFile(join(tools, "npm.mjs"), "process.exit(0);");
		const repository = await gitRepository(
			"echo",
			{ "package.json": JSON.stringify({ name: "@bob/echo" }), "server.ts": ECHO_SERVER },
			"v1",
		);
		const { app, dataDir } = await testApp({ install: { npmCommand: [process.execPath, join(tools, "npm.mjs")] } });
		expect(await app.plugins.install({ git: repository.url, ref: "v1" }, context)).toEqual(["@bob/echo"]);
		expect(await readdir(join(dataDir, "plugins"))).toEqual(["echo"]);
		expect(app.plugins.state.value.set).toBe(true);
		await app.applyChanges(context);
		expect((await app.host.get(Echo, {}, context)).text.value).toBe("echo");
		await app.close(context);
	});
});

describe("export and import per address", () => {
	it('exports a running worker\'s data without stopping it: the worker packs its own store (decision "App kit naming and export")', async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		const { app } = await testApp({ root, withWorkers: true });
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("before", context);
		const workers = app.workers.get("project")!;
		const state = () =>
			(workers.state.value as Record<string, { status: string; pid?: number } | undefined>)["project|p1"];
		const pid = state()!.pid;
		const exporting = app.exportData(Project({ id: "p1" }), join(base, "p1.tar"), context);
		// The worker goes on meanwhile: a write during the export.
		await notes.write("during", context);
		await exporting;
		expect(state()).toMatchObject({ status: "running", pid });
		expect(notes.text.value).toBe("during");
		await notes.write("after", context);
		await app.importData(join(base, "p1.tar"), Project({ id: "p2" }), context);
		const copy = await app.host.get(Notes, { id: "p2" }, context);
		// One consistent point: before or during, never after.
		expect(["before", "during"]).toContain(copy.text.value);
		copy.release();
		notes.release();
		await app.close(context);
	}, 60_000);

	it("refuses the worker's data object to any principal but the server's", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		const { app } = await testApp({ root, withWorkers: true });
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		const refused = await rejection(
			app.host.root(async (ctx) => ctx.get(HostData, { address: addressParam(Project({ id: "p1" })) }), context, {
				principal: { kind: "owner" },
			}),
		);
		expect(refused).toMatchObject({ code: "forbidden" });
		notes.release();
		await app.close(context);
	}, 60_000);

	it("exports without a worker under its lock: a hold arriving meanwhile starts the worker after it (review M1)", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		const { app, dataDir } = await testApp({ root, withWorkers: true });
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("one", context);
		notes.release();
		const workers = app.workers.get("project")!;
		await workers.stop(Project({ id: "p1" }), context);
		await workers.retry(Project({ id: "p1" }), context);
		// A large file makes the pack take a while.
		const files = join(dataDir, "workers", "project", "project%7Cp1", "files");
		await mkdir(files, { recursive: true });
		await writeFile(join(files, "big.bin"), new Uint8Array(200 * 1024 * 1024));
		const status = () =>
			(workers.state.value as Record<string, { status: string } | undefined>)["project|p1"]?.status;
		expect(status()).toBeUndefined();
		let done = false;
		const exporting = app.exportData(Project({ id: "p1" }), join(base, "p1.tar"), context).then(() => {
			done = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		const holder = app.host.get(Notes, { id: "p1" }, context);
		let heldWhileExporting = false;
		let ranWhileExporting = false;
		while (!done) {
			heldWhileExporting ||= status() === "starting";
			ranWhileExporting ||= status() === "running";
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await exporting;
		const ref = await holder;
		expect([heldWhileExporting, ranWhileExporting]).toEqual([true, false]);
		expect(ref.text.value).toBe("one");
		ref.release();
		await app.close(context);
	}, 60_000);

	it("leaves a failed address failed after an export (recheck N5)", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		let failing = false;
		const { app } = await testApp({
			root,
			workers: [
				{
					kind: Project,
					entry: WORKER_ENTRY,
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: () => {
						if (failing) throw new Error("no start today");
						return {};
					},
					authorize: () => true,
				},
			],
		});
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("kept", context);
		notes.release();
		const workers = app.workers.get("project")!;
		await workers.stop(Project({ id: "p1" }), context);
		await workers.retry(Project({ id: "p1" }), context);
		failing = true;
		const status = () =>
			(workers.state.value as Record<string, { status: string } | undefined>)["project|p1"]?.status;
		const hold = app.host.hold(Notes, { id: "p1" }, context);
		while (status() !== "failed") await new Promise((resolve) => setTimeout(resolve, 5));
		await app.exportData(Project({ id: "p1" }), join(base, "p1.tar"), context);
		expect(status()).toBe("failed");
		hold.release();
		await app.close(context);
	}, 60_000);

	it("round-trips a worker's documents, tables and files; refuses an existing address", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		const { app, dataDir } = await testApp({ root, withWorkers: true });
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("buy milk", context);
		expect(await notes.visit("/", context)).toBe(1);
		const file = await notes.attach("a file of p1", context);
		notes.release();
		const archive = join(base, "p1.tar");
		await app.exportData(Project({ id: "p1" }), archive, context);
		expect((await stat(archive)).mode & 0o777).toBe(0o600);
		await expect(app.importData(archive, Project({ id: "p1" }), context)).rejects.toThrow(
			"has data (its worker runs)",
		);
		await app.importData(archive, Project({ id: "p2" }), context);
		const copy = await app.host.get(Notes, { id: "p2" }, context);
		expect(copy.text.value).toBe("buy milk");
		expect(await copy.visit("/", context)).toBe(2);
		expect(await copy.file(file, context)).toBe("a file of p1");
		expect(await readdir(join(dataDir, "workers", "project"))).toEqual(["project%7Cp1", "project%7Cp2"]);
		copy.release();
		// The exported address goes on: its next hold starts its worker again.
		const again = await app.host.get(Notes, { id: "p1" }, context);
		expect(again.text.value).toBe("buy milk");
		again.release();
		await app.close(context);
		// Another app refuses the archive.
		const other = await testApp({ name: "other-app", withWorkers: true });
		await expect(other.app.importData(archive, Project({ id: "p1" }), context)).rejects.toThrow(
			'an archive of "chord-test", not "other-app"',
		);
		await other.app.close(context);
	}, 60_000);

	it("carries the server's records and rows of the address: copied, refused, replaced and deleted with it", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		await writePlugin(root, "meta", "@test/meta", META_PLUGIN);
		const { app, dataDir } = await testApp({ root, withWorkers: true });
		const meta = await app.host.get(MetaStore, {}, context);
		const notes = await app.host.get(Notes, { id: "p1" }, context);
		await notes.write("buy milk", context);
		notes.release();
		await meta.set({ id: "p1", title: "first", label: "red" }, context);
		const archive = join(base, "p1.tar");
		await app.exportData(Project({ id: "p1" }), archive, context);
		// A copy under p2: the worker's data and the server's, rewritten to p2.
		await app.importData(archive, Project({ id: "p2" }), context);
		expect(await meta.get("p2", context)).toEqual({ title: "first", labels: ["red"] });
		// p3 has server data only: refused by the server, no directory left.
		await meta.set({ id: "p3", title: "other", label: "blue" }, context);
		await expect(app.importData(archive, Project({ id: "p3" }), context)).rejects.toThrow(
			"project|p3 has data in this store",
		);
		expect(await readdir(join(dataDir, "workers", "project"))).toEqual(["project%7Cp1", "project%7Cp2"]);
		// Replaced explicitly: the worker's directory and the server's data.
		await meta.set({ id: "p2", title: "changed", label: "green" }, context);
		await expect(app.importData(archive, Project({ id: "p2" }), context)).rejects.toThrow("exists already");
		await app.importData(archive, Project({ id: "p2" }), context, { existing: "replace" });
		expect(await meta.get("p2", context)).toEqual({ title: "first", labels: ["red"] });
		const copy = await app.host.get(Notes, { id: "p2" }, context);
		expect(copy.text.value).toBe("buy milk");
		copy.release();
		// Deleted: refused while its worker runs; then the directory and the server's data go.
		await expect(app.deleteData(Project({ id: "p2" }), context)).rejects.toThrow("stop its worker first");
		await app.workers.get("project")!.stop(Project({ id: "p2" }), context);
		await app.deleteData(Project({ id: "p2" }), context);
		expect(await meta.get("p2", context)).toEqual({ title: "", labels: [] });
		expect(await readdir(join(dataDir, "workers", "project"))).toEqual(["project%7Cp1"]);
		expect(await meta.get("p1", context)).toEqual({ title: "first", labels: ["red"] });
		meta.release();
		await app.close(context);
	}, 60_000);

	it("orders an import and a delete around the server's one commit: undone before it, kept after an unknown outcome", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "notes", "@test/notes", NOTES_PLUGIN);
		await writePlugin(root, "meta", "@test/meta", META_PLUGIN);
		const { app, dataDir } = await testApp({ root, withWorkers: true });
		const projects = join(dataDir, "workers", "project");
		const textOf = async (id: string) => {
			const notes = await app.host.get(Notes, { id }, context);
			const text = notes.text.value;
			notes.release();
			await app.workers.get("project")!.stop(Project({ id }), context);
			return text;
		};
		for (const id of ["p1", "p2"]) {
			const notes = await app.host.get(Notes, { id }, context);
			await notes.write(`notes of ${id}`, context);
			notes.release();
			await app.workers.get("project")!.stop(Project({ id }), context);
		}
		const archive = join(base, "p1.tar");
		await app.exportData(Project({ id: "p1" }), archive, context);
		const host = app.host as {
			importHostData: typeof app.host.importHostData;
			deleteHostData: typeof app.host.deleteHostData;
		};
		const importHostData = host.importHostData.bind(app.host);
		const deleteHostData = host.deleteHostData.bind(app.host);
		// The server refuses: the renames are undone, the old directory is back, nothing is left beside it.
		host.importHostData = async () => {
			throw invalid("args", "refused by the server");
		};
		await expect(app.importData(archive, Project({ id: "p2" }), context, { existing: "replace" })).rejects.toThrow(
			"refused by the server",
		);
		expect(await readdir(projects)).toEqual(["project%7Cp1", "project%7Cp2"]);
		expect(await textOf("p2")).toBe("notes of p2");
		// An unknown outcome: nothing is undone (the new directory in place, the old one aside), and it says so.
		host.importHostData = async () => {
			throw new ChordError({ code: "unavailable", reason: "storage_failed", message: "store: storage failed" });
		};
		await expect(app.importData(archive, Project({ id: "p2" }), context, { existing: "replace" })).rejects.toThrow(
			"unknown outcome; nothing was undone",
		);
		expect((await readdir(projects)).filter((name) => name.includes(".aside-"))).toHaveLength(1);
		host.importHostData = importHostData;
		expect(await textOf("p2")).toBe("notes of p1");
		// A delete commits on the server first: refused there, the directory stays.
		host.deleteHostData = async () => {
			throw invalid("args", "refused by the server");
		};
		await expect(app.deleteData(Project({ id: "p1" }), context)).rejects.toThrow("refused by the server");
		expect(await readdir(projects)).toContain("project%7Cp1");
		host.deleteHostData = deleteHostData;
		// A directory whose server part is gone already (a crash between the two): a repeated delete removes it.
		await app.host.deleteHostData(Project({ id: "p1" }), context);
		await app.deleteData(Project({ id: "p1" }), context);
		expect(await readdir(projects)).not.toContain("project%7Cp1");
		await app.close(context);
	}, 60_000);
});

/**
 * Runs a start script in `dir` (a child Node process, the script its entry: what the kit scans): `head` at its top, a
 * server started with an empty plugins root (`started`, its reports in `errors`, `until(base)` waiting for the mark),
 * then `body`; what it printed, by line.
 */
async function runStart(dir: string, head: readonly string[], body: readonly string[]): Promise<string[]> {
	await mkdir(join(dir, "plugins"));
	const app = fileURLToPath(new URL("../../../src/node/app/index.ts", import.meta.url));
	const ctx = fileURLToPath(new URL("../../../src/context/index.ts", import.meta.url));
	await writeFile(
		join(dir, "start.ts"),
		[
			`import { closeSync, constants, openSync, writeSync } from "node:fs";`,
			`import { writeFile } from "node:fs/promises";`,
			`import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(ctx)};`,
			`import { startServer } from ${JSON.stringify(app)};`,
			...head,
			"const errors: { kind: string }[] = [];",
			"const until = async (value: boolean) => { while (started.plugins.state.value.base !== value) await new Promise((resolve) => setTimeout(resolve, 20)); };",
			"const started = await startServer({",
			`\tname: "chord-test", dataDir: ${JSON.stringify(join(dir, "data"))}, root: ${JSON.stringify(join(dir, "plugins"))},`,
			'\tapi: { name: "@test/app", versions: ["v1"], modules: { "@test/app/v1": {} } }, kinds: { server: { platform: "node" } },',
			'\tprincipal: { server: { kind: "server" }, owner: { kind: "owner" } }, onError: (error) => errors.push(error),',
			"}, context);",
			...body,
			"await started.close(context);",
		].join("\n"),
	);
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--conditions=source", "--experimental-strip-types", "--no-warnings", join(dir, "start.ts")],
		{ timeout: 30_000 },
	);
	return stdout.trim().split("\n");
}
