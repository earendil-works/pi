// P0c (identities, layout, reading position, snapshot, Ctrl+C/Ctrl+D) and P2 (pi's message/tool rendering, footer
// provenance) of p2-tui-port.md, on a bare host; the sandboxed run is in the last test.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationView,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { stripTerminalSequences, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Chat, type EntriesPage } from "../../plugins/chat/contract.ts";
import chatTui, { ChatSurface } from "../../plugins/chat/tui.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionMetrics } from "../../plugins/status/contract.ts";
import statusTui from "../../plugins/status/tui.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { claimOwner } from "../../src/hosts/tui-config.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import { TuiEntryRenderers, TuiMarkdownTransformers, TuiToolRenderers } from "../../src/runtime/tui-renderers.ts";
import { AssistantMessageComponent } from "../../src/tui/components/messages.ts";
import { ToolExecutionComponent } from "../../src/tui/components/tool-execution.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { transcriptComponent } from "../../src/tui/messages.ts";
import { safeText } from "../../src/tui/render-context.ts";
import { restoreRuntime, snapshotRuntime } from "../../src/tui/snapshot.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";
import { BUILTIN_TOOL_RENDERERS } from "../../src/tui/tools/index.ts";
import { buildTranscript, type ToolView } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { type Cell, holdIn, poll, startFixture } from "./helpers.ts";
import { SESSION, type Stub, sessionsStub, topology } from "./tui-fixture.ts";

const plain = (lines: string[]): string => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_END = "\x1b[1;5F";
const CTRL_HOME = "\x1b[1;5H";
const PAGE_UP = "\x1b[5~";
const LEFT = "\x1b[D";

const usage = {
	input: 12,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "faux",
	model: "faux-1",
	stopReason: "stop",
	timestamp: 1,
	usage,
	...extra,
});
const theme = () => new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor"));
const ctx = (ref = theme()) => ({
	theme: ref,
	keyText: (id: string) => (id === "app.tools.expand" ? "ctrl+o" : ""),
	requestRender: () => {},
	cwd: "/work",
	markdownTransformers: [],
});
const entry = (id: number, record: Omit<EntryRecord, "id" | "conversationId">): EntryRecord =>
	({ id: id as EntryId, conversationId: ROOT_CONVERSATION_ID, ...record }) as EntryRecord;
/** Docs are JSON in the real view; fixtures pass Durable's typed documents. */
const viewOf = (entries: EntryRecord[], docs: Record<string, unknown> = {}): ConversationView => ({
	conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
	entries,
	docs: docs as ConversationView["docs"],
});
const userEntry = (id: number, text: string) =>
	entry(id, { kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });
const answerEntry = (id: number, text: string, timestamp = id) =>
	entry(id, { kind: "pi.assistant", model: [assistant([{ type: "text", text }], { timestamp })] });

test("pi's message components: Markdown, hidden thinking, error notices, sanitized text", () => {
	const message = assistant([
		{ type: "thinking", thinking: "private reasoning" },
		{ type: "text", text: "**Answer** with `code`\x1b]52;c;evil\x07" },
	]);
	const hidden = plain(new AssistantMessageComponent(ctx(), message, true).render(60));
	assert.match(hidden, /Answer with code/);
	assert.match(hidden, /Thinking\.\.\./);
	assert(!hidden.includes("private reasoning"));
	assert(!new AssistantMessageComponent(ctx(), message, true).render(60).join("").includes("52;c"));
	assert.match(plain(new AssistantMessageComponent(ctx(), message, false).render(60)), /private reasoning/);
	assert.match(
		plain(
			new AssistantMessageComponent(ctx(), {
				...message,
				stopReason: "error",
				errorMessage: "fixture error",
			}).render(60),
		),
		/Error: fixture error/,
	);
	assert.match(
		plain(new AssistantMessageComponent(ctx(), { ...message, content: [], stopReason: "aborted" }).render(60)),
		/Operation aborted/,
	);
	assert.match(
		plain(new AssistantMessageComponent(ctx(), { ...message, stopReason: "length" }).render(60)),
		/Response was truncated before completion\./,
	);
	assert.equal(safeText("safe\x1b]52;c;evil\x07\x1b[2J\x00 text"), "safe text");
});

test("tool cards: pi's bash, read, edit diff, generic fallback, code mode with nested calls, theme swap", () => {
	const output = Array.from({ length: 15 }, (_, i) => `output-${i}`).join("\n");
	const tool = (patch: Partial<ToolView>): ToolView => ({
		id: "call",
		name: "bash",
		args: { command: "pwd" },
		status: "done",
		output,
		images: [],
		...patch,
	});
	// bash: the newest 5 lines collapsed, everything expanded, the recorded duration.
	const bash = new ToolExecutionComponent(tool({ durationMs: 1500 }), BUILTIN_TOOL_RENDERERS.bash, ctx());
	const collapsed = plain(bash.render(60));
	assert.match(collapsed, /\$ pwd/);
	assert.match(collapsed, /10 earlier lines, ctrl\+o to expand/);
	assert.match(collapsed, /output-14/);
	assert(!collapsed.includes("output-9"));
	assert.match(collapsed, /Took 1\.5s/);
	bash.setExpanded(true);
	assert.match(plain(bash.render(60)), /output-0\n/);
	for (const line of bash.render(60)) assert(visibleWidth(line) <= 60);
	// A running call: pending background, elapsed clock; the card's timer stops on dispose.
	const running = new ToolExecutionComponent(
		tool({ status: "running", output: "partial" }),
		BUILTIN_TOOL_RENDERERS.bash,
		ctx(),
	);
	assert.match(plain(running.render(60)), /partial[\s\S]*Elapsed/);
	running.dispose();
	// Unknown tools: pi's generic call line and the first 10 result lines.
	const generic = plain(
		new ToolExecutionComponent(tool({ name: "mcp_thing", args: { q: 1 } }), undefined, ctx()).render(80),
	);
	assert.match(generic, /mcp_thing q=1/);
	assert.match(generic, /5 more lines, ctrl\+o to expand/);
	assert(!generic.includes("output-14"));
	// read: path relative to the session cwd; content only when expanded.
	const read = new ToolExecutionComponent(
		tool({ name: "read", args: { path: "/work/src/a.ts", offset: 3, limit: 2 }, output: "const a = 1;" }),
		BUILTIN_TOOL_RENDERERS.read,
		ctx(),
	);
	assert.match(plain(read.render(80)), /read src\/a\.ts:3-4/);
	assert(!plain(read.render(80)).includes("const a"));
	read.setExpanded(true);
	assert.match(plain(read.render(80)), /const a = 1;/);
	// edit: the result's diff, no local preview.
	const edit = plain(
		new ToolExecutionComponent(
			tool({
				name: "edit",
				args: { path: "a.ts" },
				output: "Successfully replaced 1 block(s) in a.ts.",
				details: { diff: "-1 const a = 1;\n+1 const a = 2;" },
			}),
			BUILTIN_TOOL_RENDERERS.edit,
			ctx(),
		).render(80),
	);
	assert.match(edit, /edit a\.ts/);
	assert.match(edit, /-1 const a = 1;\s*\n\s*\+1 const a = 2;/);
	// Code mode: the script, nested calls (depth, live output, failures) and output without Durable's header.
	const code = "// read every file\nconst files = await tools.read({ path: 'a.ts' });\nreturn files.length;";
	const codemode = new ToolExecutionComponent(
		tool({
			name: "codemode",
			args: { code },
			status: "running",
			output: "",
			calls: [
				{ id: "c1", name: "read", args: { path: "a.ts" }, status: "done", depth: 0, durationMs: 40 },
				{ id: "c2", name: "read", args: { path: "f3.ts" }, status: "error", depth: 0, error: "ENOENT: f3.ts" },
				{
					id: "c3",
					name: "bash",
					args: { command: "npm test" },
					status: "running",
					depth: 1,
					output: "build\nrunning tests\n",
				},
			],
		}),
		BUILTIN_TOOL_RENDERERS.codemode,
		ctx(),
	);
	const live = plain(codemode.render(100));
	assert.match(live, /codemode\s*\n\s*\/\/ read every file/);
	assert.match(live, /✓ read \{"path":"a\.ts"\} 40ms/);
	assert.match(live, /✗ read \{"path":"f3\.ts"\}\n +ENOENT: f3\.ts/);
	assert.match(live, / {2}… bash \{"command":"npm test"\}\n +running tests/);
	codemode.update(
		tool({
			name: "codemode",
			args: { code },
			status: "done",
			output: "Script completed\nWall time 0.1 seconds\nOutput:\n\n3",
			calls: [{ id: "c1", name: "read", args: { path: "a.ts" }, status: "done", depth: 0, durationMs: 40 }],
		}),
	);
	const done = plain(codemode.render(100));
	assert.match(done, /\n +3\n/);
	assert(!done.includes("Script completed"));
	// Baked colors follow a theme swap (section 5.4).
	const ref = theme();
	const card = new ToolExecutionComponent(tool({}), BUILTIN_TOOL_RENDERERS.bash, ctx(ref));
	const dark = card.render(60).join("\n");
	ref.set(createTheme(BUILTIN_THEMES.light!, "truecolor"));
	assert.notEqual(card.render(60).join("\n"), dark);
});

test("transcript: streaming answer becomes its entry in place, tool lifecycle, markers and p2 notices", () => {
	const call = { type: "toolCall" as const, id: "t1", name: "bash", arguments: { command: "ls" } };
	const streaming = viewOf([userEntry(1, "hi")], {
		"pi.live": {
			run: { taskId: 1 },
			generation: { message: assistant([{ type: "text", text: "Work" }, call], { timestamp: 7 }) },
		},
	});
	const component = transcriptComponent(buildTranscript(wholeView(streaming)), false, false);
	const first = plain(component.render(80));
	assert.match(first, /hi[\s\S]*Work[\s\S]*\$ ls/);
	const answer = entry(2, {
		kind: "pi.assistant",
		model: [assistant([{ type: "text", text: "Work" }, call], { timestamp: 7, stopReason: "toolUse" })],
	});
	const running = viewOf([userEntry(1, "hi"), answer], {
		"pi.live": { run: { taskId: 1 }, tools: [{ callId: "t1", name: "bash", status: "running", output: "a.txt" }] },
	});
	component.sync(buildTranscript(wholeView(running)));
	assert.match(plain(component.render(80)), /\$ ls[\s\S]*a\.txt[\s\S]*Elapsed/);
	const result = entry(3, {
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "a.txt\nb.txt" }],
				isError: false,
				durationMs: 20,
				timestamp: 9,
			},
		],
	});
	component.sync(
		buildTranscript(
			wholeView(
				viewOf([
					userEntry(1, "hi"),
					answer,
					result,
					entry(4, {
						kind: "pi.compaction",
						model: [{ role: "user", content: "Summary of earlier work", timestamp: 10 }],
					}),
					entry(5, { kind: "app.model-error", data: { detail: "provider down" } }),
					entry(6, { kind: "pi.reset", model: [{ role: "user", content: "Handoff note", timestamp: 11 }] }),
				]),
			),
		),
	);
	const settled = plain(component.render(80));
	assert.match(settled, /b\.txt[\s\S]*Took 0\.0s/);
	assert.match(settled, /\[compaction\][\s\S]*Earlier context summarized \(/);
	assert.match(settled, /The model could not answer this input\. provider down/);
	assert.match(settled, /\[new context\][\s\S]*Handoff note/);
	component.setState({ expanded: true });
	assert.match(plain(component.render(80)), /Summary of earlier work/);
	// An answer that never ran its calls: interrupted cards.
	const interrupted = transcriptComponent(
		buildTranscript(
			wholeView(viewOf([entry(1, { kind: "pi.assistant", model: [assistant([call], { stopReason: "aborted" })] })])),
		),
		false,
		false,
	);
	assert.match(plain(interrupted.render(80)), /Not run: the answer was interrupted\./);
	// Compaction failures are state notices.
	const failed = transcriptComponent(
		buildTranscript(wholeView(viewOf([], { "pi.live": { compactionFailure: { taskId: 3, error: "too big" } } }))),
		false,
		false,
	);
	assert.match(plain(failed.render(80)), /Compaction failed: too big/);
});

type Stubbed = {
	views: Cell<ConversationView | null>[];
	latest: ConversationView;
	sent: { conversation: number; requestId: string; text: string }[];
};
/** A runtime whose chat surface talks to a participant Chat stub (and Drafts) per conversation of session "s". */
async function chatRuntime(
	t: { after(fn: () => unknown): void },
	views: (conversation: number) => ConversationView,
	options: {
		entries?: (query: { minEntryId?: number; maxEntryId?: number }) => EntriesPage;
		facets?: ReturnType<typeof defineFacet>[];
		ready?: Promise<void>;
	} = {},
) {
	const stubs = new Map<number, Stubbed>();
	const chat: Stub = [
		Chat,
		(raw, _principal, self) => {
			const input = raw as { session: string; conversation: number };
			const sent = stubs.get(input.conversation)?.sent ?? [];
			const latest = stubs.get(input.conversation)?.latest ?? views(input.conversation);
			const view = self.state(latest);
			const stats = self.state(null);
			const model = self.state(null);
			const liveShell = self.state(null);
			stubs.set(input.conversation, {
				views: [...(stubs.get(input.conversation)?.views ?? []), view],
				latest,
				sent,
			});
			return {
				variant: "participant",
				view,
				stats,
				model,
				liveShell,
				compact: () => ({ taskId: 1 }),
				abortCompaction: () => ({ aborted: 0 }),
				reset: () => {},
				shell: () => ({ shellId: "shell-1" }),
				abortShell: () => ({ aborted: false }),
				dequeueOwn: () => ({ restored: [], skipped: 0 }),
				entries: (query: { minEntryId?: number; maxEntryId?: number }) =>
					options.entries?.(query) ?? { items: [], more: false },
				send: (send: { requestId: string; text: string }) => {
					sent.push({ conversation: input.conversation, requestId: send.requestId, text: send.text });
					return { submissionId: sent.length };
				},
				stop: () => ({ restored: [] }),
				dequeue: () => ({ text: null }),
				configure: () => {},
			};
		},
	];
	const drafts: Stub = [
		Drafts,
		(_input, _principal, self) => ({
			variant: "author",
			drafts: self.state([]),
			claim: () => ({ texts: [] }),
		}),
	];
	const setup = await topology(t, {
		server: [sessionsStub(SESSION)],
		worker: [chat, drafts],
		facets: [tuiCoreFacet, chatTui, ...(options.facets ?? [])],
		...(options.ready ? { ready: options.ready } : {}),
	});
	return { ...setup, stubs };
}

const longAnswer = (count: number, prefix = "line") =>
	Array.from({ length: count }, (_, i) => `${prefix}-${i}`).join("\n\n");

test("reading position: held while output grows, kept across facet reload, ctrl+end follows again", async (t) => {
	const { worker, reload, stubs, screen, send } = await chatRuntime(t, () => viewOf([answerEntry(1, longAnswer(60))]));
	await poll(async () => (await screen()).includes("line-59"));
	send(PAGE_UP);
	await poll(async () => !(await screen()).includes("line-59"));
	const before = await screen();
	// Entries never change once committed: the output grows by a new one.
	const grown = viewOf([answerEntry(1, longAnswer(60)), answerEntry(2, longAnswer(10, "appended"))]);
	stubs.get(1)!.latest = grown;
	await worker.root((root) => {
		// Every live instance of the object (released ones are disposed).
		for (const view of stubs.get(1)!.views)
			try {
				view.replace(root, grown);
			} catch {}
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(await screen(), before);
	// A facet reload recreates the chat surface: the anchor stored in the runtime restores the same lines.
	// A copy of the facet is a new facet value: its plugin's objects and slot are replaced.
	await reload([tuiCoreFacet, { ...chatTui }]);
	await poll(async () => (await screen()) === before, 5000, "restored reading position");
	send(CTRL_END);
	await poll(async () => (await screen()).includes("appended-9"));
});

test("history prepend keeps the visible content; ctrl+home reaches the conversation start", async (t) => {
	// The window starts at a compaction marker; older entries come from earlier pages.
	const older = Array.from({ length: 20 }, (_, i) => answerEntry(i + 1, `older-${i}`, i + 1));
	let pages = 0;
	const marker = entry(30, {
		kind: "pi.compaction",
		head: 21 as EntryId,
		model: [{ role: "user", content: "S", timestamp: 30 }],
	});
	const window = { ...viewOf([marker, answerEntry(31, longAnswer(40, "recent"), 31)]), before: 20 as EntryId };
	const setup = await chatRuntime(t, () => window, {
		entries: () => {
			pages++;
			return { items: older.toReversed(), more: false };
		},
	});
	const { screen, send } = setup;
	await poll(async () => (await screen()).includes("recent-39"));
	send(PAGE_UP);
	await poll(async () => !(await screen()).includes("recent-39"));
	send(CTRL_HOME);
	// At the top the page loads; what was visible stays put while older entries arrive above it.
	await poll(() => pages > 0);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const after = (await screen()).split("\n");
	// The marker stays on the row it had below the header; older entries fill the rows above it.
	assert.equal(
		after.findIndex((line) => line.includes("[compaction]")),
		6,
	);
	assert.match(after.slice(0, 6).join("\n"), /older-19/);
	send(CTRL_HOME);
	await poll(async () => (await screen()).includes("older-0"));
});

test("a gap in view fills its missing entries; its Load more line goes", async (t) => {
	const queries: { minEntryId?: number; maxEntryId?: number }[] = [];
	const { worker, stubs, screen } = await chatRuntime(t, () => viewOf([answerEntry(1, "first answer")]), {
		entries: (query) => {
			queries.push(query);
			return { items: [answerEntry(5, "filled answer")], more: false };
		},
	});
	await poll(async () => (await screen()).includes("first answer"));
	// The window moved on while entries 2 to 9 were never seen: a gap.
	const later = { ...viewOf([answerEntry(10, "later answer")]), before: 9 as EntryId };
	stubs.get(1)!.latest = later;
	await worker.root((root) => {
		for (const view of stubs.get(1)!.views)
			try {
				view.replace(root, later);
			} catch {}
	});
	await poll(async () => (await screen()).includes("filled answer"));
	assert.deepEqual(queries, [{ minEntryId: 2, maxEntryId: 9, order: "ascending", limit: 100 }]);
	assert(!(await screen()).includes("Load more"));
});

test("identity: conversations keep their own handles, drafts, send IDs and reading positions; snapshot round trip", async (t) => {
	const { runtime, stubs, screen, send } = await chatRuntime(t, (conversation) =>
		viewOf([answerEntry(1, `conversation ${conversation} answer`)]),
	);
	await poll(async () => (await screen()).includes("conversation 1 answer"));
	for (const char of "draft one") send(char);
	runtime.navigate("chat", "s", 2);
	await poll(async () => (await screen()).includes("conversation 2 answer"));
	assert(!(await screen()).includes("draft one"));
	for (const char of "second") send(char);
	send("\r");
	await poll(() => (stubs.get(2)?.sent.length ?? 0) === 1);
	assert.equal(stubs.get(2)!.sent[0]!.conversation, 2);
	assert.equal(stubs.get(1)!.sent.length, 0);
	runtime.navigate("chat", "s", 1);
	await poll(async () => (await screen()).includes("draft one"));
	assert.equal(runtime.drafts.get("s#1"), "draft one");
	// The reload snapshot carries identity, drafts, pending send IDs and anchors; version 1 drafts migrate.
	runtime.submissions.set("s#1", { text: "pending", id: "send-1", mode: "steer" });
	runtime.anchors.set("s#2", { key: "1", entryId: 1, offset: 3 });
	const snapshot = JSON.parse(JSON.stringify(snapshotRuntime(runtime)));
	const restored = new TuiRuntime(runtime.host, new TuiAltScreen(new VirtualTerminal(80, 24)));
	restoreRuntime(restored, snapshot);
	assert.equal(restored.identity, "s#1");
	assert.equal(restored.drafts.get("s#1"), "draft one");
	assert.deepEqual(restored.submissions.get("s#1"), { text: "pending", id: "send-1", mode: "steer" });
	assert.deepEqual(restored.anchors.get("s#2"), { key: "1", entryId: 1, offset: 3 });
	const legacy = new TuiRuntime(runtime.host, new TuiAltScreen(new VirtualTerminal(80, 24)));
	restoreRuntime(legacy, {
		session: "s",
		conversation: 1,
		screen: "chat",
		scroll: 4,
		drafts: [["s", "old"]],
		submissions: [],
	});
	assert.equal(legacy.drafts.get("s#1"), "old");
	restoreRuntime(legacy, { drafts: "nonsense", anchors: [["x", { key: 1 }]], screen: "evil" });
	assert.equal(legacy.screen, "chat");
	assert.equal(legacy.anchors.size, 0);
});

test("while the conversation connects, typed keys stay in the editor and Enter sends once it is live", async (t) => {
	let open = (): void => {};
	const ready = new Promise<void>((resolve) => {
		open = resolve;
	});
	const { runtime, stubs, screen, send } = await chatRuntime(t, () => viewOf([answerEntry(1, "ready")]), { ready });
	for (const char of "typed early") send(char);
	send("\r");
	// Shown at once (no transcript yet: in the pending area) and out of the editor; sent once the conversation is live.
	await poll(() => runtime.drafts.get("s#1") === "");
	await poll(async () => (await screen()).includes("Sending: typed early"));
	assert.equal(stubs.get(1)?.sent.length ?? 0, 0);
	open();
	await poll(() => stubs.get(1)?.sent.length === 1);
	assert.equal(stubs.get(1)!.sent[0]!.text, "typed early");
});

test("Ctrl+D exits only on an empty editor; Ctrl+C clears, twice exits", async (t) => {
	const { runtime, screen, send } = await chatRuntime(t, () => viewOf([answerEntry(1, "ready")]));
	let exits = 0;
	runtime.onExit = () => exits++;
	await poll(async () => (await screen()).includes("ready"));
	for (const char of "abc") send(char);
	send(LEFT);
	send(CTRL_D);
	await poll(() => runtime.drafts.get("s#1") === "ab");
	assert.equal(exits, 0, "Ctrl+D with text deletes forward");
	send(CTRL_C);
	await poll(() => runtime.drafts.get("s#1") === "");
	assert.equal(exits, 0);
	send(CTRL_C);
	assert.equal(exits, 1, "a second Ctrl+C within 500 ms exits");
	await new Promise((resolve) => setTimeout(resolve, 600));
	send(CTRL_D);
	assert.equal(exits, 2, "Ctrl+D on an empty editor exits");
	const surface = (runtime.ctx.surface("chat") as ChatSurface | undefined)!;
	assert(surface instanceof ChatSurface);
});

test("plugin contributions: tool renderers, entry renderers and Markdown transformers", async (t) => {
	const contributions = defineFacet((_host, self) => {
		self.contribute(TuiToolRenderers, {
			artifact: {
				renderCall: (args, th) => new Text(th.fg("accent", `artifact card ${String(args.name)}`), 0, 0),
			},
		});
		self.contribute(TuiEntryRenderers, {
			"test.note": (record) => new Text(`note entry ${JSON.stringify(record.data)}`, 1, 0),
		});
		self.contribute(TuiMarkdownTransformers, {
			"10:test": (markdown) => markdown.replace("TOKEN", "transformed"),
		});
	});
	const call = { type: "toolCall" as const, id: "a1", name: "artifact", arguments: { name: "report" } };
	const { screen } = await chatRuntime(
		t,
		() =>
			viewOf([
				answerEntry(1, "answer with TOKEN"),
				entry(2, { kind: "test.note", data: { n: 1 } }),
				entry(3, { kind: "pi.assistant", model: [assistant([call], { stopReason: "toolUse", timestamp: 3 })] }),
			]),
		{ facets: [contributions] },
	);
	await poll(async () => (await screen()).includes("artifact card report"));
	const shown = await screen();
	assert.match(shown, /answer with transformed/);
	assert.match(shown, /note entry \{"n":1\}/);
});

test("footer provenance: owner sees context against the model window, guests get tokens without a denominator", async (t) => {
	const session: Session = {
		id: "s",
		cwd: "/work",
		title: "Footer fixture",
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		pinned: false,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "medium",
		main: 1,
		branches: [],
	};
	const view = viewOf([answerEntry(1, "hello")], {
		"pi.agent": { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "medium" },
		"pi.usage": {
			models: { "faux/faux-1": { ...usage, cacheRead: 30, cost: { ...usage.cost, total: 0.25 } } },
			tools: {},
		},
	});
	const answer = view.entries[0]?.model?.[0];
	assert(answer?.role === "assistant");
	const stats = { contextTokens: 42, latestAssistantUsage: answer.usage };
	let modelsRequested = 0;
	const chat: Stub = [
		Chat,
		(_input, _principal, self) => ({
			variant: "viewer",
			view: self.state(view),
			stats: self.state(stats),
			model: self.state(null),
			liveShell: self.state(null),
			entries: () => ({ items: [], more: false }),
		}),
	];
	const metrics: Stub = [
		SessionMetrics,
		(_input, _principal, self) => ({
			variant: "reader",
			clients: self.state(1),
			usage: self.state({
				...usage,
				cost: { ...usage.cost, total: 1.5 },
			}),
		}),
	];
	const models: Stub = [
		Models,
		(_input, _principal, self) => {
			modelsRequested++;
			return {
				variant: "owner",
				models: self.state([
					{ provider: "faux", modelId: "faux-1", name: "Faux", thinkingLevels: ["off"], contextWindow: 1000 },
				]),
				resources: self.state({
					version: 1,
					settings: {},
					credentials: [],
					providers: [],
					models: [],
					errors: [],
				}),
				defaultModel: self.state(null),
				errors: self.state([]),
				enabledModels: self.state([]),
				scopedModels: self.state([]),
				setDefault: () => {},
				setEnabledModels: () => {},
			};
		},
	];
	const footerOf = async (role: "owner" | "guest", ready: RegExp) => {
		const { screen } = await topology(t, {
			server: [sessionsStub(session), metrics, models],
			worker: [chat],
			facets: [statusTui],
			role,
			columns: 100,
		});
		await poll(async () => ready.test(await screen()));
		return screen();
	};
	const guest = await footerOf("guest", /Footer fixture[\s\S]*\$0\.250/);
	assert.equal(modelsRequested, 0, "guests never request the owner-only catalog");
	assert.match(guest, /\/work • Footer fixture/);
	assert.match(guest, /↑12 ↓3 R30 CH0\.0% \$0\.250 \d+ ctx session \$1\.500/);
	assert.match(guest, /\(faux\) faux-1 • medium/);
	assert(!/%\/1\.0k/.test(guest));
	await footerOf("owner", /\d+\.\d%\/1\.0k/);
	assert(modelsRequested > 0);
});

test(
	"the copied components and tool renderers run inside the permission-dropped worker",
	{ skip: Number(process.versions.node.split(".")[0]) < 26, timeout: 90000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const browser = fixture.browser();
		const token = (await browser.hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		if (sessions.variant !== "owner") return;
		await sessions.create({ cwd: fixture.workspace, env: null }, BACKGROUND_CONTEXT);
		const terminal = new VirtualTerminal(100, 40);
		const failures: string[] = [];
		const client = await startTuiClient({
			terminal,
			url,
			credentials: await claimOwner(url, token, {}),
			pollMs: 1000,
			onFailure: (message) => failures.push(message),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 20000, "session list");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("(faux) faux-1"), 10000, "chat screen");
		// The editor appears once the conversation handle is live.
		await poll(
			async () => {
				const drafts = ((await client.snapshot()) as { drafts: [string, string][] }).drafts;
				if (drafts.some(([, text]) => text === "codemode")) return true;
				terminal.sendInput("\x15");
				for (const char of "codemode") terminal.sendInput(char);
				return false;
			},
			10000,
			"editor",
		);
		terminal.sendInput("\r");
		// quiet-tools draws the call as one line; Ctrl+O expands it into the full card.
		await poll(async () => /› codemode 2 calls: bash, read ✓/.test(await screen()), 30000, "quiet code mode line");
		terminal.sendInput("\x0f");
		// pi's code mode card: the script, its nested bash/read calls and the output.
		// Live rows can settle before the result commits; the output comes with the result.
		await poll(async () => /✓ bash[\s\S]*✓ read[\s\S]*bash: written/.test(await screen()), 30000, "code mode card");
		const shown = await screen();
		assert.match(shown, /codemode\s*\n\s*const written = await tools\.bash/);
		assert.match(shown, /bash: written/);
		assert.doesNotMatch(shown, /Unavailable in the TUI sandbox|ERR_ACCESS_DENIED|Error:/);
		// Mermaid (grok-mermaid) renders in the sandbox too: a message with a diagram, Shift+Enter between lines.
		const lines = ["```mermaid", "graph TD", "Alpha-->Beta", "```"];
		lines.forEach((line, index) => {
			for (const char of line) terminal.sendInput(char);
			if (index < lines.length - 1) terminal.sendInput("\x1b[13;2u");
		});
		terminal.sendInput("\r");
		await poll(async () => /│ Alpha │[\s\S]*│ Beta │/.test(await screen()), 30000, "mermaid diagram");
		assert.doesNotMatch(await screen(), /ERR_ACCESS_DENIED|Error:/);
		assert.deepEqual(failures, []);
	},
);
