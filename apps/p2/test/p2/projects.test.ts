// Projects (`projects.json`): parsing and validation, the observed file keeping its last valid state, the owner-only
// `Projects` with this device's label, and finding a session's project and a project's place on a machine.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { parseProjects } from "../../plugins/projects/config.ts";
import { below, Projects, placeOn } from "../../plugins/projects/contract.ts";
import { ProjectStore } from "../../plugins/projects/store.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { expectChord, holdIn, poll, startFixture, until } from "./helpers.ts";

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

test("the observed projects.json keeps its last valid state and says why a save failed", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-projects-"));
	const store = new ProjectStore(directory);
	t.after(async () => {
		await store.observer.close();
		rmSync(directory, { recursive: true, force: true });
	});
	// Read through a function: an assertion on `store.snapshot` would narrow its later reads.
	const snapshot = () => store.snapshot;
	await store.observer.start();
	assert.deepEqual(snapshot(), { projects: [], error: null });
	await writeFile(join(directory, "projects.json"), JSON.stringify(PI));
	await poll(() => snapshot().projects.length === 1);
	await writeFile(join(directory, "projects.json"), '{ "pi": [{ "path": "relative" }] }');
	await poll(() => Boolean(snapshot().error));
	assert.match(snapshot().error ?? "", /^Could not load projects\.json \(Project pi: the path must be absolute/);
	assert.equal(snapshot().projects[0]?.name, "pi");
	assert.equal(snapshot().projects[0]?.places.length, 2);
});

test("Projects is owner-only, follows projects.json and names this device by its hostname", async (t) => {
	const fixture = await startFixture({ plugins: ["devices", "projects"] });
	t.after(() => fixture.close());
	const projects = fixture.browser().hold(Projects, {}, BACKGROUND_CONTEXT);
	await whenLive(projects);
	assert(projects.variant === "owner");
	assert.equal(await until(projects.local, (label) => label !== undefined), hostname());
	assert.deepEqual(await until(projects.projects, (list) => list !== undefined), []);
	await writeFile(join(fixture.dataDir, "projects.json"), JSON.stringify(PI));
	await until(projects.projects, (list) => list?.[0]?.places[1]?.env === null);
	await writeFile(join(fixture.dataDir, "projects.json"), "{");
	await until(projects.failure, (failure) => Boolean(failure));
	assert.equal(projects.projects.value?.[0]?.name, "pi");
	await writeFile(join(fixture.dataDir, "projects.json"), "{}");
	await until(projects.failure, (failure) => failure === null);
	assert.deepEqual(projects.projects.value, []);
	const guest = fixture
		.as({ kind: "guest", id: "guest", name: "Guest", home: "unknown", sessions: { unknown: "full" }, revision: 1 })
		.hold(Projects, {}, BACKGROUND_CONTEXT);
	await expectChord(whenLive(guest), "forbidden");
	guest.release();
});

test("membership: assigned to projects.json's projects only, followed by copies, kept when the project goes", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	await writeFile(join(fixture.dataDir, "projects.json"), JSON.stringify(PI));
	const owner = fixture.browser();
	const projects = await holdIn(owner, Projects, {}, "owner");
	await until(projects.projects, (list) => list?.length === 1);
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const id = randomUUID();
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
	// The session catalog is untouched: rows have no project.
	assert(!("project" in (sessions.sessions.value?.find((row) => row.id === id) ?? {})));
	// A project gone from projects.json keeps its members' names.
	await writeFile(join(fixture.dataDir, "projects.json"), "{}");
	await until(projects.projects, (list) => list?.length === 0);
	assert.equal(projects.sessions.value?.[source.id], "pi");
});
