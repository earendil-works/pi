// Where a session runs, from the TUI: `/cd [env:]path` (the web's Relocate), `/new [env:]path` and the New-session
// prompt's environment choice (Tab), with directories from `Envs.listDirectory` as in the web's DirectoryPicker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ConversationView, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui from "../../plugins/chat/tui.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import envsTui from "../../plugins/envs/tui.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui, { SessionsSurface } from "../../plugins/sessions/tui.ts";
import { joinPath, parseLocation } from "../../plugins/sessions/tui-location.ts";
import statusTui from "../../plugins/status/tui.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { hotkeysText, tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { type Cell, poll } from "./helpers.ts";
import { type Stub, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
const SESSION: Session = {
	id: "s",
	cwd: "/work",
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
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};
type Calls = Record<string, unknown[]>;

/** Directories per (env, path) of the fixture; `~` is each machine's home. */
const TREE: Record<string, { path: string; directories: string[] }> = {
	"\0/work": { path: "/work", directories: ["/work/docs", "/work/src", "/work/.git"] },
	"\0/work/src": { path: "/work/src", directories: ["/work/src/lib"] },
	"\0~": { path: "/home/me", directories: [] },
	"gpu\0~": { path: "/home/gpu", directories: ["/home/gpu/data"] },
	"gpu\0/data": { path: "/data", directories: [] },
	"gpu\0/work": { path: "/work", directories: [] },
};

function stubs(calls: Calls, role: "owner" | "guest" = "owner") {
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	let catalog: Cell<Session[]> | undefined;
	const server: Stub[] = [
		[
			Sessions,
			(_input, _principal, self) => {
				const sessions = self.state([SESSION]);
				const defaultCwd = self.state("/work");
				const defaultEnv = self.state(null);
				catalog = sessions;
				if (role === "guest") return { variant: "guest", sessions: sessions };
				return {
					variant: "owner",
					sessions,
					defaultCwd,
					defaultEnv,
					create: (args: { cwd: string; env?: string | null }, ctx: Ctx) => {
						record("create", args);
						const created = {
							...SESSION,
							id: `new-${calls.create?.length}`,
							cwd: args.cwd,
							env: args.env ?? null,
						};
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
					clone: () => {
						throw new Error("not in this test");
					},
					fork: () => {
						throw new Error("not in this test");
					},
					restore: () => {},
				};
			},
		],
		[
			Envs,
			(_input, _principal, self) => {
				record("envsAcquired", true);
				return {
					variant: "owner",
					envs: self.state([{ name: "gpu", config: { type: "ssh", host: "gpu.example" }, sessions: 0 }]),
					failure: self.state(null),
					warm: () => {
						record("warm", true);
					},
					listDirectory: ({ env, path }: { env?: string; path: string }) => {
						record("list", `${env ?? ""}:${path}`);
						const found = TREE[`${env ?? ""}\0${path}`];
						if (!found) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
						const parent = found.path.split("/").slice(0, -1).join("/") || "/";
						return { path: found.path, parent, directories: found.directories, truncated: false };
					},
					list: () => [],
					save: () => {},
					delete: () => {},
					test: () => ({ ok: false, testedAt: 1, error: "x" }),
					acceptHostKey: () => {},
					forgetHostKey: () => {},
					generateKey: () => ({ publicKey: "", identityFile: "" }),
					uploadKey: () => ({ publicKey: "", identityFile: "" }),
					publicKey: () => null,
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
				send: () => ({ submissionId: 1 }),
				stop: () => ({ restored: [] }),
				dequeue: () => ({ text: null }),
				configure: () => {},
				compact: () => ({ taskId: 1 }),
				abortCompaction: () => ({ aborted: 0 }),
				reset: () => {},
				shell: () => ({ shellId: "shell-1" }),
				abortShell: () => ({ aborted: false }),
				dequeueOwn: () => ({ restored: [], skipped: 0 }),
			}),
		],
	];
	return { server, worker, catalog: () => catalog };
}

async function setup(t: { after(fn: () => unknown): void }, role: "owner" | "guest" = "owner") {
	const calls: Calls = {};
	const { server, worker } = stubs(calls, role);
	const setup = await topology(t, {
		server,
		worker,
		facets: [tuiCoreFacet, chatTui, sessionsTui, statusTui, envsTui],
		columns: 100,
		role,
	});
	setup.runtime.navigate("chat", "s");
	await poll(async () => (await setup.screen()).includes("/work • Fixture"));
	return { ...setup, calls };
}

test("parseLocation reads [env:]path as the footer writes it", () => {
	const envs = ["gpu", "local2"];
	assert.deepEqual(parseLocation("gpu:/data", envs, { env: null }), { env: "gpu", path: "/data" });
	assert.deepEqual(parseLocation("gpu:", envs, { env: null }), { env: "gpu", path: "~" });
	assert.deepEqual(parseLocation("/tmp/x", envs, { env: null }), { env: null, path: "/tmp/x" });
	// /cd: no prefix stays in the session's environment, relative to its directory.
	assert.deepEqual(parseLocation("../b/./c", envs, { env: "gpu", cwd: "/srv/a" }), { env: "gpu", path: "/srv/b/c" });
	assert.deepEqual(parseLocation("local:~/p", envs, { env: "gpu", cwd: "/srv" }), { env: null, path: "~/p" });
	// Another environment, or /new: relative to the home directory.
	assert.deepEqual(parseLocation("gpu:rel", envs, { env: null, cwd: "/work" }), { env: "gpu", path: "~/rel" });
	assert.deepEqual(parseLocation("rel", envs, { env: null }), { env: null, path: "~/rel" });
	// One letter is a Windows drive; other unknown names are refused.
	assert.deepEqual(parseLocation("c:/x", envs, { env: null }), { env: null, path: "c:/x" });
	assert.deepEqual(parseLocation("tpu:/x", envs, { env: null }), {
		error: 'Unknown environment "tpu" (/envs lists them)',
	});
	assert.equal(joinPath("C:\\work\\a", "..\\b"), "C:\\work\\b");
	assert.equal(joinPath("/", ".."), "/");
});

test("/cd relocates: folder completion, relative paths, the web's errors, env moves confirmed, footer follows", async (t) => {
	const { screen, send, runtime, calls } = await setup(t);
	// Tab completes folders of the session's directory (`s` → `src/`; `.git` would need a typed dot).
	typed(send, "/cd s");
	// Typing never lists (Enter submits what was typed); Tab does.
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.list, undefined);
	send(TAB);
	await poll(() => runtime.drafts.get("s#1") === "/cd src/");
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 1);
	assert.deepEqual(calls.relocate?.[0], { id: "s", env: null, cwd: "/work/src" });
	await poll(async () => (await screen()).includes("/work/src • Fixture"));
	await poll(() => runtime.notices.some((notice) => notice.text === "Working directory: /work/src"));
	// A missing folder: the server's error text, nothing relocated.
	typed(send, "/cd /nope");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => notice.text.includes("ENOENT: no such file or directory")));
	typed(send, "/cd tpu:/x");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => notice.text.startsWith('Unknown environment "tpu"')));
	assert.equal(calls.relocate?.length, 1);
	// Another environment: the web's note, confirmed; `~` is that machine's home.
	typed(send, "/cd gpu:");
	send(ENTER);
	await poll(async () => (await screen()).includes("Move this session to gpu:~?"));
	assert.match(await screen(), /Tools will run on gpu\. The history stays; files are not copied\./);
	typed(send, "y");
	await poll(() => (calls.relocate?.length ?? 0) === 2);
	assert.deepEqual(calls.relocate?.[1], { id: "s", env: "gpu", cwd: "/home/gpu" });
	await poll(async () => (await screen()).includes("gpu:/home/gpu • Fixture"));
	// Without an argument: the prompt; Tab picks this device (starting at ~), its note is the confirmation.
	typed(send, "/cd");
	send(ENTER);
	await poll(async () => (await screen()).includes("Working directory · on gpu (remote)"));
	send(TAB);
	await poll(async () => (await screen()).includes("Working directory · on this device"));
	assert.match(await screen(), /Tools will run on this device\./);
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 3);
	assert.deepEqual(calls.relocate?.[2], { id: "s", env: null, cwd: "/home/me" });
	assert(calls.warm?.length, "the environments' connections start with the first use");
	// /hotkeys documents the forms, the argument hints and the prompts' Tab.
	const help = hotkeysText(runtime.ctx).join("\n");
	assert.match(help, /Working directory and environment/);
	assert.match(help, /\/cd \[\[env:\]path\]/);
	assert.match(help, /\/new \[\[env:\]path\]/);
	assert.match(help, /next environment/);
});

test("+ New session: Tab cycles this device and the environments; /new [env:]path", async (t) => {
	const { screen, send, runtime, calls } = await setup(t);
	runtime.navigate("sessions");
	await poll(async () => (await screen()).includes("+ New session"));
	runtime.ctx.commands.run("app.session.new");
	// From a session, `/new` without an argument starts over in its env:cwd (pi's /new).
	await poll(() => (calls.create?.length ?? 0) === 1);
	assert.deepEqual(calls.create?.[0], { cwd: "/work", env: null });
	runtime.navigate("sessions", undefined);
	await poll(async () => (await screen()).includes("+ New session"));
	// The prompt: this device first, Tab moves to gpu (at its home), Enter creates there.
	const surface = runtime.ctx.surface("sessions");
	assert(surface instanceof SessionsSurface);
	surface.command("new");
	await poll(async () => (await screen()).includes("New session · on this device"));
	await poll(async () => (await screen()).includes("environment (this device, gpu)"));
	send(TAB);
	await poll(async () => (await screen()).includes("New session · on gpu (remote)"));
	typed(send, "/data");
	send(ENTER);
	await poll(() => (calls.create?.length ?? 0) === 2);
	assert.deepEqual(calls.create?.[1], { cwd: "~/data", env: "gpu" });
	// /new with the footer's form; no prefix is this device, a relative path is below home.
	for (const [argument, expected] of [
		["gpu:/data", { cwd: "/data", env: "gpu" }],
		["/tmp/x", { cwd: "/tmp/x", env: null }],
		["proj", { cwd: "~/proj", env: null }],
	] as const) {
		const before = calls.create?.length ?? 0;
		runtime.ctx.commands.run("app.session.new", argument);
		await poll(() => (calls.create?.length ?? 0) === before + 1);
		assert.deepEqual(calls.create?.at(-1), expected);
	}
});

test("guests cannot change directories and never acquire Envs", async (t) => {
	const { runtime, calls } = await setup(t, "guest");
	assert(!runtime.ctx.commands.run("p2.session.cd", "/tmp"));
	assert(!runtime.ctx.commands.run("app.session.new", "gpu:/data"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.envsAcquired, undefined);
});

test("/envs moves the session: local → gpu (same path there) → local; home when the path is missing; current marked", async (t) => {
	const { screen, send, runtime, calls } = await setup(t);
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";
	runtime.ctx.commands.run("p2.envs");
	await poll(async () => (await screen()).includes("Environments (1)"));
	// The session's environment is marked and selected.
	assert.match(await screen(), /→ ● This device\s+this session/);
	assert.match(await screen(), / {4}gpu {2}gpu\.example/);
	send(DOWN);
	send(ENTER);
	// The directory prompt on gpu: /work exists there, so it stays; the note is the confirmation (as in /cd).
	await poll(async () => (await screen()).includes("Working directory · on gpu (remote)"));
	assert.match(await screen(), /> \/work/);
	assert.match(await screen(), /Tools will run on gpu\. The history stays; files are not copied\./);
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 1);
	assert.deepEqual(calls.relocate?.[0], { id: "s", env: "gpu", cwd: "/work" });
	await poll(async () => (await screen()).includes("gpu:/work • Fixture"));
	// Back to this device: gpu is marked now and selected first.
	runtime.ctx.commands.run("p2.envs");
	await poll(async () => (await screen()).includes("Environments (1)"));
	assert.match(await screen(), /→ ● gpu {2}gpu\.example\s+this session/);
	send(UP);
	send(ENTER);
	await poll(async () => (await screen()).includes("Working directory · on this device"));
	assert.match(await screen(), /Tools will run on this device\./);
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 2);
	assert.deepEqual(calls.relocate?.[1], { id: "s", env: null, cwd: "/work" });
	await poll(async () => /^\/work • Fixture/m.test(await screen()));
	// A directory gpu does not have: the prompt starts at gpu's home; Escape moves nothing.
	typed(send, "/cd src");
	send(ENTER);
	await poll(() => (calls.relocate?.length ?? 0) === 3);
	runtime.ctx.commands.run("p2.envs");
	await poll(async () => (await screen()).includes("Environments (1)"));
	send(DOWN);
	send(ENTER);
	await poll(async () => (await screen()).includes("Working directory · on gpu (remote)"));
	assert.match(await screen(), /> \/home\/gpu/);
	send(ESC);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.relocate?.length, 3);
	// Enter on the session's own environment: the prompt without the moving note (a /cd).
	runtime.ctx.commands.run("p2.envs");
	await poll(async () => (await screen()).includes("Environments (1)"));
	send(ENTER);
	await poll(async () => (await screen()).includes("Working directory · on this device"));
	assert.match(await screen(), /> \/work\/src/);
	assert(!(await screen()).includes("Tools will run"));
	send(ESC);
	// /hotkeys says what Enter does there.
	const help = stripVTControlCharacters(hotkeysText(runtime.ctx).join("\n"));
	assert.match(help, /\/envs\s+Enter moves the session/);
});
