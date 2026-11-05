// `/fork`, `/clone` and `doubleEscapeAction: "fork"` in the TUI (p2-tui-port.md section 10.8): pi's message picker,
// `Sessions.fork` before the chosen message with its text in the new session's editor, `Sessions.clone`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConversationView, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Chat, type ModelMeta } from "../../plugins/chat/contract.ts";
import chatTui, { ChatSurface } from "../../plugins/chat/tui.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { poll } from "./helpers.ts";
import { SESSION, topology } from "./tui-fixture.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const META: ModelMeta = {
	provider: "faux",
	modelId: "faux-1",
	name: "Faux",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};
const OWNER = { kind: "owner" as const, id: "owner", name: "Owner" };
const input = (id: number, text: string) => ({
	id: id as EntryId,
	conversationId: ROOT_CONVERSATION_ID,
	kind: "p2.input",
	data: { author: OWNER, text, attachments: [] },
	model: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: id }],
});
const typed = (send: (data: string) => void, text: string) => {
	for (const char of text) send(char);
};

test("/fork picks a message and opens the fork with it in the editor; /clone; double Escape; subagents refused", async (t) => {
	const calls: Record<string, unknown[]> = {};
	const record = (name: string, args: unknown) => {
		calls[name] = [...(calls[name] ?? []), args];
	};
	const view = (conversation: number): ConversationView => ({
		conversation: { id: conversation } as ConversationView["conversation"],
		entries: conversation === 1 ? [input(1, "first question"), input(3, "second question")] : [],
		docs: { "pi.agent": { model: { provider: "faux", modelId: "faux-1" } } } as ConversationView["docs"],
	});
	const { send, runtime, screen } = await topology(t, {
		server: [
			[
				Sessions,
				(_input, _principal, self) => {
					const sessions = self.state([SESSION]);
					const defaultCwd = self.state("/work");
					const defaultEnv = self.state(null);
					const copy = (id: string, mark: string, ctx: Ctx): Session => {
						const created = { ...SESSION, id, title: `${SESSION.title} (${mark})` };
						sessions.replace(ctx, [...(sessions.value ?? []), created]);
						return created;
					};
					return {
						variant: "owner",
						sessions,
						defaultCwd,
						defaultEnv,
						create: () => SESSION,
						relocate: () => {},
						rename: () => {},
						pin: () => {},
						archive: () => {},
						restore: () => {},
						clone: (args: { id: string }, ctx: Ctx) => {
							record("clone", args);
							return copy(`clone-${calls.clone?.length}`, "copy", ctx);
						},
						fork: (args: { id: string; conversation: number; before: number }, ctx: Ctx) => {
							record("fork", args);
							return copy(`fork-${calls.fork?.length}`, "fork", ctx);
						},
					};
				},
			],
		],
		worker: [
			[
				Chat,
				(raw, _principal, self) => ({
					variant: "participant",
					view: self.state(view((raw as { conversation: number }).conversation)),
					model: self.state(META),
					liveShell: self.state(null),
					stats: self.state(null),
					entries: () => ({ items: [], more: false }),
					send: () => ({ submissionId: 1 }),
					stop: () => {
						record("stop", true);
						return { restored: [] };
					},
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
	// /fork: pi's picker, the newest message selected; Up picks the first.
	typed(send, "/fork");
	send(ENTER);
	await poll(async () => (await screen()).includes("Fork from Message"));
	assert.match(await screen(), /› second question[\s\S]*Message 2 of 2/);
	send(UP);
	send(ENTER);
	await poll(() => (calls.fork?.length ?? 0) === 1);
	assert.deepEqual(calls.fork?.[0], { id: "s", conversation: 1, before: 1 });
	// The fork is open with the chosen message in its editor (this fixture's single worker serves only "s").
	await poll(() => runtime.identity === "fork-1#1");
	assert.equal(runtime.drafts.get("fork-1#1"), "first question");
	assert.equal(chat().editor.getText(), "first question");
	assert(runtime.notices.some((notice) => notice.text === "Forked to new session"));
	// /clone opens the copy.
	assert(runtime.ctx.commands.run("p2.session.clone"));
	await poll(() => runtime.identity === "clone-1#1");
	assert.deepEqual(calls.clone, [{ id: "fork-1" }]);
	runtime.navigate("chat", "s", 1);
	await poll(() => chat().editable);
	// doubleEscapeAction "fork": a second Escape within 500 ms on an empty editor opens the picker; "none" never.
	runtime.appearance.settings = { doubleEscapeAction: "none" };
	send(ESC);
	send(ESC);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.doesNotMatch(await screen(), /Fork from Message/);
	runtime.appearance.settings = { doubleEscapeAction: "fork" };
	send(ESC);
	send(ESC);
	await poll(async () => (await screen()).includes("Fork from Message"));
	send(ESC);
	await poll(async () => !(await screen()).includes("Fork from Message"));
	// In a subagent conversation: refused for now.
	runtime.navigate("chat", "s", 2);
	await poll(() => chat().editable);
	typed(send, "/fork");
	send(ENTER);
	await poll(() => runtime.notices.some((notice) => /subagent conversation is not supported/.test(notice.text)));
	assert.equal(calls.fork?.length, 1);
});
