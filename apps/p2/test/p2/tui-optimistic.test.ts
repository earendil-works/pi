// Optimistic UI in the TUI (docs/optimistic-ui.md): a session rename, a pin and a sent message show at once, while
// their calls are still in flight; a refused call rolls back and says why. The stubs hold each call open until the
// test lets it settle, so what the screen shows meanwhile is the guess, not the server's state.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui, { ChatSurface } from "../../plugins/chat/tui.ts";
import { type Operation, type Session, Sessions } from "../../plugins/sessions/contract.ts";
import sessionsTui, { SessionsSurface } from "../../plugins/sessions/tui.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { poll } from "./helpers.ts";
import { SESSION, type Stub, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_R = "\x12";
const ALT_P = "\x1bp";
const CTRL_A = "\x01";
const CTRL_K = "\x0b";
const CTRL_N = "\x0e";
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
const VIEW: ConversationView = {
	conversation: { id: ROOT_CONVERSATION_ID } as ConversationView["conversation"],
	entries: [],
	docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
};

/** A call the test settles: `call()` waits until `pass()` or `refuse(message)`. */
function gate() {
	let open = Promise.withResolvers<void>();
	return {
		call: async () => open.promise,
		pass: () => open.resolve(),
		refuse: (message: string) => open.reject(new Error(message)),
		reset: () => {
			open = Promise.withResolvers<void>();
		},
	};
}

/** The owner's catalog with rename and pin held open by `held`; each change commits only once its call passes. */
function catalog(held: ReturnType<typeof gate>): Stub {
	return [
		Sessions,
		(_input, _principal, self) => {
			const rows = self.state<Session[]>([SESSION]);
			const update = (ctx: Ctx, patch: Partial<Session>) =>
				rows.replace(
					ctx,
					(rows.value ?? []).map((row) => ({ ...row, ...patch })),
				);
			return {
				variant: "owner",
				sessions: rows,
				defaultCwd: self.state("/work"),
				defaultEnv: self.state(null),
				operations: self.state([]),
				dismissOperation: () => {},
				rename: async (args: { title: string }, ctx: Ctx) => {
					await held.call();
					update(ctx, { title: args.title });
				},
				pin: async (args: { pinned: boolean }, ctx: Ctx) => {
					await held.call();
					update(ctx, { pinned: args.pinned });
				},
				// The owner variant's other methods: not used here.
				create: () => SESSION,
				relocate: () => {},
				archive: () => {},
				restore: () => {},
				clone: () => SESSION,
				fork: () => SESSION,
			};
		},
	];
}

test("session selector: a rename and a pin show before their calls answer; a refused rename rolls back", async (t) => {
	const held = gate();
	const { screen, send, runtime } = await topology(t, {
		server: [catalog(held)],
		worker: [],
		facets: [tuiCoreFacet, sessionsTui],
		columns: 100,
	});
	runtime.navigate("sessions", "s");
	const listed = async (title: string) => new RegExp(`^(?: {2}|› ) {2}${title}`, "m").test(await screen());
	await poll(() => listed("Fixture"));
	send(DOWN);
	send(CTRL_R);
	await poll(async () => (await screen()).includes("Rename session"));
	send(CTRL_A);
	send(CTRL_K);
	typed(send, "Guessed title");
	send(ENTER);
	// The call is held open: the row already shows the new title.
	await poll(() => listed("Guessed title"));
	held.pass();
	await poll(async () => (await screen()).includes("Session name: Guessed title"));
	assert(await listed("Guessed title"));
	// A pin: with only pinned sessions listed, the row stays listed while the call is held open.
	held.reset();
	send(ALT_P);
	send(CTRL_N);
	await poll(async () => (await screen()).includes("Pinned: Only"));
	assert(await listed("Guessed title"));
	held.pass();
	await poll(async () => /^\s*Pinned\s*$/m.test(await screen()));
	send(CTRL_N);
	// A refused rename: shown, then the old title is back and the error is a status line.
	held.reset();
	send(DOWN);
	send(CTRL_R);
	await poll(async () => (await screen()).includes("Rename session"));
	send(CTRL_A);
	send(CTRL_K);
	typed(send, "Refused title");
	send(ENTER);
	await poll(() => listed("Refused title"));
	held.refuse("titles are frozen");
	await poll(() => listed("Guessed title"));
	await poll(() =>
		runtime.notices.some((notice) => notice.kind === "error" && notice.text.includes("titles are frozen")),
	);
});

test("chat: a sent message shows and leaves the editor at once; a refused one comes back to the editor", async (t) => {
	const held = gate();
	const sent: string[] = [];
	const { screen, send, runtime } = await topology(t, {
		server: [[Sessions, (_input, _principal, self) => ({ variant: "guest", sessions: self.state([SESSION]) })]],
		worker: [
			[
				Chat,
				(_input, _principal, self) => ({
					variant: "participant",
					view: self.state(VIEW),
					model: self.state(META),
					liveShell: self.state(null),
					stats: self.state(null),
					entries: () => ({ items: [], more: false }),
					send: async (args: { text: string }) => {
						sent.push(args.text);
						await held.call();
						return { submissionId: sent.length };
					},
					stop: () => ({ restored: [] }),
					dequeue: () => ({ text: null }),
					configure: () => {},
					compact: () => ({ taskId: 1 }),
					abortCompaction: () => ({ aborted: 0 }),
					reset: () => {},
					dequeueOwn: () => ({ restored: [], skipped: 0 }),
					shell: () => ({ shellId: "x" }),
					abortShell: () => ({ aborted: false }),
				}),
			],
		],
		facets: [tuiCoreFacet, chatTui],
		columns: 100,
	});
	runtime.navigate("chat", "s");
	const chat = () => {
		const surface = runtime.ctx.surface("chat");
		assert(surface instanceof ChatSurface);
		return surface;
	};
	await poll(() => chat().editable);
	typed(send, "hello there");
	send(ENTER);
	await poll(() => sent.length === 1);
	// Held open: the editor is empty and the message is in the transcript.
	assert.equal(chat().editor.getText(), "");
	await poll(async () => (await screen()).includes("hello there"));
	held.refuse("not now");
	// Refused: back in the editor, out of the transcript, the error on a status line.
	await poll(() => chat().editor.getText() === "hello there");
	await poll(() => runtime.notices.some((notice) => notice.kind === "error" && notice.text.includes("not now")));
	// Only the editor shows it now, not the transcript.
	await poll(async () => (await screen()).split("hello there").length === 2);
});

test("session selector: lifecycle operations mark their rows; a failure is announced and /dismiss-failed clears it", async (t) => {
	const dismissed: string[] = [];
	const { screen, runtime } = await topology(t, {
		server: [
			[
				Sessions,
				(_input, _principal, self) => {
					const operations = self.state<Operation[]>([
						{ phase: "running", id: "op1", kind: "relocate", session: "s", target: null, copying: false },
					]);
					return {
						variant: "owner",
						sessions: self.state<Session[]>([SESSION]),
						defaultCwd: self.state("/work"),
						defaultEnv: self.state(null),
						operations,
						dismissOperation: ({ operation }: { operation: string }, ctx: Ctx) => {
							dismissed.push(operation);
							operations.replace(
								ctx,
								(operations.value ?? []).filter((each) => each.id !== operation),
							);
						},
						// The worker refuses the move: the job ends failed.
						rename: (_args: unknown, ctx: Ctx) =>
							operations.replace(ctx, [
								{
									phase: "failed",
									id: "op1",
									kind: "relocate",
									session: "s",
									target: null,
									error: "Stop the current run first",
								},
							]),
						create: () => SESSION,
						relocate: () => {},
						pin: () => {},
						archive: () => {},
						restore: () => {},
						clone: () => SESSION,
						fork: () => SESSION,
					};
				},
			],
		],
		worker: [],
		facets: [tuiCoreFacet, sessionsTui],
		columns: 100,
	});
	runtime.navigate("sessions", "s");
	await poll(async () => /Fixture.*moving…/.test(await screen()));
	// (The stub turns the running move into a failed one on any rename.)
	const surface = runtime.ctx.surface("sessions");
	assert(surface instanceof SessionsSurface);
	surface.renameSession("s", "x");
	await poll(() =>
		runtime.notices.some(
			(notice) => notice.kind === "error" && notice.text.includes("Move failed: Stop the current run first"),
		),
	);
	await poll(async () => /Fixture.*Move failed/.test(await screen()));
	assert(runtime.ctx.commands.run("p2.session.dismissFailed"));
	await poll(() => dismissed.length === 1);
	await poll(async () => !(await screen()).includes("Move failed "));
});
