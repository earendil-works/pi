// Which project a place belongs to (plugins/projects/place.ts: the sidebar's project groups): a session's membership
// first, else the closest place on its machine that holds the folder.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project } from "../../plugins/projects/contract.ts";
import { projectAt } from "../../plugins/projects/place.ts";

const MONO: Project = { name: "mono", places: [{ env: null, path: "/w" }] };
const WEB: Project = { name: "web", places: [{ env: null, path: "/w/web" }] };
const REMOTE: Project = {
	name: "remote",
	places: [
		{ env: "gpu", path: "~/remote" },
		{ env: null, path: "/x/remote" },
	],
};
const HOME: Project = { name: "home", places: [{ env: null, path: "~" }] };
const PROJECTS = [MONO, WEB, REMOTE, HOME, { name: "nowhere", places: [] }];

const nameAt = (env: string | null, cwd: string, member?: string) => projectAt(PROJECTS, env, cwd, member)?.name;

describe("projectAt", () => {
	it("is the project a session joined, wherever it works", () => {
		assert.equal(nameAt(null, "/w/web/src", "remote"), "remote");
		assert.equal(nameAt("box", "/tmp", "nowhere"), "nowhere");
	});

	it("is the project whose place on that machine holds the folder most closely, in any order of projects", () => {
		assert.equal(nameAt(null, "/w/web/src"), "web");
		assert.equal(projectAt([WEB, MONO], null, "/w/web/src")?.name, "web");
		assert.equal(nameAt(null, "/w/api"), "mono");
		// A place at the home folder holds every folder of its machine, after every absolute place.
		assert.equal(nameAt(null, "/elsewhere"), "home");
	});

	it("matches a place of the folder's machine only: a remote `~/…` place by its path below some home", () => {
		assert.equal(nameAt("gpu", "/home/ck/remote/src"), "remote");
		assert.equal(nameAt("gpu", "/home/ck/other"), undefined);
		assert.equal(nameAt("box", "/w/web"), undefined);
		// A joined name that no project has falls back to the folder.
		assert.equal(nameAt(null, "/x/remote", "gone"), "remote");
	});
});
