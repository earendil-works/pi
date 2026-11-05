// Tests of `startServer` (slice 13 §1, §4, §5): the layout and the start-data object, start and close, a server without
// workers, two worker kinds, `applyChanges`, a required root failing, a worker entry that does not build, the base
// marks (a worker base's inputs among them), and export and import per address (documents, tables and files
// round-trip; an existing address refused).

import { chmod, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { hostKind, local, remote, str, unknown } from "../../../src/contracts/index.ts";
import { addressParam, HostData } from "../../../src/node/app/data.ts";
import { AppInfo } from "../../../src/node/app/index.ts";
import { changesOf, flushed, rejection } from "../../support.ts";
import { send } from "../http/support.ts";
import { gitRepository, writePlugin } from "../plugins/support.ts";
import { ECHO_SERVER, NOTES_PLUGIN, Notes, Project, tempDir, testApp, WORKER_ENTRY } from "./support.ts";

const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });

describe("starting and closing", () => {
	it("lays out the data directory, serves AppInfo and the server's plugins, and closes everything", async () => {
		const { app, dataDir, port } = await testApp({ plugins: { echo: { "server.ts": ECHO_SERVER } } });
		expect((await readdir(dataDir)).sort()).toEqual(["logs", "owner-token", "plugins", "server", "workers"]);
		expect((await readdir(join(dataDir, "server"))).filter((name) => !name.startsWith("."))).toEqual(
			expect.arrayContaining(["cookie-secret", "store.sqlite"]),
		);
		const info = await app.host.get(AppInfo, {}, context);
		expect([info.dataDir.value, info.name.value, info.version.value]).toEqual([dataDir, "chord-test", "v1"]);
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
			"server/store.sqlite",
			"server/cookie-secret",
			"owner-token",
		];
		expect(await Promise.all(paths.map(mode))).toEqual([0o700, 0o700, 0o700, 0o700, 0o700, 0o600, 0o600, 0o600]);
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

	it("rejects when a worker kind's entry does not build, with everything closed", async () => {
		const base = await tempDir();
		await writeFile(join(base, "worker.ts"), "export const broken = ;");
		const worker = { kind: Project, entry: join(base, "worker.ts"), start: () => null, authorize: () => true };
		const dataDir = join(base, "data");
		expect(String(await rejection(testApp({ dataDir, workers: [worker] })))).toContain('Unexpected ";"');
		// Closed: the data directory's lock is free again.
		const { app } = await testApp({ dataDir });
		await app.close(context);
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
	it("marks base for a change of `base`'s files and directories and of a file a worker kind's base was built from", async () => {
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
				await writeFile(changed, "export const changed = 1;");
				await vi.waitFor(() => expect(app.plugins.state.value.base).toBe(true), { timeout: 5_000 });
			} finally {
				await app.close(context);
			}
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
});
