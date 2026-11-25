// Projects (plugins/projects): projects.json's format (read once, by the import), the paths below a place, the one-time
// import of projects.json and the earlier memberships into the server store's tables (the folder's project for a
// session without one), the owner-only `Projects` with this device's label, and its methods: create, rename (the
// memberships follow), locate, move (positions numbered anew when a gap runs out), assign (null leaves), archive,
// restore and remove (the memberships go), with their refusals; a copy keeps its source's project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { obj, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, defineFacet, defineState, local, method, record, whenLive } from "@p2/app/v1";
import { parseProjects } from "../../plugins/projects/config.ts";
import { below, Projects, placeOn } from "../../plugins/projects/contract.ts";
import { SESSIONS_OWNER, Sessions, type SessionsOwner } from "../../plugins/sessions/contract.ts";
import { type P2Server, startServer } from "../../src/hosts/server.ts";
import type { Ref } from "../../src/runtime/chord.ts";
import { clientHost, expectChord, type Fixture, holdWith, localOwner, startFixture, until } from "./helpers.ts";

const PI = { pi: [{ env: "mac", path: "~/projects/pi/pi" }, { path: "~/projects/pi/pi" }] };

test("projects.json: order kept, a place without env is this device, invalid files say why", () => {
	const projects = parseProjects(
		`// comments and trailing commas, as in the other configuration files
		{ "web": [{ "path": "/srv/web" }], "pi": [{ "env": "mac", "path": "~/projects/pi/pi" }, { "path": "~/projects/pi/pi" },], }`,
	);
	assert.deepEqual(projects, [
		{ name: "web", places: [{ env: null, path: "/srv/web" }] },
		{
			name: "pi",
			places: [
				{ env: "mac", path: "~/projects/pi/pi" },
				{ env: null, path: "~/projects/pi/pi" },
			],
		},
	]);
	assert.deepEqual(parseProjects("{}"), []);
	for (const [content, error] of [
		["{", /syntax/],
		["[]", /must be an object/],
		['{ "pi": [] }', /pi: a list of places/],
		['{ "pi": [{ "env": "mac" }] }', /pi: a place is/],
		['{ "pi": [{ "path": "/a", "host": "x" }] }', /pi: a place is/],
		['{ "pi": [{ "env": "Mac", "path": "/a" }] }', /invalid environment name Mac/],
		['{ "pi": [{ "path": "projects/pi" }] }', /absolute or start with ~/],
		['{ "pi": [{ "env": "mac", "path": "/a" }, { "env": "mac", "path": "/b" }] }', /two places on mac/],
		['{ "pi": [{ "path": "/a" }, { "path": "~/b" }] }', /two places on this device/],
		['{ "": [{ "path": "/a" }] }', /Invalid project name/],
	] as const)
		assert.throws(() => parseProjects(content), error, content);
});

test("a directory's subpath below a place, from the paths alone", () => {
	// `~/rel`: `/rel` at segment boundaries after the (unknown, non-empty) home.
	assert.equal(below("/home/me/projects/pi/pi", "~/projects/pi/pi"), "");
	assert.equal(below("/Users/someone/projects/pi/pi/apps/p2", "~/projects/pi/pi"), "apps/p2");
	assert.equal(below("/home/me/projects/pi/pi2", "~/projects/pi/pi"), undefined);
	assert.equal(below("/home/me/old-projects/pi/pi", "~/projects/pi/pi"), undefined);
	assert.equal(below("/projects/pi/pi", "~/projects/pi/pi"), undefined);
	// Absolute places: the path itself or below it.
	assert.equal(below("/srv/app/src", "/srv/app"), "src");
	assert.equal(below("/srv/app/src", "/srv/app/"), "src");
	assert.equal(below("/srv/application", "/srv/app"), undefined);
	// Windows machines: either separator, the subpath as written there.
	assert.equal(below("C:\\Users\\me\\code\\pi\\src\\lib", "~/code/pi"), "src\\lib");
	assert.equal(below("C:\\work\\pi\\src", "C:\\work\\pi"), "src");
	// `~` contains every directory, its subpath unknown without the home.
	assert.equal(below("/home/me/x", "~"), "");
	assert.equal(below("/a/b", "/a/b/"), "");
	assert.equal(below("/a/bc", "/a/b"), undefined);

	const [pi] = parseProjects(JSON.stringify(PI));
	assert(pi);
	assert.deepEqual(placeOn(pi, "mac", "david-pi"), { env: "mac", path: "~/projects/pi/pi" });
	assert.deepEqual(placeOn(pi, "local", "david-pi"), { env: null, path: "~/projects/pi/pi" });
	assert.deepEqual(placeOn(pi, "David-pi", "david-pi"), { env: null, path: "~/projects/pi/pi" });
	assert.equal(placeOn(pi, "gpu", "david-pi"), undefined);
});

/**
 * The server object the memberships were stored in before the tables (b58642efa's `ProjectService`: its type name and
 * document, which a persisted document is stored under), so a server without the projects plugin can write them as
 * that version did.
 */
const EarlierService = local("p2.project-service", {
	version: 1,
	params: {},
	members: { seed: method(obj({ sessions: record(str()) })) },
});

const EarlierMemberships = defineState("p2.project-sessions", {
	schema: obj({ sessions: record(str()) }),
	version: 1,
	initial: () => ({ sessions: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

const earlierFacet = {
	name: "test.earlier-projects",
	facet: defineFacet((host) => {
		host.serve(EarlierService, (_params, self) => {
			const memberships = self.state(EarlierMemberships);
			return {
				seed: async ({ sessions }, ctx) => {
					await memberships.change((draft) => {
						draft.sessions = sessions;
					}, ctx);
					return null;
				},
			};
		});
	}),
};

/** The plugins of a server as p2 was before the tables: without projects and the plugins that use them. */
const BEFORE = ["chat", "devices", "drafts", "envs", "files", "models", "search", "sessions", "status", "subagents"];

describe("the one-time import", () => {
	it("takes projects.json and the earlier memberships once; a session without one gets its folder's project", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "p2-projects-import-"));
		const dataDir = join(root, "data");
		const ws = join(root, "ws");
		for (const folder of ["pi/src", "web", "other"]) mkdirSync(join(ws, folder), { recursive: true });
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dataDir, "projects.json"),
			JSON.stringify({ pi: [{ path: join(ws, "pi") }], web: [{ path: join(ws, "web") }] }),
		);
		let server: P2Server | undefined;
		t.after(async () => {
			await server?.close();
			rmSync(root, { recursive: true, force: true });
		});
		const start = async (plugins?: readonly string[]) => {
			server = await startServer({
				dataDir,
				port: 0,
				fake: true,
				web: false,
				...(plugins === undefined ? {} : { plugins, facets: [earlierFacet] }),
			});
			return clientHost(await localOwner(server));
		};
		const stop = async (client: Awaited<ReturnType<typeof start>>) => {
			await client.close(BACKGROUND_CONTEXT);
			await server?.close();
			server = undefined;
		};

		// p2 before the store: sessions, and memberships in the earlier document.
		let client = await start(BEFORE);
		const before = await holdWith(client, Sessions, {}, ...SESSIONS_OWNER);
		const create = async (cwd: string) =>
			(await before.create({ cwd: join(ws, cwd), title: cwd }, BACKGROUND_CONTEXT)).id;
		const inPi = await create("pi/src");
		const joined = await create("web");
		const goneJoined = await create("other");
		const goneInWeb = await create("web");
		const outside = await create("other");
		const earlier = server!.host.hold(EarlierService, {}, BACKGROUND_CONTEXT);
		await whenLive(earlier);
		// "gone" is in no projects.json any more: its sessions go by their folders.
		await earlier.seed(
			{ sessions: { [joined]: "pi", [goneJoined]: "gone", [goneInWeb]: "gone" } },
			BACKGROUND_CONTEXT,
		);
		earlier.release();
		await stop(client);

		client = await start();
		let projects = await holdWith(client, Projects, {});
		const imported = await until(projects.sessions, (map) => Object.keys(map ?? {}).length > 0);
		assert.deepEqual(imported, { [inPi]: "pi", [joined]: "pi", [goneInWeb]: "web" });
		assert.deepEqual(await until(projects.projects, (list) => list !== undefined), [
			{ name: "pi", places: [{ env: null, path: join(ws, "pi") }] },
			{ name: "web", places: [{ env: null, path: join(ws, "web") }] },
		]);
		assert.deepEqual(await until(projects.archived, (list) => list !== undefined), []);
		assert.equal(outside in imported, false);
		// After the import a session joins a project only when the owner puts it there, wherever it works.
		const sessions = await holdWith(client, Sessions, {}, ...SESSIONS_OWNER);
		const later = (await sessions.create({ cwd: join(ws, "pi"), title: "Later" }, BACKGROUND_CONTEXT)).id;
		await projects.rename({ name: "web", to: "site" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.[1]?.name === "site");
		assert.equal(projects.sessions.value?.[later], undefined);
		await stop(client);

		// The store is the projects' home now: projects.json is never read again, nor written.
		writeFileSync(join(dataDir, "projects.json"), JSON.stringify({ other: [{ path: join(ws, "other") }] }));
		client = await start();
		projects = await holdWith(client, Projects, {});
		assert.deepEqual(
			(await until(projects.projects, (list) => list !== undefined)).map((project) => project.name),
			["pi", "site"],
		);
		assert.deepEqual(projects.sessions.value, { [inPi]: "pi", [joined]: "pi", [goneInWeb]: "site" });
		await stop(client);
	});

	it("imports nothing from an invalid projects.json", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "p2-projects-invalid-"));
		const dataDir = join(root, "data");
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dataDir, "projects.json"), '{ "pi": [{ "path": "relative" }] }');
		const server = await startServer({ dataDir, port: 0, fake: true, web: false });
		const client = clientHost(await localOwner(server));
		t.after(async () => {
			await client.close(BACKGROUND_CONTEXT);
			await server.close();
			rmSync(root, { recursive: true, force: true });
		});
		const projects = await holdWith(client, Projects, {});
		assert.deepEqual(await until(projects.projects, (list) => list !== undefined), []);
		// The owner starts over from the web: the store takes projects at once.
		await projects.create({ name: "pi", place: { env: null, path: "/pi" } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.[0]?.name === "pi");
	});
});

describe("Projects", () => {
	let fixture: Fixture;
	let projects: Ref<typeof Projects>;
	let sessions: SessionsOwner;
	const names = (list: readonly { name: string }[] | undefined) => list?.map((project) => project.name).join();

	before(async () => {
		fixture = await startFixture();
		const owner = fixture.browser();
		projects = await holdWith(owner, Projects, {});
		sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
	});
	after(() => fixture?.close());

	it("is owner-only and names this device by its hostname", async () => {
		assert.equal(await until(projects.local, (label) => label !== undefined), hostname());
		assert.deepEqual(await until(projects.projects, (list) => list !== undefined), []);
		const guest = fixture
			.as({ kind: "guest", id: "guest", name: "Guest", home: "unknown", sessions: { unknown: "full" }, revision: 1 })
			.hold(Projects, {}, BACKGROUND_CONTEXT);
		await expectChord(whenLive(guest), "forbidden");
		guest.release();
	});

	it("create: a project after the others, refused for a taken name, a bad name or a bad place", async () => {
		await projects.create({ name: " pi ", place: { env: null, path: "/w/pi" } }, BACKGROUND_CONTEXT);
		await projects.create({ name: "web", place: { env: null, path: " /w/web " } }, BACKGROUND_CONTEXT);
		await projects.create({ name: "gpu-app", place: { env: "gpu", path: "~/app" } }, BACKGROUND_CONTEXT);
		const list = await until(projects.projects, (value) => value?.length === 3);
		assert.deepEqual(list, [
			{ name: "pi", places: [{ env: null, path: "/w/pi" }] },
			{ name: "web", places: [{ env: null, path: "/w/web" }] },
			{ name: "gpu-app", places: [{ env: "gpu", path: "~/app" }] },
		]);
		for (const [name, place, error] of [
			["pi", { env: null, path: "/a" }, /A project "pi" exists already/],
			[" pi", { env: null, path: "/a" }, /A project "pi" exists already/],
			["rel", { env: null, path: "relative" }, /absolute or start with ~/],
			["bad-env", { env: "Mac", path: "/a" }, /invalid environment name Mac/],
			["  ", { env: null, path: "/a" }, /Invalid project name/],
			["ctl\u0001", { env: null, path: "/a" }, /Invalid project name/],
		] as const)
			await assert.rejects(projects.create({ name, place }, BACKGROUND_CONTEXT), error, name);
		assert.equal(names(projects.projects.value), "pi,web,gpu-app");
	});

	it("move: before another project, or (null) to the end; refused for an unknown project", async () => {
		await projects.move({ name: "gpu-app", before: "pi" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "gpu-app,pi,web");
		await projects.move({ name: "gpu-app", before: null }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,web,gpu-app");
		await projects.move({ name: "web", before: "web" }, BACKGROUND_CONTEXT);
		await projects.move({ name: "web", before: "pi" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "web,pi,gpu-app");
		await assert.rejects(projects.move({ name: "nope", before: null }, BACKGROUND_CONTEXT), /No project "nope"/);
		await assert.rejects(projects.move({ name: "web", before: "nope" }, BACKGROUND_CONTEXT), /No project "nope"/);
		await projects.move({ name: "web", before: "gpu-app" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,web,gpu-app");
	});

	it("move: many moves into one spot keep the order (positions numbered anew when the gap runs out)", async () => {
		const extra = Array.from({ length: 14 }, (_, index) => `m${index}`);
		for (const name of extra)
			await projects.create({ name, place: { env: null, path: `/w/${name}` } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.length === 3 + extra.length);
		// Each lands right before "web", after the one moved before it: the gap there halves every time.
		const moved = extra.slice(1);
		for (const name of moved) await projects.move({ name, before: "web" }, BACKGROUND_CONTEXT);
		const expected = ["pi", ...moved, "web", "gpu-app", "m0"].join();
		assert.equal(names(await until(projects.projects, (list) => names(list) === expected)), expected);
		// And to the front, repeatedly: each before the first.
		for (const name of ["m3", "m2", "m1"]) {
			const first = projects.projects.value?.[0]?.name ?? null;
			await projects.move({ name, before: first }, BACKGROUND_CONTEXT);
			await until(projects.projects, (list) => list?.[0]?.name === name);
		}
		assert.equal(names(projects.projects.value)?.split(",").slice(0, 4).join(), "m1,m2,m3,pi");
		for (const name of extra) await projects.remove({ name }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,web,gpu-app");
	});

	it("locate: the place becomes the default (first), replacing that machine's place", async () => {
		await projects.locate({ name: "pi", place: { env: "gpu", path: "~/pi" } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.[0]?.places.length === 2);
		assert.deepEqual(projects.projects.value?.[0]?.places, [
			{ env: "gpu", path: "~/pi" },
			{ env: null, path: "/w/pi" },
		]);
		await projects.locate({ name: "pi", place: { env: null, path: "/w/pi2" } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => list?.[0]?.places[0]?.path === "/w/pi2");
		assert.deepEqual(projects.projects.value?.[0]?.places, [
			{ env: null, path: "/w/pi2" },
			{ env: "gpu", path: "~/pi" },
		]);
		await assert.rejects(
			projects.locate({ name: "pi", place: { env: null, path: "rel" } }, BACKGROUND_CONTEXT),
			/absolute or start with ~/,
		);
		await assert.rejects(
			projects.locate({ name: "nope", place: { env: null, path: "/a" } }, BACKGROUND_CONTEXT),
			/No project "nope"/,
		);
	});

	it("assign: to a live project, or (null) to none; a copy keeps its source's project; the catalog is untouched", async () => {
		const id = randomUUID();
		// A membership may come before the session (the new-session screen assigns as it creates).
		await projects.assign({ session: id, project: "pi" }, BACKGROUND_CONTEXT);
		await assert.rejects(projects.assign({ session: id, project: "nope" }, BACKGROUND_CONTEXT), /No project "nope"/);
		const source = await sessions.create({ id, cwd: fixture.workspace, title: "In pi" }, BACKGROUND_CONTEXT);
		const other = await sessions.create({ cwd: fixture.workspace, title: "Free" }, BACKGROUND_CONTEXT);
		// A clone (and a fork: the same path, `SessionCopied`) belongs to its source's project; others to none.
		const copy = await sessions.clone({ id: source.id }, BACKGROUND_CONTEXT);
		const plain = await sessions.clone({ id: other.id }, BACKGROUND_CONTEXT);
		const members = await until(projects.sessions, (map) => map?.[copy.id] === "pi");
		assert.deepEqual(members, { [source.id]: "pi", [copy.id]: "pi" });
		assert.equal(members?.[plain.id], undefined);
		assert(!("project" in (sessions.sessions.value?.find((row) => row.id === id) ?? {})));
		await projects.assign({ session: copy.id, project: "web" }, BACKGROUND_CONTEXT);
		await projects.assign({ session: other.id, project: null }, BACKGROUND_CONTEXT);
		await projects.assign({ session: source.id, project: null }, BACKGROUND_CONTEXT);
		assert.deepEqual(await until(projects.sessions, (map) => map?.[source.id] === undefined), { [copy.id]: "web" });
	});

	it("rename: the sessions follow; refused for an unknown project or a taken name", async () => {
		const id = (await sessions.create({ cwd: fixture.workspace, title: "Web" }, BACKGROUND_CONTEXT)).id;
		await projects.assign({ session: id, project: "web" }, BACKGROUND_CONTEXT);
		await projects.rename({ name: "web", to: " site " }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,site,gpu-app");
		const members = await until(projects.sessions, (map) => map?.[id] === "site");
		assert(!Object.values(members).includes("web"));
		// The same name (trimmed) is no clash.
		await projects.rename({ name: "site", to: "site" }, BACKGROUND_CONTEXT);
		await assert.rejects(projects.rename({ name: "site", to: "pi" }, BACKGROUND_CONTEXT), /"pi" exists already/);
		await assert.rejects(projects.rename({ name: "nope", to: "x" }, BACKGROUND_CONTEXT), /No project "nope"/);
		await assert.rejects(projects.rename({ name: "site", to: "  " }, BACKGROUND_CONTEXT), /Invalid project name/);
		assert.equal(names(projects.projects.value), "pi,site,gpu-app");
	});

	it("archive: the project and its live sessions; restore brings back those, after the live projects", async () => {
		const live = (id: string) => sessions.sessions.value?.find((row) => row.id === id)?.archivedAt === null;
		const create = async (title: string) => {
			const { id } = await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT);
			await projects.assign({ session: id, project: "gpu-app" }, BACKGROUND_CONTEXT);
			return id;
		};
		const first = await create("App one");
		const second = await create("App two");
		const before = await create("Archived before");
		await sessions.archive({ id: before }, BACKGROUND_CONTEXT);
		const elsewhere = (await sessions.create({ cwd: fixture.workspace, title: "Not in it" }, BACKGROUND_CONTEXT)).id;
		await until(sessions.sessions, (rows) => !live(before) && Boolean(rows?.some((row) => row.id === elsewhere)));
		await projects.move({ name: "gpu-app", before: "pi" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "gpu-app,pi,site");

		const archivedAt = Date.now();
		await projects.archive({ name: "gpu-app" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,site");
		const [archived] = await until(projects.archived, (list) => list?.length === 1);
		assert.deepEqual([archived?.name, archived?.places], ["gpu-app", [{ env: "gpu", path: "~/app" }]]);
		assert(archived!.archivedAt >= archivedAt);
		await until(sessions.sessions, () => !live(first) && !live(second));
		assert(live(elsewhere));
		// Its sessions keep their membership, for the restore; nothing may join or move it meanwhile.
		assert.deepEqual(
			[first, second, before].map((id) => projects.sessions.value?.[id]),
			["gpu-app", "gpu-app", "gpu-app"],
		);
		await assert.rejects(
			projects.assign({ session: elsewhere, project: "gpu-app" }, BACKGROUND_CONTEXT),
			/Project "gpu-app" is archived/,
		);
		await assert.rejects(projects.move({ name: "gpu-app", before: null }, BACKGROUND_CONTEXT), /is archived/);
		await assert.rejects(projects.archive({ name: "gpu-app" }, BACKGROUND_CONTEXT), /is archived/);
		// A new project may not take its name: it still exists.
		await assert.rejects(
			projects.create({ name: "gpu-app", place: { env: null, path: "/a" } }, BACKGROUND_CONTEXT),
			/exists already/,
		);

		await projects.restore({ name: "gpu-app" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,site,gpu-app");
		assert.deepEqual(await until(projects.archived, (list) => list?.length === 0), []);
		await until(sessions.sessions, () => live(first) && live(second));
		// The one archived on its own before stays in the Archive.
		assert(!live(before));
		// A restore of a live project changes nothing.
		await projects.restore({ name: "gpu-app" }, BACKGROUND_CONTEXT);
		await assert.rejects(projects.restore({ name: "nope" }, BACKGROUND_CONTEXT), /No project "nope"/);
	});

	it("remove: deletes a live or archived project; its sessions belong to none and stay", async () => {
		const ids = Object.entries(projects.sessions.value ?? {})
			.filter(([, project]) => project === "gpu-app")
			.map(([id]) => id);
		assert.equal(ids.length, 3);
		await projects.remove({ name: "gpu-app" }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => names(list) === "pi,site");
		const members = await until(projects.sessions, (map) => !Object.values(map ?? {}).includes("gpu-app"));
		for (const id of ids) {
			assert.equal(members[id], undefined);
			assert(sessions.sessions.value?.some((row) => row.id === id));
		}
		const { id } = await sessions.create({ cwd: fixture.workspace, title: "Site" }, BACKGROUND_CONTEXT);
		await projects.assign({ session: id, project: "site" }, BACKGROUND_CONTEXT);
		await projects.archive({ name: "site" }, BACKGROUND_CONTEXT);
		await until(projects.archived, (list) => list?.[0]?.name === "site");
		await projects.remove({ name: "site" }, BACKGROUND_CONTEXT);
		await until(projects.archived, (list) => list?.length === 0);
		assert.equal(names(projects.projects.value), "pi");
		assert.equal((await until(projects.sessions, (map) => map?.[id] === undefined))[id], undefined);
		// Its session stays archived, in the Archive on its own.
		assert.notEqual(sessions.sessions.value?.find((row) => row.id === id)?.archivedAt, null);
		await assert.rejects(projects.remove({ name: "site" }, BACKGROUND_CONTEXT), /No project "site"/);
	});
});
