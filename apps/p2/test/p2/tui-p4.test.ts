// P4 of p2-tui-port.md: the TUI on the P3 contracts. Model and thinking selection (owner; guests read-only), scoped
// model cycling, the session selector with the section 1.17 adaptations, /new, /name, /session, compaction controls,
// /new-context, Alt+Up restore-own, and closing overlays cleanly across a reload.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { num } from "@earendil-works/pi-schema";
import { stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { forbidden, remote } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui from "../../plugins/chat/tui.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import modelsTui from "../../plugins/models/tui.ts";
import { portsRenderers } from "../../plugins/ports/tui.ts";
import { Search, SessionReads } from "../../plugins/search/contract.ts";
import searchTui from "../../plugins/search/tui.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui from "../../plugins/sessions/tui.ts";
import { SessionMetrics, SessionStatus } from "../../plugins/status/contract.ts";
import statusTui from "../../plugins/status/tui.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import subagentsTui from "../../plugins/subagents/tui.ts";
import { type Ctx, serverHost } from "../../src/runtime/chord.ts";
import { TuiRuntime, TuiScope } from "../../src/runtime/tui.ts";
import { ToolExecutionComponent } from "../../src/tui/components/tool-execution.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { restoreRuntime, snapshotRuntime } from "../../src/tui/snapshot.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";
import { type Cell, poll } from "./helpers.ts";
import { type Stub, topology } from "./tui-fixture.ts";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_S = "\x13";
const CTRL_A = "\x01";
const CTRL_D = "\x04";
const CTRL_R = "\x12";
const ALT_P = "\x1bp";
const CTRL_P = "\x10";
const SHIFT_TAB = "\x1b[Z";
const ALT_UP = "\x1b[1;3A";

const session = (id: string, patch: Partial<Session> = {}): Session => ({
	id,
	cwd: "/work",
	title: `Title ${id}`,
	createdAt: 1,
	updatedAt: Date.now() - 60_000,
	archivedAt: null,
	pinned: false,
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off",
	main: 1,
	branches: [],
	...patch,
});
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux one",
	contextWindow: 1000,
	reasoning: true,
	thinkingLevels: ["off", "low", "high"],
};
const viewOf = (entries: EntryRecord[] = [], docs: Record<string, unknown> = {}): ConversationView => ({
	conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
	entries,
	docs: {
		"pi.agent": { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" },
		...docs,
	} as ConversationView["docs"],
});

type Calls = Record<string, unknown[]>;

/** Server and worker stubs that record every call; `sessions` is the catalog the owner sees. */
function stubs(calls: Calls, sessions: Session[], options: { view?: ConversationView; owner?: boolean } = {}) {
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	let catalog: Cell<Session[]> | undefined;
	const update = (ctx: Ctx, id: string, patch: Partial<Session>) =>
		catalog?.replace(
			ctx,
			(catalog.value ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row)),
		);
	const server: Stub[] = [
		[
			Sessions,
			(_input, _principal, self) => {
				const sessionsState = self.state(sessions);
				const defaultCwd = self.state("/work");
				const defaultEnv = self.state(null);
				catalog = sessionsState;
				if (options.owner === false) return { variant: "guest", sessions: sessionsState };
				return {
					variant: "owner",
					sessions: sessionsState,
					defaultCwd,
					defaultEnv,
					operations: self.state([]),
					dismissOperation: () => {},
					create: (args: { id: string; cwd: string }, ctx: Ctx) => {
						const { id, ...location } = args;
						record("create", location);
						record("created", id);
						const created = session(id, {
							cwd: args.cwd,
							updatedAt: Date.now(),
						});
						sessionsState.replace(ctx, [...(sessionsState.value ?? []), created]);
						return created;
					},
					relocate: () => {},
					rename: (args: { id: string; title: string }, ctx: Ctx) => {
						record("rename", args);
						update(ctx, args.id, { title: args.title });
					},
					pin: (args: { id: string; pinned: boolean }, ctx: Ctx) => {
						record("pin", args);
						update(ctx, args.id, { pinned: args.pinned });
					},
					archive: (args: { id: string }, ctx: Ctx) => {
						record("archive", args);
						update(ctx, args.id, { archivedAt: Date.now() });
					},
					clone: () => {
						throw new Error("not in this test");
					},
					fork: () => {
						throw new Error("not in this test");
					},
					restore: (args: { id: string }, ctx: Ctx) => {
						record("restore", args);
						update(ctx, args.id, { archivedAt: null });
					},
				};
			},
		],
		[
			Models,
			(_input, _principal, self) => {
				// As the real server (plugins/models/server.ts): the catalog is the owner's.
				record("models", null);
				if (options.owner === false) throw forbidden("models are owner-only");
				return {
					variant: "owner",
					models: self.state([
						{
							provider: "faux",
							modelId: "faux-1",
							name: "Faux one",
							thinkingLevels: ["off", "low", "high"],
							contextWindow: 1000,
						},
						{
							provider: "faux",
							modelId: "faux-2",
							name: "Faux two",
							thinkingLevels: ["off"],
							contextWindow: 2000,
						},
					]),
					resources: self.state({
						version: 1,
						settings: {},
						credentials: [],
						providers: [],
						models: [],
						errors: [],
					}),
					defaultModel: self.state({
						provider: "faux",
						modelId: "faux-1",
						thinkingLevel: "off",
					}),
					errors: self.state([]),
					enabledModels: self.state(["faux-2:low", "faux-1"]),
					scopedModels: self.state([
						{ provider: "faux", modelId: "faux-2", thinkingLevel: "low" },
						{ provider: "faux", modelId: "faux-1" },
					]),
					setDefault: (args: unknown) => {
						record("setDefault", args);
					},
					setEnabledModels: (args: unknown) => {
						record("setEnabledModels", args);
					},
				};
			},
		],
		[
			Subagents,
			(_input, _principal, self) => ({
				variant: "reader",
				children: self.state({
					s1: [
						{
							name: "helper",
							conversationId: 2,
							model: "faux/faux-1",
							thinkingLevel: "off",
							tools: [],
							lastEntryId: 1,
						},
					],
				}),
			}),
		],
		[
			Search,
			(_input, _principal, self) => ({
				variant: "owner",
				rebuilds: self.state([]),
				search: ({ query }: { query: string }) => ({
					sessions: [],
					messages: [
						{
							session: "s2",
							conversationId: 1,
							entryId: 1,
							role: "user" as const,
							text: `a ${query} in text`,
							title: "Title s2",
						},
					],
				}),
				rebuildIndex: () => {},
			}),
		],
		[
			// s1 works in its root and in its subagent's conversation; s3's worker failed; s2 has an unread answer.
			SessionStatus,
			(_input, _principal, self) => ({
				variant: "reader",
				statuses: self.state({
					s1: { running: true, tasks: 2, busy: [1, 2] },
					s3: { running: false, tasks: 0, busy: [], error: "spawn failed" },
				}),
			}),
		],
		[
			SessionReads,
			(_input, _principal, self) => ({
				variant: "owner",
				answers: self.state({ s2: 5 }),
				reads: self.state({ s2: 3 }),
				markRead: (args: unknown) => {
					record("markRead", args);
				},
			}),
		],
		[
			SessionMetrics,
			(_input, _principal, self) => ({
				variant: "reader",
				clients: self.state(2),
				usage: self.state(null),
			}),
		],
	];
	const worker: Stub[] = [
		[
			Chat,
			(_input, _principal, self) => ({
				variant: "participant",
				view: self.state(options.view ?? viewOf()),
				model: self.state(META),
				liveShell: self.state(null),
				stats: self.state({ contextTokens: 100 }),
				entries: () => ({ items: [], more: false }),
				send: (args: unknown) => {
					record("send", args);
					return { submissionId: 1 };
				},
				stop: () => {
					record("stop", null);
					return { restored: [] };
				},
				dequeue: () => ({ text: null }),
				configure: (args: unknown) => {
					record("configure", args);
				},
				compact: (args: unknown) => {
					record("compact", args);
					return { taskId: 9 };
				},
				abortCompaction: () => {
					record("abortCompaction", null);
					return { aborted: 1 };
				},
				reset: (args: unknown) => {
					record("reset", args);
				},
				shell: () => ({ shellId: "shell-1" }),
				abortShell: () => ({ aborted: false }),
				dequeueOwn: () => {
					record("dequeueOwn", null);
					return { restored: ["first queued", "second queued"], skipped: 1 };
				},
			}),
		],
		[
			Drafts,
			(_input, _principal, self) => ({
				variant: "author",
				drafts: self.state([]),
				claim: () => ({ texts: [] }),
			}),
		],
	];
	return { server, worker };
}

async function setup(
	t: { after(fn: () => unknown): void },
	options: {
		view?: ConversationView;
		role?: "owner" | "guest";
		sessions?: Session[];
		screen?: "chat" | "sessions";
	} = {},
) {
	const calls: Calls = {};
	const rows = options.sessions ?? [session("s")];
	const { server, worker } = stubs(calls, rows, { view: options.view, owner: options.role !== "guest" });
	const fixture = await topology(t, {
		server,
		worker,
		facets: [tuiCoreFacet, chatTui, modelsTui, sessionsTui, statusTui, subagentsTui, searchTui],
		role: options.role ?? "owner",
		columns: 100,
	});
	fixture.runtime.navigate(options.screen ?? "chat", rows[0]?.id);
	return { ...fixture, calls };
}

const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};

test("model selector configures the conversation; Ctrl+S saves the default; /model provider/id switches", async (t) => {
	const { screen, send, calls } = await setup(t);
	await poll(async () => (await screen()).includes("(faux) faux-1"));
	send("\x0c"); // Ctrl+L: app.model.select
	await poll(async () => (await screen()).includes("Scope: all | scoped") || (await screen()).includes("Scope:"));
	const shown = await screen();
	assert.match(shown, /→ ✓ faux-1 \[faux\]|faux-2 \[faux\]/);
	// The scope exists, so it shows first: [faux-2, faux-1] with the current faux-1 selected; Down wraps to faux-2.
	send(DOWN);
	send(ENTER);
	await poll(() => (calls.configure?.length ?? 0) === 1);
	assert.deepEqual(calls.configure?.[0], { model: { provider: "faux", modelId: "faux-2" } });
	send("\x0c");
	await poll(async () => (await screen()).includes("Model Name"));
	send(CTRL_S);
	await poll(() => (calls.setDefault?.length ?? 0) === 1);
	assert.equal((calls.setDefault?.[0] as { modelId: string }).modelId, "faux-1", "the current model is preselected");
	typed(send, "/model faux/faux-1");
	send(ENTER);
	await poll(() => (calls.configure?.length ?? 0) >= 3);
	assert.deepEqual(calls.configure?.at(-1), { model: { provider: "faux", modelId: "faux-1" } });
});

test("Shift+Tab cycles the model's thinking levels; Ctrl+P cycles the scope with its level; /thinking selects", async (t) => {
	const { screen, send, calls } = await setup(t);
	await poll(async () => (await screen()).includes("(faux) faux-1"));
	send(SHIFT_TAB);
	await poll(() => (calls.configure?.length ?? 0) === 1);
	assert.deepEqual(calls.configure?.[0], { thinkingLevel: "low" });
	send(CTRL_P);
	await poll(() => (calls.configure?.length ?? 0) === 2);
	// The scope is [faux-2:low, faux-1]; the current model is faux-1, so the next is faux-2 with its level.
	assert.deepEqual(calls.configure?.[1], { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "low" });
	typed(send, "/thinking");
	send(ENTER);
	await poll(async () => (await screen()).includes("Thinking Level"));
	send(DOWN);
	send(DOWN);
	send(ENTER);
	await poll(() => (calls.configure?.length ?? 0) === 3);
	assert.deepEqual(calls.configure?.[2], { thinkingLevel: "high" });
	typed(send, "/scoped-models");
	send(ENTER);
	await poll(async () => (await screen()).includes("Scoped models"));
	send(ENTER); // toggles the first model
	send(CTRL_S);
	await poll(() => (calls.setEnabledModels?.length ?? 0) === 1);
	assert.deepEqual(calls.setEnabledModels?.[0], { patterns: ["faux/faux-2"] });
});

test("guests see the model read-only: no selector, no cycling, never the owner's catalog", async (t) => {
	const { screen, send, calls, runtime } = await setup(t, { role: "guest" });
	await poll(async () => (await screen()).includes("faux-1"));
	// No surface or command asks for the owner-only Models (the footer uses Chat.model).
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(calls.models, undefined, "guests never acquire Models");
	assert(!runtime.notices.some((notice) => /owner-only/.test(notice.text)));
	send("\x0c");
	await poll(() => runtime.notices.some((notice) => /only the owner changes it/.test(notice.text)));
	send(SHIFT_TAB);
	send(CTRL_P);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.configure, undefined);
	// A known command that is not theirs is refused, not sent as a message.
	typed(send, "/new-context x");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => /\/new-context is not available here/.test(notice.text)));
	assert.equal(calls.send, undefined);
	assert.equal(calls.reset, undefined);
	// The footer's denominator comes from the guest-safe model metadata.
	assert.match(await screen(), /\d+\.\d%\/1\.0k/);
});

test("session selector: scopes, threaded subagents, message hits, archive and restore, rename, pin", async (t) => {
	const rows = [
		session("s1", { title: "Alpha work", updatedAt: Date.now() - 1000 }),
		session("s2", { title: "Beta work", updatedAt: Date.now() - 5000 }),
		session("s3", { title: "Elsewhere", cwd: "/other" }),
		session("s4", { title: "Old archived", archivedAt: 1 }),
	];
	const { screen, send, calls, runtime } = await setup(t, { sessions: rows, screen: "sessions" });
	await poll(async () => (await screen()).includes("Resume Session (Current Folder)"));
	let shown = await screen();
	assert.match(shown, /Alpha work[\s\S]*└─ helper[\s\S]*Beta work/);
	assert(!shown.includes("Elsewhere") && !shown.includes("Old archived"));
	// Activity markers: working (the session, and the subagent whose conversation is busy), unread, a failed worker.
	await poll(async () => /^ {2}◦ Beta work/m.test(await screen()));
	shown = await screen();
	assert.match(shown, /^ {2}● Alpha work/m);
	assert.match(shown, /^ {2}● └─ helper/m);
	send("\t");
	await poll(async () => (await screen()).includes("Elsewhere"));
	assert.match(await screen(), /^ {2}! Elsewhere/m);
	// Literal message hits from Search, below the sessions.
	typed(send, "needle");
	await poll(async () => (await screen()).includes("Messages (literal matches)"));
	shown = await screen();
	assert.match(shown, /Title s2 — a needle in text/);
	send(ESC); // clears the query
	await poll(async () => !(await screen()).includes("Messages (literal matches)"));
	// Down to Alpha work (first row is "+ New session"), archive with confirmation.
	send(DOWN);
	send(CTRL_D);
	await poll(async () => (await screen()).includes('Archive "Alpha work"?'));
	send(ENTER);
	await poll(() => (calls.archive?.length ?? 0) === 1);
	assert.deepEqual(calls.archive?.[0], { id: "s1" });
	// A list row (the footer names the viewed session too).
	const listed = async (title: string) => new RegExp(`^(?: {2}|› )[●!◦ ] ${title}`, "m").test(await screen());
	await poll(async () => !(await listed("Alpha work")));
	send(CTRL_A);
	await poll(async () => (await screen()).includes("Archived Sessions"));
	await poll(() => listed("Alpha work"));
	send(CTRL_D); // restores in the archived scope
	await poll(() => (calls.restore?.length ?? 0) === 1);
	send(CTRL_A);
	await poll(async () => (await screen()).includes("Resume Session"));
	// Rename and pin the selected session.
	await poll(() => listed("Alpha work"));
	send(DOWN);
	send(CTRL_R);
	await poll(async () => (await screen()).includes("Rename session"));
	send(CTRL_A); // line start, then Ctrl+K: the prompt is empty
	send("\x0b");
	typed(send, "Renamed");
	send(ENTER);
	await poll(() => (calls.rename?.length ?? 0) === 1);
	assert.equal((calls.rename?.[0] as { title: string }).title, "Renamed");
	await poll(async () => (await screen()).includes("Renamed"));
	send(ALT_P);
	await poll(() => (calls.pin?.length ?? 0) === 1);
	// A subagent row opens its conversation: the (session, conversation) identity.
	await poll(async () => (await screen()).includes("helper"));
	const lines = (await screen()).split("\n");
	const selectedLine = lines.findIndex((line) => line.includes("›"));
	const helperLine = lines.findIndex((line) => line.includes("helper"));
	for (let step = selectedLine; step < helperLine; step++) send(DOWN);
	send(ENTER);
	await poll(() => runtime.screen === "chat");
	assert.equal(runtime.identity, "s1#2");
});

test("the chat showing a session's main conversation reads it through its latest answer, once", async (t) => {
	const rows = [session("s1"), session("s2", { title: "Beta work" })];
	const { screen, calls, runtime } = await setup(t, { sessions: rows, screen: "sessions" });
	// The selector marks nothing; s2's unread answer shows as its marker.
	await poll(async () => /^ {2}◦ Beta work/m.test(await screen()));
	assert.equal(calls.markRead?.length ?? 0, 0);
	runtime.navigate("chat", "s2");
	await poll(() => (calls.markRead?.length ?? 0) === 1);
	assert.deepEqual(calls.markRead?.[0], { session: "s2", through: 5 });
	// Further changes while the stub's reads stay behind send no second call for the same answer.
	runtime.navigate("chat");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.markRead?.length, 1);
});

test("/new, /name and /session", async (t) => {
	const { screen, send, calls, runtime } = await setup(t);
	await poll(async () => (await screen()).includes("(faux) faux-1"));
	typed(send, "/name Better title");
	send(ENTER);
	await poll(() => (calls.rename?.length ?? 0) === 1);
	assert.deepEqual(calls.rename?.[0], { id: "s", title: "Better title" });
	typed(send, "/session");
	send(ENTER);
	await poll(async () => (await screen()).includes("Whole session (children and tools)"));
	assert.match(await screen(), /Viewers +2/);
	send(ESC);
	typed(send, "/new");
	send(ENTER);
	await poll(() => (calls.create?.length ?? 0) === 1);
	assert.deepEqual(calls.create?.[0], { cwd: "/work", env: null });
	// The TUI chose the new session's ID and opened it at once.
	assert.equal(runtime.session, calls.created?.[0]);
});

test("chat controls: /compact, Escape aborts compaction, /new-context, Alt+Up restores own queued messages", async (t) => {
	const compacting = viewOf([], {
		"pi.live": { compactions: [{ taskId: 9, trigger: "manual", blocking: false, attempt: 0 }] },
	});
	const { screen, send, calls, runtime } = await setup(t, { view: compacting });
	await poll(async () => (await screen()).includes("Compacting context... (escape to cancel)"));
	typed(send, "/compact keep the API notes");
	send(ENTER);
	await poll(() => (calls.compact?.length ?? 0) === 1);
	assert.deepEqual(calls.compact?.[0], { instructions: "keep the API notes" });
	send(ESC);
	await poll(() => (calls.abortCompaction?.length ?? 0) === 1);
	assert.equal(calls.stop, undefined, "only the compaction is aborted when no run is busy");
	typed(send, "/new-context Continue with the parser");
	send(ENTER);
	await poll(() => (calls.reset?.length ?? 0) === 1);
	assert.deepEqual(calls.reset?.[0], { handoff: "Continue with the parser" });
	typed(send, "draft");
	send(ALT_UP);
	await poll(() => runtime.drafts.get("s#1") === "first queued\n\nsecond queued\n\ndraft");
	await poll(() => runtime.notices.some((notice) => /1 queued message was already sent/.test(notice.text)));
});

test("a reload while an overlay is open closes it cleanly", async (t) => {
	const { screen, send, runtime, client } = await setup(t);
	await poll(async () => (await screen()).includes("(faux) faux-1"));
	send("\x0c");
	await poll(async () => (await screen()).includes("Model Name"));
	const snapshot = JSON.parse(JSON.stringify(snapshotRuntime(runtime)));
	runtime.dispose();
	const terminal = new VirtualTerminal(100, 24);
	const tui = new TuiAltScreen(terminal);
	const next = new TuiRuntime(client, tui);
	next.role = "owner";
	next.connected = true;
	restoreRuntime(next, snapshot);
	next.start();
	tui.setLayoutRoot(next.root);
	tui.setFocus(next);
	tui.start();
	t.after(() => {
		tui.stop();
		next.dispose();
	});
	const after = async () => (await terminal.flushAndGetViewport()).join("\n");
	await poll(async () => (await after()).includes("(faux) faux-1"));
	assert(!(await after()).includes("Model Name"), "no stale overlay after the reload");
	assert.equal(next.identity, "s#1");
	terminal.sendInput("x");
	await poll(() => next.drafts.get("s#1") === "x");
});

test("ports card: action, port and name; Radius forward addresses only", () => {
	const ctx = {
		theme: new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor")),
		keyText: () => "",
		requestRender: () => {},
		cwd: "",
	};
	const url = `https://fwd--${"a".repeat(32)}--x.example.test/`;
	const card = new ToolExecutionComponent(
		{
			id: "p",
			name: "ports",
			args: { action: "open", port: 3000, name: "web", public: true },
			status: "done",
			output: "Forwarding port 3000.",
			details: { action: "open", forward: { url, publicUrl: "https://evil.test/", name: "web", port: 3000 } },
			images: [],
		},
		portsRenderers,
		ctx,
	);
	const shown = card
		.render(100)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");
	assert.match(shown, /ports open · 3000 · web · public/);
	assert.match(shown, /Forwarding port 3000\.\n +Open: https:\/\/fwd--a{32}--x\.example\.test\//);
	assert(!shown.includes("evil.test"), "only Radius forward addresses");
});

test("a refused hold is reported once and not retried in a loop", async (t) => {
	const Refusing = remote("p2.test-refusing", {
		version: 1,
		params: {},
		hostAddress: serverHost,
		variants: { reader: { state: { value: num() } } },
	});
	let attempts = 0;
	const calls: Calls = {};
	const { server, worker } = stubs(calls, [session("s")]);
	const { runtime } = await topology(t, {
		server: [
			...server,
			[
				Refusing,
				() => {
					attempts++;
					throw forbidden("refused for this principal");
				},
			],
		],
		worker,
		facets: [tuiCoreFacet],
	});
	const scope = new TuiScope(runtime);
	t.after(() => scope.dispose());
	scope.watch(Refusing, {}, () => {});
	await poll(() => runtime.notices.some((notice) => /refused for this principal/.test(notice.text)));
	await new Promise((resolve) => setTimeout(resolve, 2000));
	assert.equal(attempts, 1, "forbidden is permanent: no re-acquire");
	assert.deepEqual(
		runtime.notices.filter((notice) => /refused/.test(notice.text)).map((notice) => notice.count),
		[1],
	);
});
