// `Sessions.clone` and `Sessions.fork` (p2-tui-port.md section 10.8) on the real server and session workers with the
// fake provider: copies under new IDs, history, artifacts, and the refusals.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactList } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const text = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
const inputs = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).filter((entry) => entry.kind === "p2.input");

describe("clone and fork (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let source: Session;
	const chatOf = (id: string) => holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		const ref = await holdIn(owner, Sessions, {}, "owner");
		if (ref.variant !== "owner") throw new Error("owner expected");
		source = await ref.create({ cwd: fixture.workspace, title: "Parser work" }, BACKGROUND_CONTEXT);
		const chat = await chatOf(source.id);
		await chat.send({ text: "first", requestId: "1" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => text(view).includes("Echo: first"));
		await chat.send({ text: "artifact", requestId: "2" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => (view?.entries ?? []).some((entry) => entry.kind === "pi.tool-result"));
		await chat.send({ text: "second", requestId: "3" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => text(view).includes("Echo: second"));
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (value) => value?.[source.id]?.tasks === 0);
		chat.release();
	});
	after(async () => {
		await fixture?.close();
	});
	const ownerSessions = async () => {
		const ref = await holdIn(owner, Sessions, {}, "owner");
		if (ref.variant !== "owner") throw new Error("owner expected");
		return ref;
	};

	it("clones the whole session under a new ID chosen by the client; the original goes on", async () => {
		const ref = await ownerSessions();
		const chosen = randomUUID();
		// The page navigates to the copy before the answer: its worker waits until the copy is done.
		const early = holdIn(owner, Chat, { session: chosen, conversation: 1 }, "participant");
		const copy = await ref.clone({ id: source.id, copy: chosen }, BACKGROUND_CONTEXT);
		assert.equal(copy.id, chosen);
		assert.deepEqual(
			await ref.clone({ id: source.id, copy: chosen }, BACKGROUND_CONTEXT),
			copy,
			"a retry answers the same row",
		);
		const waiting = await early;
		await until(waiting.view, (next) => text(next).includes("Echo: second"));
		waiting.release();
		assert.equal(copy.title, "Parser work (copy)");
		assert.equal(copy.cwd, source.cwd);
		assert.deepEqual(copy.model, source.model);
		const cloned = await chatOf(copy.id);
		const view = await until(cloned.view, (next) => text(next).includes("Echo: second"));
		assert.match(text(view), /Echo: first/);
		// Artifacts come along: the index (in the store) and the files (under the new ID).
		const list = owner.hold(ArtifactList, { session: copy.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const artifacts = await until(list.artifacts, (value) => (value?.length ?? 0) === 1);
		const query = new URLSearchParams({ session: copy.id, name: artifacts![0]!.name, version: "1" });
		assert.equal((await fixture.http(`/artifact?${query}&download=1`)).status, 200);
		// Both go on independently.
		await cloned.send({ text: "only in the copy", requestId: "c1" }, BACKGROUND_CONTEXT);
		await until(cloned.view, (next) => text(next).includes("Echo: only in the copy"));
		const original = await chatOf(source.id);
		await original.send({ text: "only in the original", requestId: "o1" }, BACKGROUND_CONTEXT);
		const originalView = await until(original.view, (next) => text(next).includes("Echo: only in the original"));
		assert.doesNotMatch(text(originalView), /only in the copy/);
		const status = await holdIn(owner, SessionStatus, {}, "reader");
		await until(status.statuses, (value) => value?.[source.id]?.tasks === 0);
		cloned.release();
		original.release();
	});

	it("forks the history before a chosen message; refuses subagents and busy sources", async () => {
		const ref = await ownerSessions();
		const original = await chatOf(source.id);
		const view = await until(original.view, (next) => inputs(next).length >= 3);
		const second = inputs(view).find((entry) => (entry.data as { text?: string }).text === "second");
		assert(second);
		const fork = await ref.fork({ id: source.id, conversation: 1, before: second.id }, BACKGROUND_CONTEXT);
		assert.equal(fork.title, "Parser work (fork)");
		const forked = await chatOf(fork.id);

		const forkView = await until(forked.view, (next) => text(next).includes("Echo: first"));
		assert.doesNotMatch(text(forkView), /Echo: second|second/);
		assert.equal(inputs(forkView).length, 2, "the inputs before the chosen one");
		// The source's files were copied by its worker: the artifact cards of the forked history resolve under the fork.
		const card = new URLSearchParams({ session: fork.id, name: "demo", version: "1" });
		assert.equal((await fixture.http(`/artifact?${card}&download=1`)).status, 200);
		// The fork works on its own.
		await forked.send({ text: "forked on", requestId: "f1" }, BACKGROUND_CONTEXT);
		await until(forked.view, (next) => text(next).includes("Echo: forked on"));
		// Before the first message: an empty session.
		const first = inputs(view)[0]!;
		const empty = await ref.fork({ id: source.id, conversation: 1, before: first.id }, BACKGROUND_CONTEXT);
		const emptyChat = await chatOf(empty.id);
		const emptyView = await until(emptyChat.view, (next) => next !== null && next !== undefined);
		assert.equal(emptyView?.entries.length, 0);
		await assert.rejects(
			ref.fork({ id: source.id, conversation: 2, before: first.id }, BACKGROUND_CONTEXT),
			/subagent/,
		);
		await assert.rejects(
			ref.fork({ id: source.id, conversation: 1, before: 999_999 }, BACKGROUND_CONTEXT),
			/Unknown message/,
		);
		// A running command keeps the worker busy: cloning waits for it.
		if (original.variant !== "participant") throw new Error("participant expected");
		const { shellId } = await original.shell(
			{ command: "sleep 20", includeInContext: false, requestId: "s1" },
			BACKGROUND_CONTEXT,
		);
		await until(original.liveShell, (value) => Boolean(value?.running));
		// The clone's row is there at once; the busy worker refuses the copy: the operation fails visibly and the row is
		// archived again (rolled back).
		const refused = await ref.clone({ id: source.id }, BACKGROUND_CONTEXT);
		const operations = await until(ref.operations, (list) =>
			(list ?? []).some((each) => each.target === refused.id && each.phase === "failed"),
		);
		const failure = operations!.find((each) => each.target === refused.id);
		assert(failure?.phase === "failed");
		assert.match(failure.error, /before cloning/);
		await until(ref.sessions, (rows) => rows?.find((row) => row.id === refused.id)?.archivedAt !== null);
		await ref.dismissOperation({ operation: failure.id }, BACKGROUND_CONTEXT);
		await until(ref.operations, (list) => !(list ?? []).some((each) => each.id === failure.id));
		await original.abortShell({ shellId }, BACKGROUND_CONTEXT);
		await until(original.liveShell, (value) => value === null);
		forked.release();
		emptyChat.release();
		original.release();
	});
});
