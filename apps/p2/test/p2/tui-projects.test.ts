// Projects in the TUI: the session selector grouped by project (each project's row, its places probed when the
// selector is shown, Enter creating a session in the project at the first reachable place or the one picked with
// left/right, its sessions below it; then "Other"), searches from it, and `/move` (with an environment, or its
// picker) within the viewed session's stored project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConversationView, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui from "../../plugins/chat/tui.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import { type Project, Projects } from "../../plugins/projects/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui, { SessionsSurface } from "../../plugins/sessions/tui.ts";
import { placeFailure } from "../../plugins/sessions/tui-projects.ts";
import statusTui from "../../plugins/status/tui.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { type Cell, poll } from "./helpers.ts";
import { type Stub, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const SESSION: Session = {
	id: "s",
	cwd: "/home/me/projects/pi/pi/apps",
	env: null,
	title: "Fixture",
	createdAt: 1,
	updatedAt: 1,
	archivedAt: null,
	pinned: false,
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off",
	main: 1,
	branches: [],
};
const PROJECTS: Project[] = [
	{
		name: "pi",
		places: [
			{ env: "mac", path: "~/projects/pi/pi" },
			{ env: null, path: "~/projects/pi/pi" },
		],
	},
	{ name: "dead", places: [{ env: "gpu", path: "/srv/dead" }] },
	{
		name: "tri",
		places: [
			{ env: "mac", path: "~/missing" },
			{ env: "nope", path: "~/tri" },
		],
	},
];
/** Other rows of the catalog: one more in pi, one of no project, one of a project projects.json no longer has. */
const ROWS: Session[] = [
	{ ...SESSION, id: "s2", title: "Second pi", cwd: "/home/me/projects/pi/pi", updatedAt: 4 },
	{ ...SESSION, id: "free", title: "Free work", cwd: "/tmp/free", updatedAt: 3 },
	{ ...SESSION, id: "old", title: "Old one", cwd: "/srv/old", updatedAt: 2 },
];
const MEMBERS: Record<string, string> = { s: "pi", s2: "pi", old: "gone" };
const HOMES: Record<string, string> = { "": "/home/me", mac: "/Users/me" };
const unused = () => {
	throw new Error("not in this test");
};
/** Stub members for methods the tests never call. */
const unusedMethods = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, unused]));
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};

/**
 * Owner stubs: `mac` answers once `macGate` resolves and has no `missing` directory; the machines in `down` (gpu at
 * first) are unreachable; `nope` is not configured; `~` is each machine's home. The errors are the ones
 * `Envs.listDirectory` gives (the SSH manager, the pi-env daemon).
 */
function stubs(macGate: Promise<void>, down: Set<string>) {
	const calls: Record<string, unknown[]> = {};
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	let members: Cell<Record<string, string>> | undefined;
	let projects: Cell<Project[]> | undefined;
	const server: Stub[] = [
		[
			Sessions,
			(_input, _principal, self) => {
				const sessions = self.state([SESSION, ...ROWS]);
				return {
					variant: "owner",
					sessions,
					defaultCwd: self.state("~"),
					defaultEnv: self.state(null),
					operations: self.state([]),
					dismissOperation: () => {},
					create: (args: { id: string; cwd: string; env?: string | null }, ctx: Ctx) => {
						record("create", { env: args.env ?? null, cwd: args.cwd });
						const created = { ...SESSION, id: args.id, cwd: args.cwd, env: args.env ?? null };
						sessions.replace(ctx, [...(sessions.value ?? []), created]);
						return created;
					},
					relocate: (args: { id: string; cwd: string; env: string | null }, ctx: Ctx) => {
						record("relocate", args);
						sessions.replace(
							ctx,
							(sessions.value ?? []).map((row) =>
								row.id === args.id ? { ...row, cwd: args.cwd, env: args.env } : row,
							),
						);
					},
					rename: () => {},
					pin: () => {},
					archive: () => {},
					restore: () => {},
					clone: unused,
					fork: unused,
				};
			},
		],
		[
			Envs,
			(_input, _principal, self) => ({
				variant: "owner",
				envs: self.state(
					["mac", "gpu"].map((name) => ({ name, config: { type: "ssh", host: `${name}.example` }, sessions: 0 })),
				),
				failure: self.state(null),
				warm: () => {},
				listDirectory: async ({ env, path }: { env?: string; path: string }) => {
					record("list", `${env ?? ""}:${path}`);
					if (down.has(env ?? "")) throw new Error("connect ECONNREFUSED");
					if (env === "mac") await macGate;
					if (env === "nope") throw new Error('Environment "nope" is not configured');
					const absolute = path.replace(/^~/, HOMES[env ?? ""]!);
					if (env === "mac" && absolute.endsWith("/missing"))
						throw new Error(`ENOENT: no such file or directory, opendir '${absolute}'`);
					return { path: absolute, parent: null, directories: [], truncated: false };
				},
				list: () => [],
				...unusedMethods([
					"save",
					"delete",
					"test",
					"acceptHostKey",
					"forgetHostKey",
					"generateKey",
					"uploadKey",
					"publicKey",
					"sandboxStatus",
					"sandboxStart",
					"sandboxStop",
					"sandboxResetDisk",
				]),
			}),
		],
		[
			Projects,
			(_input, _principal, self) => {
				members = self.state(MEMBERS);
				projects = self.state(PROJECTS);
				const sessions = members;
				return {
					variant: "owner",
					projects,
					failure: self.state(null),
					local: self.state("test-host"),
					sessions,
					assign: (args: { session: string; project: string }, ctx: Ctx) => {
						record("assign", args);
						sessions.replace(ctx, { ...sessions.value, [args.session]: args.project });
					},
				};
			},
		],
	];
	const view: ConversationView = {
		conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
		entries: [],
		docs: {} as ConversationView["docs"],
	};
	const worker: Stub[] = [
		[
			Chat,
			(_input, _principal, self) => ({
				variant: "participant",
				view: self.state(view),
				model: self.state(META),
				liveShell: self.state(null),
				stats: self.state(null),
				entries: () => ({ items: [], more: false }),
				...unusedMethods([
					"send",
					"stop",
					"dequeue",
					"configure",
					"compact",
					"abortCompaction",
					"reset",
					"shell",
					"abortShell",
					"dequeueOwn",
				]),
			}),
		],
	];
	return { server, worker, calls, members: () => members!, projects: () => projects! };
}

async function setup(t: { after(fn: () => unknown): void }) {
	let openMac = () => {};
	const macGate = new Promise<void>((resolve) => {
		openMac = resolve;
	});
	const down = new Set(["gpu"]);
	const { server, worker, calls, members, projects } = stubs(macGate, down);
	const fixture = await topology(t, {
		server,
		worker,
		facets: [tuiCoreFacet, chatTui, sessionsTui, statusTui],
		columns: 100,
	});
	fixture.runtime.navigate("chat", "s");
	await poll(async () => (await fixture.screen()).includes("/home/me/projects/pi/pi/apps • Fixture"));
	/** Moves the selection down until the selected row matches `row`. */
	const select = async (row: RegExp) => {
		await poll(async () => {
			if (row.test(await fixture.screen())) return true;
			fixture.send(DOWN);
			return false;
		});
	};
	return { ...fixture, calls, openMac, down, members, projects, select };
}

test("project rows: places probed on showing the selector; Enter takes the first reachable place, left/right another", async (t) => {
	const { screen, send, runtime, calls, openMac, select } = await setup(t);
	runtime.navigate("sessions");
	// mac is still checking, this device and gpu answered.
	await poll(async () => /› pi {3}mac … {3}test-host ✓/.test(await screen()));
	await poll(async () => /dead {3}gpu ✗/.test(await screen()));
	// The selected row says why a place cannot be used (none yet: mac is checking, this device answered).
	assert.doesNotMatch(await screen(), /test-host:/);
	assert.match(await screen(), /\+ New session/);
	const probes = calls.list?.length ?? 0;
	// Enter waits for mac (preferred), then creates there at its resolved path.
	send(ENTER);
	await poll(async () => (await screen()).includes("Checking pi's places…"));
	openMac();
	await poll(() => (calls.create?.length ?? 0) === 1);
	assert.deepEqual(calls.create?.[0], { env: "mac", cwd: "/Users/me/projects/pi/pi" });
	assert.equal(runtime.screen, "chat");
	// The new session belongs to the project, recorded before its row exists.
	assert.deepEqual(calls.assign, [{ session: runtime.session, project: "pi" }]);
	// Showing the selector again probes every place again; right picks this device.
	runtime.navigate("sessions", "s");
	await poll(() => (calls.list?.length ?? 0) >= probes + 5);
	await poll(async () => /› pi {3}mac ✓ {3}test-host ✓/.test(await screen()));
	send(RIGHT);
	send(ENTER);
	await poll(() => (calls.create?.length ?? 0) === 2);
	assert.deepEqual(calls.create?.[1], { env: null, cwd: "/home/me/projects/pi/pi" });
	// Showing the selector again forgets the pick: left twice from mac comes back to mac.
	runtime.navigate("sessions", "s");
	await poll(async () => /› pi {3}mac ✓ {3}test-host ✓/.test(await screen()));
	send(LEFT);
	send(LEFT);
	send(ENTER);
	await poll(() => (calls.create?.length ?? 0) === 3);
	assert.deepEqual(calls.create?.[2], { env: "mac", cwd: "/Users/me/projects/pi/pi" });
	// No reachable place: the reason under the row, and on Enter; no session.
	runtime.navigate("sessions", "s");
	await poll(async () => /› pi/.test(await screen()));
	await select(/› dead/);
	await poll(async () => /› dead {3}gpu ✗ *\n {4}gpu: connect ECONNREFUSED/.test(await screen()));
	send(ENTER);
	await poll(async () => (await screen()).includes("No reachable place: gpu: connect ECONNREFUSED"));
	assert.equal(calls.create?.length, 3);
	// A machine without the folder (?) and an environment that does not exist (✗) read differently.
	await select(/› tri/);
	await poll(async () =>
		/› tri {3}mac \? {3}nope ✗ *\n {4}mac: no folder ~\/missing · nope: no such environment/.test(await screen()),
	);
	// The grouped list has no scope: Tab does nothing.
	send(TAB);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.match(await screen(), /› tri/);
	assert.doesNotMatch(await screen(), /Resume Session \(|Current Folder|◉/);
});

test("grouped by project: every session under its project, then Other; no scope; a search is flat with Tab's scope", async (t) => {
	const { screen, send, runtime, projects, openMac } = await setup(t);
	// A probe left waiting would hold the teardown: mac answers at once here.
	openMac();
	runtime.navigate("sessions");
	// Every project with its sessions (newest first), then Other: the sessions of no project and the one whose
	// project is gone, dimmed with its old name.
	await poll(async () =>
		/› pi {3}mac ✓ {3}test-host ✓ *\n {6}Second pi.*\n {6}Fixture.*\n {2}dead {3}gpu ✗ *\n {2}tri .*\n {2}Other *\n {6}\+ New session *\n {6}Free work.*\n {6}Old one \(gone\)/.test(
			await screen(),
		),
	);
	// No scope in the header or the hints, and Tab changes nothing.
	assert.match(await screen(), /^Resume Session {2}/m);
	assert.doesNotMatch(await screen(), /Current Folder|◉|tab scope/);
	const before = await screen();
	send(TAB);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(await screen(), before);
	// The project comes back: its session groups again.
	projects().replace(undefined, [...PROJECTS, { name: "gone", places: [{ env: null, path: "/srv/old" }] }]);
	await poll(async () => /gone {3}test-host .*\n {6}Old one {2}/.test(await screen()));
	// A search lists flat, without project rows or groups, over every session; Tab narrows it to the current folder.
	typed(send, "work");
	await poll(async () => /Resume Session \(All\)[\s\S]*› +Free work/.test(await screen()));
	assert.doesNotMatch(await screen(), /Other|\+ New session|test-host/);
	send(TAB);
	await poll(async () => (await screen()).includes("Resume Session (Current Folder)"));
	assert.doesNotMatch(await screen(), /Free work|Other|\+ New session|test-host/);
	// Back to the grouped list: no scope again.
	send("\x1b");
	await poll(async () => /^Resume Session {2}/m.test(await screen()));
	assert.match(await screen(), / {2}Other *\n {6}\+ New session *\n {6}Free work/);
});

test("a failed listing reads as no folder, no such environment or unreachable, from its message", () => {
	const place = { env: "mac", path: "~/x" };
	// The messages Envs.listDirectory gives: this device (Node), an SSH environment (the pi-env daemon, the manager).
	for (const message of [
		"ENOENT: no such file or directory, scandir '/home/me/x'",
		"ENOTDIR: not a directory, scandir '/home/me/x'",
		"ENOENT: no such file or directory, opendir '/Users/me/x'",
		"Working directory is not a directory",
	])
		assert.deepEqual(placeFailure(place, new Error(message)), { kind: "missing", reason: "no folder ~/x" });
	assert.deepEqual(placeFailure(place, new Error('Environment "mac" is not configured')), {
		kind: "unreachable",
		reason: "no such environment",
	});
	const refused = "ssh 127.0.0.1 failed with exit code 255: ssh: connect to host 127.0.0.1 port 9: Connection refused";
	assert.deepEqual(placeFailure(place, new Error(refused)), { kind: "unreachable", reason: refused });
});

test("/move <env> follows the stored project, keeps the subfolder, works while the session's machine is down", async (t) => {
	const { screen, send, runtime, calls, openMac, down, members } = await setup(t);
	openMac();
	// Completion lists the project's places on other machines.
	typed(send, "/move m");
	send(TAB);
	await poll(() => runtime.drafts.get("s#1") === "/move mac");
	send(ENTER);
	await poll(async () => (await screen()).includes("Move this session to mac:/Users/me/projects/pi/pi/apps?"));
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 1);
	assert.deepEqual(calls.relocate?.[0], { id: "s", env: "mac", cwd: "/Users/me/projects/pi/pi/apps" });
	await poll(async () => (await screen()).includes("mac:/Users/me/projects/pi/pi/apps • Fixture"));
	// The Mac goes away: back by this device's label, without asking the Mac anything.
	down.add("mac");
	const listed = calls.list?.length ?? 0;
	typed(send, "/move test-host");
	send(ENTER);
	await poll(async () => (await screen()).includes("Move this session to /home/me/projects/pi/pi/apps?"));
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 2);
	assert.deepEqual(calls.relocate?.[1], { id: "s", env: null, cwd: "/home/me/projects/pi/pi/apps" });
	assert(!calls.list?.slice(listed).some((each) => String(each).startsWith("mac:")));
	await poll(async () => /^\/home\/me\/projects\/pi\/pi\/apps • Fixture/m.test(await screen()));
	for (const [command, notice] of [
		["/move gpu", "Project pi has no place on gpu"],
		["/move mac", "mac is unreachable: connect ECONNREFUSED"],
		["/move local", "The session is already at /home/me/projects/pi/pi/apps"],
	] as const) {
		typed(send, command);
		send(ENTER);
		await poll(() => runtime.notices.some((each) => each.text === notice));
	}
	// A subfolder the target does not have: the target's root, and the notice says so.
	down.delete("mac");
	typed(send, "/cd /home/me/projects/pi/pi/missing");
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 3);
	typed(send, "/move mac");
	send(ENTER);
	await poll(() =>
		runtime.notices.some((each) => each.text === "missing does not exist on mac; moving to the project's root"),
	);
	await poll(async () => (await screen()).includes("Move this session to mac:/Users/me/projects/pi/pi?"));
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 4);
	assert.deepEqual(calls.relocate?.[3], { id: "s", env: "mac", cwd: "/Users/me/projects/pi/pi" });
	// `/cd` outside the project's place keeps the project: `/move` goes to the target place's root.
	typed(send, "/cd /tmp");
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 5);
	typed(send, "/move test-host");
	send(ENTER);
	await poll(async () => (await screen()).includes("Move this session to /home/me/projects/pi/pi?"));
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 6);
	assert.deepEqual(calls.relocate?.[5], { id: "s", env: null, cwd: "/home/me/projects/pi/pi" });
	// No project, or one projects.json no longer has: nothing moves.
	for (const [membership, notice] of [
		[{}, "This session belongs to no project: start one from a project's row in /sessions"],
		[{ s: "gone" }, "Project gone is no longer in projects.json"],
	] as const) {
		members().replace(undefined, membership);
		const surface = runtime.ctx.surface("sessions");
		assert(surface instanceof SessionsSurface);
		await poll(() => surface.projectOf("s") === ("s" in membership ? membership.s : undefined));
		typed(send, "/move mac");
		send(ENTER);
		await poll(() => runtime.notices.some((each) => each.text === notice));
	}
	assert.equal(calls.relocate?.length, 6);
	assert.equal(calls.assign, undefined);
});

test("/move without an argument: a picker of the project's places, the current one marked; only reachable ones move", async (t) => {
	const { screen, send, runtime, calls, openMac, members, projects } = await setup(t);
	openMac();
	projects().replace(undefined, [
		{
			name: "pi",
			places: [
				{ env: "gpu", path: "~/projects/pi/pi" },
				{ env: null, path: "~/projects/pi/pi" },
				{ env: "mac", path: "~/projects/pi/pi" },
			],
		},
	]);
	const surface = runtime.ctx.surface("sessions");
	assert(surface instanceof SessionsSurface);
	await poll(() => surface.projects[0]?.places.length === 3);
	typed(send, "/move");
	send(ENTER);
	// Every place in projects.json's order, this device marked current; the cursor skips gpu (unreachable) for mac.
	await poll(async () =>
		/ {2}✗ gpu {2}~\/projects\/pi\/pi +connect ECONNREFUSED *\n {2}• test-host {2}~\/projects\/pi\/pi +current *\n→ ✓ mac {2}~\/projects\/pi\/pi/.test(
			await screen(),
		),
	);
	assert.match(await screen(), /Move within pi/);
	// An unreachable place cannot be chosen.
	send(UP);
	send(UP);
	send(ENTER);
	await poll(async () => (await screen()).includes("gpu cannot be chosen: only ✓ places are reachable"));
	// The current place only closes the picker.
	send(DOWN);
	send(ENTER);
	await poll(() => runtime.notices.some((each) => each.text === "Already here"));
	await poll(async () => !(await screen()).includes("Move within pi"));
	assert.equal(calls.relocate, undefined);
	// Escape cancels.
	typed(send, "/move");
	send(ENTER);
	await poll(async () => /→ ✓ mac/.test(await screen()));
	send("\x1b");
	await poll(async () => !(await screen()).includes("Move within pi"));
	assert.equal(calls.relocate, undefined);
	// Enter on a reachable place is `/move <it>`: the subfolder kept, the move confirmed.
	typed(send, "/move");
	send(ENTER);
	await poll(async () => /→ ✓ mac/.test(await screen()));
	send(ENTER);
	await poll(async () => (await screen()).includes("Move this session to mac:/Users/me/projects/pi/pi/apps?"));
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 1);
	assert.deepEqual(calls.relocate?.[0], { id: "s", env: "mac", cwd: "/Users/me/projects/pi/pi/apps" });
	// Only the current place, or no project: today's errors, no picker.
	projects().replace(undefined, [{ name: "pi", places: [{ env: "mac", path: "~/projects/pi/pi" }] }]);
	await poll(() => surface.projects[0]?.places.length === 1);
	await poll(async () => (await screen()).includes("mac:/Users/me/projects/pi/pi/apps • Fixture"));
	typed(send, "/move");
	send(ENTER);
	await poll(() => runtime.notices.some((each) => each.text === "Project pi has no place on another machine"));
	members().replace(undefined, {});
	await poll(() => surface.projectOf("s") === undefined);
	typed(send, "/move");
	send(ENTER);
	await poll(() =>
		runtime.notices.some(
			(each) => each.text === "This session belongs to no project: start one from a project's row in /sessions",
		),
	);
	assert(!(await screen()).includes("Move within"));
});
