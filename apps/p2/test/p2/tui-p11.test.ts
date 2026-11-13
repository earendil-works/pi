// P11 of p2-tui-port.md: the web-parity panels in the TUI. P11h (/agents and the subagent crumb), P11b (chat mode
// chip, chat/mention entries, replies); the later P11 groups append below.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ConversationView,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@p2/app/v1";
import { Artifacts } from "../../plugins/artifacts/contract.ts";
import artifactsTui from "../../plugins/artifacts/tui.ts";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui from "../../plugins/chat/tui.ts";
import { ChatMode } from "../../plugins/chat-mode/contract.ts";
import chatModeTui from "../../plugins/chat-mode/tui.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import devicesTui from "../../plugins/devices/tui.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import envsTui from "../../plugins/envs/tui.ts";
import { LogNotices, Logs } from "../../plugins/logs/contract.ts";
import logsTui from "../../plugins/logs/tui.ts";
import { Ports } from "../../plugins/ports/contract.ts";
import portsTui from "../../plugins/ports/tui.ts";
import { SentFiles } from "../../plugins/send-file/contract.ts";
import sendFileTui from "../../plugins/send-file/tui.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui from "../../plugins/sessions/tui.ts";
import { GuestPresence, Sharing } from "../../plugins/sharing/contract.ts";
import sharingTui from "../../plugins/sharing/tui.ts";
import { SessionMetrics, SessionStatus, WorkerControl } from "../../plugins/status/contract.ts";
import statusTui from "../../plugins/status/tui.ts";
import { type Child, SubagentControl, Subagents } from "../../plugins/subagents/contract.ts";
import subagentsTui from "../../plugins/subagents/tui.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import type { WorkspaceQuery, WorkspaceResult } from "../../plugins/workspace/protocol.ts";
import workspaceTui, { piDiff } from "../../plugins/workspace/tui.ts";
import type { Ctx, defineFacet } from "../../src/runtime/chord.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { type Cell, poll } from "./helpers.ts";
import { type Stub, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_D = "\x04";
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
type Calls = Record<string, unknown[]>;
const entry = (id: number, record: Omit<EntryRecord, "id" | "conversationId">): EntryRecord =>
	({ id: id as EntryId, conversationId: ROOT_CONVERSATION_ID, ...record }) as EntryRecord;
const viewOf = (entries: EntryRecord[] = []): ConversationView => ({
	conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
	entries,
	docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
});
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};

function fixture(
	calls: Calls,
	options: {
		views?: (conversation: number) => ConversationView;
		children?: Child[];
		chatMode?: boolean;
		/** Chat as a view-only guest gets it (no `participant` term). */
		viewer?: boolean;
		server?: Stub[];
		worker?: Stub[];
	} = {},
) {
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	let mode: Cell<boolean> | undefined;
	const server: Stub[] = [
		[
			Sessions,
			(_input, _principal, self) => ({
				variant: "guest",
				sessions: self.state([SESSION]),
			}),
		],
		[
			Subagents,
			(_input, _principal, self) => ({
				variant: "reader",
				children: self.state({
					s: options.children ?? [],
				}),
			}),
		],
		[
			SessionMetrics,
			(_input, _principal, self) => ({
				variant: "reader",
				clients: self.state(1),
				usage: self.state(null),
			}),
		],
	];
	const worker: Stub[] = [
		[
			Chat,
			(raw, _principal, self) => {
				const input = raw as { conversation: number };
				if (options.viewer)
					return {
						variant: "viewer",
						view: self.state(options.views?.(input.conversation) ?? viewOf()),
						model: self.state(META),
						liveShell: self.state(null),
						stats: self.state(null),
						entries: () => ({ items: [], more: false }),
					};
				return {
					variant: "participant",
					view: self.state(options.views?.(input.conversation) ?? viewOf()),
					model: self.state(META),
					liveShell: self.state(null),
					stats: self.state(null),
					entries: () => ({ items: [], more: false }),
					send: (args: unknown) => {
						record("send", { conversation: input.conversation, ...(args as object) });
						return { submissionId: 1 };
					},
					stop: () => ({ restored: [] }),
					dequeue: () => ({ text: null }),
					configure: () => {},
					compact: () => ({ taskId: 1 }),
					abortCompaction: () => ({ aborted: 0 }),
					reset: () => {},
					shell: () => ({ shellId: "shell-1" }),
					abortShell: () => ({ aborted: false }),
					dequeueOwn: () => ({ restored: [], skipped: 0 }),
				};
			},
		],
		[
			Drafts,
			(_input, _principal, self) => ({
				variant: "author",
				drafts: self.state([]),
				claim: () => ({ texts: [] }),
			}),
		],
		[
			SubagentControl,
			() => ({
				variant: "participant",
				archive: (args: unknown) => {
					record("archive", args);
				},
			}),
		],
		[
			ChatMode,
			(_input, _principal, self) => {
				const enabledState = self.state(options.chatMode ?? false);
				const waiting = self.state(0);
				const name = self.state("Pi");
				mode = enabledState;
				return {
					variant: "owner",
					enabled: enabledState,
					waiting,
					name,
					set: ({ enabled }: { enabled: boolean }, ctx: Ctx) => {
						record("setChatMode", enabled);
						enabledState.replace(ctx, enabled);
					},
					rename: ({ name: next }: { name: string }, ctx: Ctx) => {
						record("renameAgent", next);
						name.replace(ctx, next);
					},
				};
			},
		],
	];
	return {
		server: [...server, ...(options.server ?? [])],
		worker: [...worker, ...(options.worker ?? [])],
		mode: () => mode,
	};
}

async function setup(
	t: { after(fn: () => unknown): void },
	options: Parameters<typeof fixture>[1] & {
		facets?: ReturnType<typeof defineFacet>[];
		role?: "owner" | "guest";
		calls?: Calls;
	} = {},
) {
	const calls: Calls = options.calls ?? {};
	const { server, worker } = fixture(calls, options);
	const setup = await topology(t, {
		server,
		worker,
		facets: options.facets ?? [tuiCoreFacet, chatTui, sessionsTui, statusTui, subagentsTui, chatModeTui],
		columns: 100,
		...(options.role ? { role: options.role } : {}),
	});
	setup.runtime.navigate("chat", "s");
	await poll(async () => !(await setup.screen()).includes("Connecting conversation"));
	return { ...setup, calls };
}

const child = (patch: Partial<Child>): Child => ({
	name: "helper",
	conversationId: 2,
	model: "faux/faux-1",
	thinkingLevel: "off",
	tools: ["read"],
	lastEntryId: 1,
	...patch,
});

test("/agents opens subagent conversations with their own drafts; the footer crumb; archive", async (t) => {
	const { screen, send, runtime, calls } = await setup(t, {
		views: (conversation) =>
			viewOf([
				entry(1, {
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "text", text: `answer in conversation ${conversation}` }],
							api: "openai-completions",
							provider: "faux",
							model: "faux-1",
							stopReason: "stop",
							timestamp: 1,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					],
				}),
			]),
		children: [
			child({}),
			child({ name: "old", conversationId: 3, archived: true }),
			child({ name: "classifier", conversationId: 4, kind: "agent" }),
		],
	});
	typed(send, "main draft");
	await poll(() => runtime.drafts.get("s#1") === "main draft");
	runtime.ctx.commands.run("p2.agents");
	await poll(async () => (await screen()).includes("Conversations · active"));
	let shown = await screen();
	assert.match(shown, /main[\s\S]*helper[\s\S]*agent classifier/);
	assert(!shown.includes("old (archived)"));
	send(DOWN);
	send(ENTER);
	await poll(() => runtime.identity === "s#2");
	await poll(async () => (await screen()).includes("answer in conversation 2"));
	assert.match(await screen(), /\/work • Fixture › helper/);
	typed(send, "child draft");
	await poll(() => runtime.drafts.get("s#2") === "child draft");
	runtime.ctx.commands.run("p2.agents.main");
	await poll(() => runtime.identity === "s#1");
	await poll(async () => (await screen()).includes("main draft"));
	assert.equal(runtime.drafts.get("s#2"), "child draft");
	// Archive the subagent from the list.
	runtime.ctx.commands.run("p2.agents");
	await poll(async () => (await screen()).includes("Conversations · active"));
	send(DOWN);
	send(CTRL_D);
	await poll(() => (calls.archive?.length ?? 0) === 1);
	assert.deepEqual(calls.archive?.[0], { conversation: 2, archived: true });
	send("\x01"); // Ctrl+A: archived ones too
	await poll(async () => (await screen()).includes("old (archived)"));
	shown = await screen();
	assert.match(shown, /Conversations · with archived/);
});

test("chat mode: chip, quoted replies and notes, /chat-mode (owner), /reply, @pi first", async (t) => {
	const alice = { kind: "guest" as const, id: "alice", name: "Alice" };
	const { screen, send, runtime, calls } = await setup(t, {
		chatMode: true,
		views: () =>
			viewOf([
				entry(1, { kind: "chat.message", data: { author: alice, text: "is the parser done?", attachments: [] } }),
				entry(2, {
					kind: "chat.message",
					data: {
						author: { kind: "owner", id: "owner", name: "Owner" },
						text: "almost",
						attachments: [],
						replyTo: { entryId: 1, author: alice, excerpt: "is the parser done?" },
					},
				}),
				entry(3, {
					kind: "chat.mention",
					data: { author: alice, text: "@pi summarize", attachments: [], included: [1, 2] },
				}),
			]),
	});
	// Views arrive asynchronously: the whole transcript, not just its first entry.
	await poll(async () => (await screen()).includes("with 2 chat messages"));
	const shown = await screen();
	assert.match(shown, /Alice \(guest, unverified name\)/);
	assert.match(shown, /↪ Alice: is the parser done\?/);
	assert.match(shown, /with 2 chat messages/);
	assert.match(shown, / Chat {2}messages go to the people here/);
	// Replies: pick the newest message, the next send carries its entry.
	typed(send, "/reply");
	send(ENTER);
	await poll(async () => (await screen()).includes("Reply to"));
	send(ENTER);
	await poll(async () => (await screen()).includes("↪ Replying to Alice"));
	typed(send, "yes, done");
	send(ENTER);
	await poll(() => (calls.send?.length ?? 0) === 1);
	assert.equal((calls.send?.[0] as { replyTo?: number }).replyTo, 3);
	await poll(async () => !(await screen()).includes("↪ Replying to"));
	// @pi is offered first while chat mode is on.
	typed(send, "ask @p");
	await poll(async () => (await screen()).includes("mention Pi"));
	send("\t");
	await poll(() => runtime.drafts.get("s#1") === "ask @pi ");
	send("\x15");
	// The owner switches chat mode off; replies end with it.
	runtime.role = "owner";
	runtime.changed();
	typed(send, "/chat-mode");
	send(ENTER);
	await poll(() => (calls.setChatMode?.length ?? 0) === 1);
	assert.equal(calls.setChatMode?.[0], false);
	await poll(() => runtime.notices.some((notice) => notice.text === "Chat mode off"));
	await poll(async () => (await screen()).includes("[Chat off · /chat-mode]"));
	assert(!runtime.ctx.commands.run("p2.chatMode.reply"), "no replies outside chat mode");
});

const ESC = "\x1b";
const F2 = "\x1bOQ";
const PAGE_DOWN = "\x1b[6~";
const TAB = "\t";
const CTRL_T = "\x14";
const CTRL_P = "\x10";
const CTRL_K = "\x0b";

/** Owner-only server objects (P11d-g): each records calls; `cells` exposes state the test changes later. */
function ownerStubs(calls: Calls) {
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	const cells: { notices?: Cell<{ id: number; time: number; source: string; message: string }[]> } = {};
	const hostKey = { state: "unknown" as const, fingerprints: ["SHA256:abc"], lines: ["box ssh-ed25519 AAAA"] };
	const stubs: Stub[] = [
		[
			LogNotices,
			(_input, _principal, self) => {
				record("noticesAcquired", true);
				const notices = self.state([{ id: 1, time: 1, source: "server", message: "old trouble" }]);
				cells.notices = notices;
				return {
					variant: "owner",
					notices,
					dismiss: ({ id }: { id: number }, ctx: Ctx) => {
						record("dismiss", id);
						notices.replace(
							ctx,
							(notices.value ?? []).filter((notice) => notice.id !== id),
						);
					},
				};
			},
		],
		[
			Logs,
			(raw, _principal, self) => {
				const { source } = raw as { source: string };
				record("logs", source);
				return {
					variant: "owner",
					sources: self.state([{ id: "session:s", lines: 1, updatedAt: 1 }]),
					lines: self.state([
						{ id: 1, time: 1, level: "stdout", text: `first line of ${source}` },
						{ id: 2, time: 2, level: "stderr", text: `last line of ${source}` },
					]),
				};
			},
		],
		[
			SessionStatus,
			(_input, _principal, self) => ({
				variant: "reader",
				statuses: self.state({
					s: { running: false, error: "worker exited with code 1", tasks: 0, busy: [] },
				}),
			}),
		],
		[
			WorkerControl,
			(raw) => ({
				variant: "owner",
				restart: () => {
					record("retry", (raw as { session: string }).session);
				},
			}),
		],
		[
			Envs,
			(_input, _principal, self) => ({
				variant: "owner",
				envs: self.state([
					{ name: "box", config: { type: "ssh", host: "box.example", user: "me" }, sessions: 2 },
					{
						name: "lab",
						config: { type: "ssh", host: "lab.example" },
						sessions: 0,
						test: { ok: false, testedAt: 1, error: "host key not trusted", hostKey },
					},
				]),
				failure: self.state(null),
				test: ({ name }: { name: string }) => {
					record("test", name);
					return {
						ok: true,
						testedAt: 2,
						platform: "linux",
						arch: "x64",
						home: "/home/me",
						version: "1",
						latencyMs: 12,
						watchMode: "native",
						warnings: [],
					};
				},
				acceptHostKey: (args: unknown) => {
					record("acceptHostKey", args);
				},
				forgetHostKey: (args: unknown) => {
					record("forgetHostKey", args);
				},
				list: () => [],
				warm: () => {
					record("warm", true);
				},
				save: () => {},
				delete: () => {},
				generateKey: () => ({ publicKey: "", identityFile: "" }),
				uploadKey: () => ({ publicKey: "", identityFile: "" }),
				publicKey: () => null,
				listDirectory: () => ({ path: "/", parent: null, directories: [], truncated: false }),
				sandboxStatus: () => ({ state: "stopped" as const }),
				sandboxStart: () => ({ state: "stopped" as const }),
				sandboxStop: () => ({ state: "stopped" as const }),
				sandboxResetDisk: () => ({ state: "stopped" as const }),
			}),
		],
		[
			Ports,
			(_input, _principal, self) => ({
				variant: "owner",
				forwards: self.state([
					{
						id: "f1",
						port: 5173,
						name: "vite",
						url: `https://fwd--${"a".repeat(32)}--x1.radius.example/`,
					},
					{ id: "f2", port: 9000, url: "https://evil.example/phish" },
				]),
				radiusOrigin: self.state("https://radius.example"),
				add: (args: unknown) => {
					record("addPort", args);
				},
				remove: (args: unknown) => {
					record("removePort", args);
				},
				setPublic: (args: unknown) => {
					record("setPublic", args);
				},
			}),
		],
		[GuestPresence, () => ({ variant: "owner" })],
		[
			Sharing,
			(_input, _principal, self) => {
				record("sharingAcquired", true);
				const env = self.state("box");
				const links = self.state<{ mode: "view" | "full"; token: string; url: string }[]>([]);
				const guests = self.state([{ id: "g1", name: "Alice", mode: "view" }]);
				const people = self.state([]);
				const peopleUrl = self.state(null);
				let tokens = 0;
				return {
					variant: "owner",
					env,
					links,
					guests,
					people,
					peopleUrl,
					share: (args: unknown) => {
						record("share", args);
					},
					link: (args: { mode: "view" | "full"; reset?: boolean }, ctx: Ctx) => {
						record("link", args);
						const token = `tok-${args.mode}-${++tokens}`;
						links.replace(ctx, [
							...(links.value ?? []).filter((link) => link.mode !== args.mode),
							{ mode: args.mode, token, url: `https://share.test/join/${token}` },
						]);
					},
					remove: (args: unknown) => {
						record("removeGuest", args);
					},
				};
			},
		],
		[
			Devices,
			(_input, _principal, self) => ({
				variant: "owner",
				canMint: self.state(true),
				token: () => {
					record("token", true);
					return { token: "one-time-token-123" };
				},
			}),
		],
	];
	return { stubs, cells };
}

const OWNER_FACETS = [tuiCoreFacet, chatTui, statusTui, logsTui, envsTui, portsTui, devicesTui, sharingTui];

test("owner diagnostics: notices once, /notices dismisses, /logs follows sources, worker retry, dev reload", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { screen, send, runtime, server } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS });
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true, value: { message: "Reloaded chat, status" } };
	};
	// Pending notices are summarized once; the failed worker is reported with its retry command.
	await poll(() => runtime.notices.some((notice) => notice.text === "1 owner notice · /notices"));
	await poll(() =>
		runtime.notices.some((notice) => notice.text.includes("Session worker failed: worker exited with code 1")),
	);
	// A new notice shows as it arrives, exactly once.
	await server.root((root) => {
		owner.cells.notices?.replace(root, [
			...(owner.cells.notices.value ?? []),
			{ id: 2, time: 2, source: "session:s", message: "disk full" },
		]);
	});
	await poll(() => runtime.notices.some((notice) => notice.text === "Worker s: disk full"));
	assert.equal(runtime.notices.filter((notice) => notice.text === "Worker s: disk full").length, 1);
	runtime.ctx.commands.run("p2.notices");
	await poll(async () => (await screen()).includes("Owner notices (2)"));
	send(CTRL_D);
	await poll(() => (calls.dismiss?.length ?? 0) === 1);
	assert.deepEqual(calls.dismiss, [1]);
	await poll(async () => (await screen()).includes("Owner notices (1)"));
	send(ESC);
	// Logs: the viewed session's worker first, newest line selected; Tab moves to the next source.
	runtime.ctx.commands.run("p2.logs");
	await poll(async () => (await screen()).includes("Logs · Worker s (2 lines)"));
	assert.match(await screen(), /→ last line of session:s/);
	send(TAB);
	await poll(async () => (await screen()).includes("Logs · Server (2 lines)"));
	assert.deepEqual(calls.logs, ["session:s", "server"]);
	send(ESC);
	runtime.ctx.commands.run("p2.worker.retry");
	await poll(() => (calls.retry?.length ?? 0) === 1);
	assert.deepEqual(calls.retry, ["s"]);
	runtime.ctx.commands.run("p2.dev.reload");
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["devCommand", { action: "reload" }]);
	await poll(() => runtime.notices.some((notice) => notice.text === "Reloaded chat, status"));
	runtime.ctx.commands.run("p2.dev.restart");
	await poll(() => grants.length === 2);
	assert.deepEqual(grants[1], ["devCommand", { action: "restart" }]);
});

test("guests never acquire owner objects and cannot open owner panels", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { runtime } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS, role: "guest" });
	for (const id of [
		"p2.logs",
		"p2.notices",
		"p2.worker.retry",
		"p2.dev.reload",
		"p2.dev.restart",
		"p2.envs",
		"p2.ports",
		"p2.devices",
		"p2.share",
	])
		assert(!runtime.ctx.commands.run(id), `${id} is owner-only`);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.noticesAcquired, undefined);
	assert.equal(calls.logs, undefined);
	assert(!runtime.notices.some((notice) => /forbidden|owner-only/.test(notice.text)));
});

test("/envs tests an environment; a host key is trusted only after confirming its fingerprints", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { screen, send, runtime } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS });
	runtime.ctx.commands.run("p2.envs");
	await poll(async () => (await screen()).includes("Environments (2)"));
	// Opening the screen starts the environments' SSH connections (the web picker's warm-up).
	await poll(() => (calls.warm?.length ?? 0) === 1);
	assert.match(await screen(), /This device[\s\S]*box {2}me@box\.example[\s\S]*untested · 2 sessions/);
	send(DOWN); // past "This device"
	send(CTRL_T);
	await poll(() => (calls.test?.length ?? 0) === 1);
	assert.deepEqual(calls.test, ["box"]);
	await poll(async () => (await screen()).includes("Testing box: done"));
	// The unverified key: Ctrl+K reviews it (Enter moves sessions); declining trusts nothing, confirming sends exactly
	// its lines.
	send(DOWN);
	send(CTRL_K);
	await poll(async () => (await screen()).includes("Trust lab's host key?"));
	assert.match(await screen(), /SHA256:abc/);
	send(ESC);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.acceptHostKey, undefined);
	await poll(async () => (await screen()).includes("Environments (2)"));
	send(CTRL_K);
	await poll(async () => (await screen()).includes("Trust lab's host key?"));
	typed(send, "y");
	await poll(() => (calls.acceptHostKey?.length ?? 0) === 1);
	assert.deepEqual(calls.acceptHostKey?.[0], { name: "lab", lines: ["box ssh-ed25519 AAAA"] });
});

test("/ports shows Radius addresses only; making a forward public needs a confirmation", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { screen, send, runtime } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS });
	runtime.ctx.commands.run("p2.ports");
	await poll(async () => (await screen()).includes("Ports (2)"));
	assert.match(await screen(), /fwd--a{32}--x1\.radius\.example/);
	send(DOWN);
	await poll(async () => (await screen()).includes("no address yet"));
	assert(!(await screen()).includes("evil.example"));
	send(CTRL_P);
	await poll(async () => (await screen()).includes("Make port 9000 public?"));
	send(ESC);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.setPublic, undefined);
	await poll(async () => (await screen()).includes("Ports (2)"));
	send(CTRL_P);
	await poll(async () => (await screen()).includes("Make port 9000 public?"));
	typed(send, "y");
	await poll(() => (calls.setPublic?.length ?? 0) === 1);
	assert.deepEqual(calls.setPublic?.[0], { id: "f2", public: true });
	send(ESC);
	// `open … public` confirms before anything is added.
	runtime.ctx.commands.run("p2.ports", "open 3000 api public");
	await poll(async () => (await screen()).includes("Make port 3000 public?"));
	typed(send, "y");
	await poll(() => (calls.addPort?.length ?? 0) === 1);
	assert.deepEqual(calls.addPort?.[0], { port: 3000, name: "api", public: true });
});

test("/devices mints a token and signs out through the launcher's consent", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { screen, send, runtime } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS });
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: false, error: "denied" };
	};
	runtime.ctx.commands.run("p2.devices");
	await poll(async () => (await screen()).includes("Generate a one-time sign-in token"));
	send(ENTER);
	await poll(async () => (await screen()).includes("one-time-token-123"));
	assert.match(await screen(), /full owner access/);
	send(ESC);
	await poll(async () => (await screen()).includes("Sign out all devices"));
	send(DOWN);
	send(DOWN);
	send(ENTER);
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["signOut", { all: true }]);
	await poll(() => runtime.notices.some((notice) => notice.text === "Not signed out"));
});

test("/files, /changes and /grep read the workspace (participants); guests and readers cannot", async (t) => {
	const calls: Calls = {};
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	let branch: string | undefined = "main";
	const changes: Cell<number>[] = [];
	const workspace: Stub = [
		Workspace,
		(_input, _principal, self) => {
			const counter = self.state(0);
			changes.push(counter);
			return {
				variant: "reader",
				changes: counter,
				query: (query: WorkspaceQuery): WorkspaceResult => {
					record("query", query);
					switch (query.kind) {
						case "list":
							return query.path === ""
								? {
										kind: "list",
										path: "",
										truncated: false,
										entries: [
											{ name: "README.md", kind: "file", size: 12, mtimeMs: 1 },
											{ name: "src", kind: "directory", size: 0, mtimeMs: 1 },
										],
									}
								: {
										kind: "list",
										path: query.path,
										truncated: false,
										entries: [{ name: "main.ts", kind: "file", size: 30, mtimeMs: 1 }],
									};
						case "file":
							return {
								kind: "file",
								path: query.path,
								size: 30,
								binary: false,
								truncated: false,
								text: `// ${query.path}\nconst answer = 42;\n\x1b]52;c;evil\x07export {};`,
							};
						case "status":
							return {
								kind: "status",
								repo: true,
								...(branch ? { branch } : {}),
								head: "0123456789abcdef",
								truncated: false,
								changes: [{ path: "src/main.ts", status: ".M" }],
							};
						case "diff":
							return {
								kind: "diff",
								path: query.path,
								full: false,
								truncated: false,
								patch: "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,2 +1,2 @@\n // src/main.ts\n-const answer = 41;\n+const answer = 42;\n",
							};
						case "search":
							return {
								kind: "search",
								text: query.text,
								path: "",
								truncated: false,
								matches: [{ path: "src/main.ts", line: 2, text: "const answer = 42;" }],
							};
						default:
							throw new Error("unexpected");
					}
				},
			};
		},
	];
	const { screen, send, runtime, worker } = await setup(t, {
		calls,
		worker: [workspace],
		facets: [tuiCoreFacet, chatTui, statusTui, workspaceTui],
	});
	// pi's footer: `cwd (branch)`, asked again when files change; a detached HEAD says so.
	await poll(async () => (await screen()).includes("/work (main) • Fixture"));
	branch = "feature";
	const bump = async () =>
		worker.root((root) => {
			for (const cell of changes)
				try {
					cell.replace(root, (cell.value ?? 0) + 1);
				} catch {}
		});
	await bump();
	await poll(async () => (await screen()).includes("/work (feature) • Fixture"));
	branch = undefined;
	await bump();
	await poll(async () => (await screen()).includes("/work (detached) • Fixture"));
	branch = "main";
	calls.query = [];
	runtime.ctx.commands.run("p2.files");
	await poll(async () => (await screen()).includes("Files: ."));
	assert.match(await screen(), /src\/[\s\S]*README\.md/);
	send(ENTER); // src/ (directories first)
	await poll(async () => (await screen()).includes("Files: src"));
	send(DOWN); // past ../
	send(ENTER);
	await poll(async () => (await screen()).includes("const answer = 42;"));
	const file = await screen();
	assert(!file.includes("52;c;evil\x07"), "control sequences in file text are stripped");
	send(ESC);
	send(ESC);
	runtime.ctx.commands.run("p2.changes");
	await poll(async () => (await screen()).includes("Changes on main (1)"));
	send(ENTER);
	await poll(async () => (await screen()).includes("Changes: src/main.ts"));
	const diff = await screen();
	assert.match(diff, /-2 const answer = 41;/);
	assert.match(diff, /\+2 const answer = 42;/);
	send(ESC);
	send(ESC);
	runtime.ctx.commands.run("p2.grep", "answer");
	await poll(async () => (await screen()).includes('Search "answer" (1)'));
	assert.match(await screen(), /src\/main\.ts:2/);
	send(ENTER);
	await poll(async () => (await screen()).includes("src/main.ts") && (await screen()).includes("1-3 of 3"));
	send(ESC);
	send(ESC);
	// The panels' own queries (the footer asks only when files change).
	assert.deepEqual(
		calls.query?.map((query) => (query as WorkspaceQuery).kind),
		["list", "list", "file", "status", "diff", "search", "file"],
	);
});

test("view-only guests get no workspace commands and never acquire Workspace", async (t) => {
	const calls: Calls = {};
	const { runtime, screen } = await setup(t, {
		calls,
		viewer: true,
		role: "guest",
		worker: [
			[
				Workspace,
				() => {
					calls.workspace = [true];
					throw new Error("forbidden");
				},
			],
		],
		facets: [tuiCoreFacet, chatTui, statusTui, workspaceTui],
	});
	await poll(async () => (await screen()).includes("view only") || runtime.ctx.surface("chat") !== undefined);
	for (const id of ["p2.files", "p2.changes", "p2.grep"])
		assert(!runtime.ctx.commands.run(id, "x"), `${id} needs send access`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.workspace, undefined);
});

test("piDiff turns a unified patch into pi's numbered diff lines", () => {
	assert.equal(
		piDiff(
			"--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n@@ -20 +20 @@\n-a\n+b\n\\ No newline at end of file\n",
		),
		// Numbers are padded to the widest one, as pi's edit diffs are.
		["  3 keep", "- 4 old", "+ 4 new", "    ...", "-20 a", "+20 b"].join("\n"),
	);
});

test("/share copies links through the launcher, confirms a remote read/write link, resets links and removes guests", async (t) => {
	const calls: Calls = {};
	const owner = ownerStubs(calls);
	const { screen, send, runtime } = await setup(t, { calls, server: owner.stubs, facets: OWNER_FACETS });
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true, value: null };
	};
	runtime.ctx.commands.run("p2.share");
	await poll(async () => (await screen()).includes("Share · 1 guest connected"));
	assert.match(await screen(), /Read-only link[\s\S]*Read\/write link[\s\S]*Alice \(unverified name\)/);
	assert.match(await screen(), /change files on the remote\s+environment "box"/);
	// Read-only: created on first use, then copied through the launcher's consent screen.
	send(ENTER);
	await poll(() => grants.length === 1);
	assert.deepEqual(calls.link, [{ mode: "view" }]);
	assert.deepEqual(grants[0], ["copy", { text: "https://share.test/join/tok-view-1", label: "Read-only share link" }]);
	await poll(() => runtime.notices.some((notice) => notice.text === "Read-only link copied"));
	// Read/write on a remote environment: confirmed before the link exists; declining creates nothing.
	send(DOWN);
	send(ENTER);
	await poll(async () => (await screen()).includes("Create a read/write link?"));
	send(ESC);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls.link?.length, 1);
	await poll(async () => (await screen()).includes("Share · 1 guest"));
	send(ENTER);
	await poll(async () => (await screen()).includes("Create a read/write link?"));
	typed(send, "y");
	await poll(() => grants.length === 2);
	assert.deepEqual(calls.link?.[1], { mode: "full", remoteConfirmed: true });
	assert.deepEqual(grants[1], [
		"copy",
		{ text: "https://share.test/join/tok-full-2", label: "Read/write share link" },
	]);
	// Reset the read-only link; remove the guest. Both confirmed.
	send("\x1b[A");
	send("\x12"); // Ctrl+R
	await poll(async () => (await screen()).includes("New read-only link?"));
	typed(send, "y");
	await poll(() => calls.link?.length === 3);
	assert.deepEqual(calls.link?.[2], { mode: "view", reset: true });
	send(DOWN);
	send(DOWN);
	send(CTRL_D);
	await poll(async () => (await screen()).includes("Remove Alice?"));
	typed(send, "y");
	await poll(() => (calls.removeGuest?.length ?? 0) === 1);
	assert.deepEqual(calls.removeGuest, [{ guestId: "g1" }]);
	// A declined copy says nothing; a failed one points at the launcher's own message.
	runtime.onGrant = async () => ({ ok: false, error: "failed" });
	send("\x1b[A");
	send("\x1b[A");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => notice.text.includes("launcher could not")));
});

test("a view-only guest sees under which name it joined instead of the editor", async (t) => {
	const { screen, runtime } = await setup(t, {
		viewer: true,
		role: "guest",
		facets: [tuiCoreFacet, chatTui, statusTui],
	});
	runtime.grant = { name: "Alice\x1b[31m", sessions: {} };
	runtime.changed();
	await poll(
		async () =>
			(await screen()).includes("Joined as Alice[31m (unverified) · read-only") ||
			(await screen()).includes("Joined as Alice (unverified) · read-only"),
	);
	assert(!(await screen()).includes("\x1b[31m"));
});

const resultEntry = (id: number, toolCallId: string, toolName: string, details: JsonValue, text: string): EntryRecord =>
	entry(id, {
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				details,
				isError: false,
				timestamp: id,
			},
		],
	});
const callEntry = (id: number, toolCallId: string, name: string, args: { [key: string]: JsonValue }): EntryRecord =>
	entry(id, {
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
				api: "openai-completions",
				provider: "faux",
				model: "faux-1",
				stopReason: "toolUse",
				timestamp: id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		],
	});

const FILE_ID = "0b3f2c1e-1111-4222-8333-444455556666";

function contentStubs(calls: Calls): Stub[] {
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	return [
		[
			SentFiles,
			() => ({
				variant: "reader",
				preview: ({ id }: { id: string }) => {
					record("preview", id);
					return { name: "report.csv", size: 12, text: "a,b\n1,2", truncated: false };
				},
			}),
		],
	];
}

type Summary = { id: string; kind: "html" | "md"; title: string; version: number; updated: number };

/** The session's artifacts on the server, with what `read` gives for each (and records it). */
function artifactStubs(
	calls: Calls,
	summaries: Summary[],
	content: (id: string, version: number) => string,
	onList?: (list: Cell<Summary[]>) => void,
): Stub[] {
	return [
		[
			Artifacts,
			(_input, _principal, self) => {
				const list = self.state(summaries);
				onList?.(list);
				return {
					variant: "reader",
					artifacts: list,
					read: ({ id, version }: { id: string; version: number }) => {
						calls.readArtifact = [...(calls.readArtifact ?? []), { id, version }];
						const summary = list.value.find((each) => each.id === id)!;
						return { summary, version, content: content(id, version) };
					},
				};
			},
		],
	];
}

test("artifacts: /artifacts shows Markdown over the chat when narrow, a page as source, and opens a page in the browser", async (t) => {
	const calls: Calls = {};
	const { screen, send, runtime, terminal } = await setup(t, {
		calls,
		server: artifactStubs(
			calls,
			[
				{ id: "notes", kind: "md", title: "Notes", version: 2, updated: 2 },
				{ id: "page", kind: "html", title: "Page", version: 1, updated: 1 },
			],
			(id) => (id === "notes" ? "# Heading\n\nSome **bold** text\x1b]52;c;evil\x07" : "<h1>Page</h1>"),
		),
		facets: [tuiCoreFacet, chatTui, statusTui, artifactsTui],
	});
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true, value: null };
	};
	runtime.ctx.commands.run("p2.artifacts");
	await poll(async () => (await screen()).includes("Artifacts (2)"));
	assert.match(await screen(), /the browser needs its own sign-in/);
	// Too narrow for the side panel: Enter shows an artifact over the chat.
	terminal.resize(80, 24);
	send(ENTER);
	await poll(async () => (await screen()).includes("Notes · MD · v2") && (await screen()).includes("Heading"));
	const shown = await screen();
	assert(!shown.includes("# Heading"), "Markdown is rendered");
	assert(!shown.includes("**bold**"));
	assert(!shown.includes("52;c;evil"), "control sequences are stripped");
	assert.deepEqual(calls.readArtifact, [{ id: "notes", version: 2 }]);
	send(ESC);
	await poll(async () => (await screen()).includes("Artifacts (2)"));
	send(DOWN);
	send(ENTER);
	await poll(async () => (await screen()).includes("Source only"));
	assert.match(await screen(), /<h1>Page<\/h1>/);
	send(ESC);
	await poll(async () => (await screen()).includes("Artifacts (2)"));
	send("\x02"); // Ctrl+B
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["openUrl", { kind: "origin", path: "/artifact-frame?session=s&id=page&version=1" }]);
});

test("artifacts: Enter shows one in the side panel, which follows new versions, scrolls when focused and hides when narrow", async (t) => {
	const calls: Calls = {};
	let list: Cell<Summary[]> | undefined;
	const rows = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join("\n\n");
	const { screen, send, runtime, terminal } = await setup(t, {
		calls,
		server: artifactStubs(
			calls,
			[{ id: "notes", kind: "md", title: "Notes", version: 2, updated: 2 }],
			(_id, version) => `# ${version === 2 ? "Version two" : "Version three"}\n\n${rows}`,
			(cell) => {
				list = cell;
			},
		),
		facets: [tuiCoreFacet, chatTui, statusTui, artifactsTui],
	});
	runtime.ctx.commands.run("p2.artifacts");
	await poll(async () => (await screen()).includes("Artifacts (1)"));
	send(ENTER);
	await poll(async () => (await screen()).includes("Notes · MD · v2") && (await screen()).includes("Version two"));
	assert.equal(runtime.ctx.panel.current, "artifact:notes");
	assert(runtime.contexts().has("panel"));
	// Beside the chat, behind its bar; the editor keeps the focus.
	assert.match(await screen(), /│ +Version two/);
	assert.equal(runtime.ctx.panel.focused, false);
	assert(runtime.capturesViewportInput === false);

	send(F2);
	assert.equal(runtime.ctx.panel.focused, true);
	assert(runtime.capturesViewportInput);
	assert(runtime.contexts().has("panelFocused"));
	send("x"); // typing stays out of the editor
	send(PAGE_DOWN);
	send(PAGE_DOWN);
	await poll(async () => !(await screen()).includes("Version two"));
	send(ESC);
	assert.equal(runtime.ctx.panel.focused, false);
	assert.equal(runtime.ctx.panel.current, "artifact:notes", "Escape only gives the focus back");

	// A new version replaces the shown one.
	list!.replace(null, [{ id: "notes", kind: "md", title: "Notes", version: 3, updated: 3 }]);
	await poll(async () => (await screen()).includes("Notes · MD · v3"));
	assert.deepEqual(calls.readArtifact, [
		{ id: "notes", version: 2 },
		{ id: "notes", version: 3 },
	]);

	// Too narrow for a split: hidden, and it cannot take the focus.
	terminal.resize(80, 24);
	await poll(async () => !(await screen()).includes("Notes · MD · v3"));
	assert(!runtime.contexts().has("panel"));
	send(F2);
	assert.equal(runtime.ctx.panel.focused, false);
	terminal.resize(100, 24);
	await poll(async () => (await screen()).includes("Notes · MD · v3"));

	runtime.ctx.commands.run("p2.panel.close");
	await poll(async () => !(await screen()).includes("Notes · MD · v3"));
	assert.equal(runtime.ctx.panel.current, undefined);
});

test("sent files: the card, /downloads previews text, saves and opens through the launcher", async (t) => {
	const calls: Calls = {};
	const { screen, send, runtime } = await setup(t, {
		calls,
		worker: contentStubs(calls),
		facets: [tuiCoreFacet, chatTui, statusTui, sendFileTui],
		views: () =>
			viewOf([
				callEntry(1, "f1", "send_file", { path: "out/report.csv" }),
				resultEntry(2, "f1", "send_file", { id: FILE_ID, name: "report.csv", size: 12 }, "Download ready"),
				callEntry(3, "f2", "send_file", { path: "evil" }),
				resultEntry(4, "f2", "send_file", { id: "../../etc", name: "passwd", size: 1 }, "Download ready"),
			]),
	});
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true, value: action === "download" ? { saved: true } : null };
	};
	await poll(async () => (await screen()).includes("report.csv · 12B · ready to download · /downloads saves"));
	runtime.ctx.commands.run("p2.downloads");
	await poll(async () => (await screen()).includes("Sent files (1)"));
	assert(!(await screen()).includes("passwd"), "only valid snapshot IDs are offered");
	send(ENTER);
	await poll(async () => (await screen()).includes("report.csv · 12B") && (await screen()).includes("1,2"));
	assert.deepEqual(calls.preview, [FILE_ID]);
	send(ESC);
	await poll(async () => (await screen()).includes("Sent files (1)"));
	send("\x13"); // Ctrl+S
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["download", { kind: "file", session: "s", id: FILE_ID, name: "report.csv" }]);
	send("\x02"); // Ctrl+B
	await poll(() => grants.length === 2);
	assert.deepEqual(grants[1], ["openUrl", { kind: "origin", path: `/download?session=s&id=${FILE_ID}` }]);
});
