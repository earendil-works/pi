// `!cmd`/`!!cmd` in the TUI (p2-tui-port.md section 10.8): pi's bash mode border, `Chat.shell`, the live command as
// pi's bash execution component at the end of the transcript, Escape cancels, one command at a time, and finished
// `p2.shell` entries rendered by the chat facet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConversationView, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Chat, type ModelMeta, SHELL_BUSY, type ShellState } from "../../plugins/chat/contract.ts";
import chatTui, { ChatSurface } from "../../plugins/chat/tui.ts";
import statusTui from "../../plugins/status/tui.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { SHELL_ENTRY, type ShellData } from "../../src/runtime/shell.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { poll } from "./helpers.ts";
import { SESSION, sessionsStub, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const ESC = "\x1b";
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
const OWNER = { kind: "owner" as const, id: "owner", name: "Owner" };
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};
const finished: ShellData = {
	author: { kind: "guest", id: "alice", name: "Alice" },
	command: "make test",
	output: "FAIL parser\n\x1b]52;c;evil\x07done",
	exitCode: 3,
	cancelled: false,
	truncated: false,
	includeInContext: true,
};
const view: ConversationView = {
	conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
	entries: [
		{
			id: 1 as EntryId,
			conversationId: ROOT_CONVERSATION_ID,
			kind: SHELL_ENTRY,
			data: finished as never,
			model: [{ role: "user", content: [{ type: "text", text: "Ran `make test`" }], timestamp: 1 }],
		},
	],
	docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
};

test("`!` and `!!` run commands; the live one shows at the end; Escape cancels; entries render as pi", async (t) => {
	const calls: Record<string, unknown[]> = {};
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	const { screen, send, runtime } = await topology(t, {
		server: [sessionsStub(SESSION)],
		worker: [
			[
				Chat,
				(_input, _principal, self) => {
					const viewState = self.state(view);
					const model = self.state(META);
					const liveShell = self.state<ShellState>(null);
					let live: ShellState = null;
					return {
						variant: "participant",
						view: viewState,
						model,
						liveShell,
						stats: self.state(null),
						entries: () => ({ items: [], more: false }),
						send: () => ({ submissionId: 1 }),
						stop: () => ({ restored: [] }),
						dequeue: () => ({ text: null }),
						configure: () => {},
						compact: () => ({ taskId: 1 }),
						abortCompaction: () => ({ aborted: 0 }),
						reset: () => {},
						dequeueOwn: () => ({ restored: [], skipped: 0 }),
						shell: (args: { command: string; includeInContext: boolean }, ctx: Ctx) => {
							record("shell", args);
							live = {
								id: `sh${calls.shell?.length}`,
								command: args.command,
								author: OWNER,
								includeInContext: args.includeInContext,
								output: "partial output",
								truncated: false,
								running: true,
								cancelled: false,
							};
							liveShell.replace(ctx, live);
							return { shellId: live.id };
						},
						abortShell: ({ shellId }: { shellId: string }, ctx: Ctx) => {
							record("abortShell", shellId);
							if (!live) return { aborted: false };
							live = { ...live, running: false, cancelled: true };
							liveShell.replace(ctx, live);
							return { aborted: true };
						},
					};
				},
			],
		],
		facets: [tuiCoreFacet, chatTui, statusTui],
		columns: 100,
	});
	runtime.navigate("chat", "s");
	// A finished command: pi's component with the author, its output (sanitized) and how it ended.
	await poll(async () => (await screen()).includes("$ make test · Alice (guest)"));
	let shown = await screen();
	assert.match(shown, /FAIL parser/);
	assert.match(shown, /\(exit 3\)/);
	assert.doesNotMatch(shown, /52;c;evil/);
	// Bash mode: the editor border takes pi's bash color while the text starts with `!`.
	const chat = runtime.ctx.surface("chat");
	assert(chat instanceof ChatSurface);
	const theme = runtime.theme.current;
	typed(send, "!ls -la");
	await poll(() => chat.editor.borderColor("x") === theme.getBashModeBorderColor()("x"));
	send(ENTER);
	await poll(() => (calls.shell?.length ?? 0) === 1);
	assert.deepEqual(calls.shell?.[0], {
		command: "ls -la",
		includeInContext: true,
		requestId: (calls.shell?.[0] as { requestId: string }).requestId,
	});
	await poll(async () => (await screen()).includes("$ ls -la") && (await screen()).includes("partial output"));
	assert.match(await screen(), /Running\.\.\./);
	await poll(() => chat.editor.getText() === "");
	// One at a time: a second command is refused with pi's text and stays in the editor.
	typed(send, "!!pwd");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => notice.text === SHELL_BUSY));
	assert.equal(calls.shell?.length, 1);
	assert.equal(chat.editor.getText(), "!!pwd");
	// Escape cancels the running command (not the agent).
	send(ESC);
	await poll(() => (calls.abortShell?.length ?? 0) === 1);
	assert.deepEqual(calls.abortShell, ["sh1"]);
	await poll(async () => (await screen()).includes("(cancelled)"));
	shown = await screen();
	assert.doesNotMatch(shown, /Running\.\.\./);
	// `!!`: excluded from the context.
	send(ENTER);
	await poll(() => (calls.shell?.length ?? 0) === 2);
	assert.equal((calls.shell?.[1] as { includeInContext: boolean }).includeInContext, false);
	assert.equal((calls.shell?.[1] as { command: string }).command, "pwd");
	await poll(() => chat.editor.getText() === "");
});
