import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type RefWith, whenLive } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat, type ChatParticipant } from "../../plugins/chat/contract.ts";
import {
	ConversationBroker,
	Conversations,
	PeerConversation,
	type Query,
} from "../../plugins/conversations/contract.ts";
import { Drafts } from "../../plugins/drafts/contract.ts";
import { Projects } from "../../plugins/projects/contract.ts";
import { SESSIONS_OWNER, Sessions, type SessionsOwner } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { PEER_MESSAGE_ENTRY } from "../../src/runtime/entries.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { expectChord, type Fixture, holdWith, http, startFixture, until } from "./helpers.ts";

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "conversations",
		),
	);
const text = (result: ToolResultMessage | undefined): string =>
	(result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const peers = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).filter((entry) => entry.kind === PEER_MESSAGE_ENTRY);

describe("conversations (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: SessionsOwner;
	let status: RefWith<typeof SessionStatus, "statuses">;
	let alpha: string;
	let beta: string;
	let archived: string;
	let a: ChatParticipant;
	let b: ChatParticipant;
	let serial = 0;
	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		owner = fixture.browser();
		sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		alpha = (await sessions.create({ cwd: fixture.workspace, title: "Alpha" }, BACKGROUND_CONTEXT)).id;
		beta = (await sessions.create({ cwd: fixture.workspace, title: "Beta" }, BACKGROUND_CONTEXT)).id;
		archived = (await sessions.create({ cwd: fixture.workspace, title: "Archived" }, BACKGROUND_CONTEXT)).id;
		await sessions.archive({ id: archived }, BACKGROUND_CONTEXT);
		a = await holdWith(owner, Chat, { session: alpha, conversation: 1 }, ...CHAT_PARTICIPANT);
		status = await holdWith(owner, SessionStatus, {}, "statuses");
	});
	after(async () => {
		await fixture?.close();
	});
	const call = async (chat: ChatParticipant, query: Query): Promise<ToolResultMessage> => {
		const count = results(await until(chat.view, (view) => Boolean(view))).length;
		await chat.send(
			{ text: `conversations ${JSON.stringify(query)}`, requestId: `tool-${++serial}` },
			BACKGROUND_CONTEXT,
		);
		const view = await until(
			chat.view,
			(view) => results(view).length > count && !(view?.docs["pi.live"] as { run?: unknown })?.run,
		);
		return results(view).at(-1)!;
	};
	const broker = (source: string, requestId: string, query: Query) =>
		fixture.server.host.root(
			async (ctx) => (await ctx.get(ConversationBroker, {})).query({ source, requestId, query }, ctx),
			BACKGROUND_CONTEXT,
		);

	it("lists root sessions without starting peers, excluding archives", async () => {
		const result = await call(a, { action: "list" });
		assert.equal(result.isError, false);
		assert.match(text(result), new RegExp(`${beta}: "Beta" · stopped · faux/faux-1`));
		assert.ok(text(result).includes(`Your ID: ${alpha}`));
		assert.ok(!text(result).includes(archived));
		const statuses = await until(status.statuses, (value) => value !== undefined);
		assert.equal(statuses?.[beta]?.running ?? false, false);
		assert.equal(text(await call(a, { action: "answer", to: beta })), "No completed answer found.");
		b = await holdWith(owner, Chat, { session: beta, conversation: 1 }, ...CHAT_PARTICIPANT);
	});

	it("attributes sends, explicitly replies from authenticated peers, and reads completed answers", async () => {
		const sent = await call(a, { action: "send", to: beta, message: "hello peer" });
		assert.equal(sent.isError, false);
		const view = await until(
			b.view,
			(view) => peers(view).length === 1 && !(view?.docs["pi.live"] as { run?: unknown })?.run,
		);
		assert.deepEqual(peers(view)[0]?.model?.[0]?.content, [
			{ type: "text", text: `<sender kind="session" id="${alpha}" title="Alpha"/>` },
			{ type: "text", text: "hello peer" },
		]);
		assert.deepEqual(peers(view)[0]?.data, { from: { id: alpha, title: "Alpha" }, text: "hello peer" });
		assert.equal(peers(await until(a.view, Boolean)).length, 0, "final answers are not forwarded");
		const answer = await call(a, { action: "answer", to: beta });
		assert.equal(text(answer), "Echo: hello peer");
		assert.ok(!text(answer).includes("private-thinking-sentinel"));
		const reply = `conversations ${JSON.stringify({ action: "send", to: alpha, message: "explicit peer reply" })}`;
		await call(a, { action: "send", to: beta, message: reply });
		await until(a.view, (view) => peers(view).some((entry) => JSON.stringify(entry).includes("explicit peer reply")));
		const peerResult = await until(b.view, (view) => results(view).length === 1);
		assert.equal(results(peerResult)[0]?.isError, false, "a peer message's turn can use the tool");
	});

	it("deduplicates receipts across worker restart and handles concurrent cross-sends", async () => {
		const query = { action: "send", to: beta, message: "deduplicated sentinel" } as const;
		const once = await broker(alpha, "same-task", query);
		assert.deepEqual(await broker(alpha, "same-task", query), once);
		await until(status.statuses, (value) => value?.[beta]?.tasks === 0);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Hosts, {})).stop({ session: beta }, ctx),
			BACKGROUND_CONTEXT,
		);
		b.release();
		assert.deepEqual(await broker(alpha, "same-task", query), once);
		b = await holdWith(owner, Chat, { session: beta, conversation: 1 }, ...CHAT_PARTICIPANT);
		const view = await until(b.view, (view) =>
			peers(view).some((entry) => JSON.stringify(entry).includes("deduplicated sentinel")),
		);
		assert.equal(peers(view).filter((entry) => JSON.stringify(entry).includes("deduplicated sentinel")).length, 1);
		await Promise.all([
			broker(alpha, "cross-a", { action: "send", to: beta, message: "cross-a" }),
			broker(beta, "cross-b", { action: "send", to: alpha, message: "cross-b" }),
		]);
		await until(status.statuses, (value) => value?.[alpha]?.tasks === 0 && value?.[beta]?.tasks === 0);
	});

	it("reads the previous answer while busy, queues follow-ups, and rejects invalid destinations", async () => {
		const previous = await broker(alpha, "previous", { action: "answer", to: beta });
		assert.equal(previous.action, "answer");
		await b.send({ text: "slow-tool", requestId: "busy" }, BACKGROUND_CONTEXT);
		await until(b.view, (view) => JSON.stringify(view?.docs["pi.live"]).includes("tool-running"));
		const working = await broker(alpha, "working", { action: "answer", to: beta });
		assert.equal(working.action, "answer");
		assert.ok(
			working.action === "answer" && previous.action === "answer" && working.busy && working.text === previous.text,
		);
		await broker(alpha, "queued", { action: "send", to: beta, message: "queued peer", followUp: true });
		await until(b.view, (view) => JSON.stringify(view?.docs["pi.inbox"]).includes("queued peer"));
		await until(status.statuses, (value) => value?.[beta]?.tasks === 0);
		for (const query of [
			{ action: "send", to: alpha, message: "self" },
			{ action: "send", to: archived, message: "archived" },
			{ action: "answer", to: "missing" },
		] as const)
			assert.equal((await call(a, query)).isError, true);
		await fixture.server.reload(["conversations"]);
		assert.equal((await call(a, { action: "list" })).isError, false);
	});

	it("Stop keeps queued peer messages queued for the next input and gives people their text back", async () => {
		const gamma = (await sessions.create({ cwd: fixture.workspace, title: "Gamma" }, BACKGROUND_CONTEXT)).id;
		const chat = await holdWith(owner, Chat, { session: gamma, conversation: 1 }, ...CHAT_PARTICIPANT);
		const inbox = (view: ConversationView | null | undefined) => JSON.stringify(view?.docs["pi.inbox"] ?? {});
		const running = (view: ConversationView | null | undefined) =>
			(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined;
		await chat.send({ text: "slow-tool", requestId: "busy" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.docs["pi.live"]).includes("tool-running"));
		await chat.send({ text: "owner queued", requestId: "queued", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await broker(alpha, "kept", { action: "send", to: gamma, message: "kept peer", followUp: true });
		await until(chat.view, (view) => inbox(view).includes("kept peer"));
		assert.deepEqual(await chat.stop(BACKGROUND_CONTEXT), { restored: ["owner queued"] });
		// Kept as a failed run keeps its queue: still queued, no run answers it.
		await until(status.statuses, (value) => value?.[gamma]?.tasks === 0);
		const idle = await until(chat.view, (view) => !running(view));
		assert.ok(inbox(idle).includes("kept peer") && !inbox(idle).includes("owner queued"));
		assert.equal(peers(idle).length, 0);
		// The next input places it first; a run answers each.
		await chat.send({ text: "next", requestId: "next" }, BACKGROUND_CONTEXT);
		const answered = await until(
			chat.view,
			(view) =>
				!running(view) && !inbox(view).includes("kept peer") && view?.entries.at(-1)?.kind === "pi.assistant",
		);
		const kinds = (answered?.entries ?? []).map((entry) => entry.kind).filter((kind) => kind !== "pi.assistant");
		assert.deepEqual(kinds.slice(-2), [PEER_MESSAGE_ENTRY, "p2.input"]);
		assert.deepEqual(peers(answered)[0]?.data, { from: { id: alpha, title: "Alpha" }, text: "kept peer" });
		// A stop from another session gives people's queued text to their drafts, which their composer claims.
		await until(status.statuses, (value) => value?.[gamma]?.tasks === 0);
		await chat.send({ text: "slow-tool", requestId: "busy-again" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.docs["pi.live"]).includes("tool-running"));
		await chat.send({ text: "owner draft", requestId: "draft", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.docs["pi.inbox"]).includes("owner draft"));
		await broker(alpha, "stop-gamma", { action: "stop", to: gamma });
		const drafts = await holdWith(owner, Drafts, { session: gamma, conversation: 1 });
		const pending = await until(drafts.drafts, (value) => Boolean(value?.length));
		assert.deepEqual(
			pending?.map((draft) => draft.text),
			["owner draft"],
		);
		drafts.release();
		chat.release();
	});

	it("creates sessions in a project or a folder, stops, archives and restores them", async () => {
		const projects = await holdWith(owner, Projects, {});
		await projects.create({ name: "ws", place: { env: null, path: fixture.workspace } }, BACKGROUND_CONTEXT);
		await until(projects.projects, (list) => Boolean(list?.some((project) => project.name === "ws")));
		const query = { action: "create", project: "ws", message: "hello new" } as const;
		const created = await broker(alpha, "create-project", query);
		assert.ok(created.action === "create" && created.cwd === fixture.workspace && created.env === null);
		const fresh = created.to;
		const again = await broker(alpha, "create-project", query);
		assert.ok(again.action === "create" && again.to === fresh, "a retried call makes no second session");
		const listed = await broker(alpha, "list-created", { action: "list" });
		assert.ok(listed.action === "list" && listed.projects.some((project) => project.name === "ws"));
		// Its title follows its first message (the catalog's automatic title), so only the place is compared.
		const row = listed.action === "list" ? listed.peers.find((peer) => peer.id === fresh) : undefined;
		assert.deepEqual([row?.env, row?.cwd, row?.project], [null, fixture.workspace, "ws"]);
		const chat = await holdWith(owner, Chat, { session: fresh, conversation: 1 }, ...CHAT_PARTICIPANT);
		const first = await until(chat.view, (view) => peers(view).length === 1);
		assert.deepEqual(peers(first)[0]?.data, { from: { id: alpha, title: "Alpha" }, text: "hello new" });
		const folder = await broker(alpha, "create-folder", {
			action: "create",
			cwd: fixture.workspace,
			title: "Folder",
			message: "in a folder",
		});
		assert.ok(folder.action === "create" && folder.title === "Folder" && folder.to !== fresh);
		assert.equal(
			(await call(a, { action: "create", project: "ws", cwd: "/tmp", message: "both" } as Query)).isError,
			true,
		);
		assert.equal((await call(a, { action: "create", project: "nope", message: "unknown" })).isError, true);
		// Without a model the sender's; a named one must be signed in.
		const rows = await until(sessions.sessions, (list) => Boolean(list?.some((row) => row.id === folder.to)));
		assert.deepEqual(rows?.find((row) => row.id === folder.to)?.model, rows?.find((row) => row.id === alpha)?.model);
		const unknown = { action: "create", cwd: fixture.workspace, model: "faux/missing", message: "x" } as const;
		assert.match(text(await call(a, unknown)), /not a signed-in model/);
		const named = await broker(alpha, "create-named", { ...unknown, model: "faux/faux-1" });
		assert.equal(named.action, "create");

		await until(status.statuses, (value) => value?.[fresh]?.tasks === 0);
		await broker(alpha, "busy-fresh", { action: "send", to: fresh, message: "slow-tool" });
		await until(chat.view, (view) => JSON.stringify(view?.docs["pi.live"]).includes("tool-running"));
		assert.deepEqual(await broker(alpha, "stop-fresh", { action: "stop", to: fresh }), {
			action: "stop",
			to: fresh,
			stopped: true,
		});
		await until(chat.view, (view) => !(view?.docs["pi.live"] as { run?: unknown })?.run);
		assert.deepEqual(await broker(alpha, "stop-idle", { action: "stop", to: fresh }), {
			action: "stop",
			to: fresh,
			stopped: false,
		});
		chat.release();

		for (const action of ["stop", "archive"] as const)
			assert.match(text(await call(a, { action, to: alpha })), /yourself/);
		await broker(alpha, "archive-fresh", { action: "archive", to: fresh });
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === fresh)?.archivedAt !== null);
		const without = await broker(alpha, "list-archived", { action: "list" });
		assert.ok(without.action === "list" && !without.peers.some((peer) => peer.id === fresh));
		assert.equal((await call(a, { action: "send", to: fresh, message: "archived" })).isError, true);
		await broker(alpha, "restore-fresh", { action: "restore", to: fresh });
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === fresh)?.archivedAt === null);
		projects.release();
	});

	it("serves guest turns (no per-turn authority), denies child tools and public broker ingress", async () => {
		const sharing = owner.hold(Sharing, { session: alpha }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers,
			body: JSON.stringify({ token: links?.[0]?.token, name: "Owner" }),
		});
		const guest = fixture.client({ ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! }).host;
		const guestChat = await holdWith(guest, Chat, { session: alpha, conversation: 1 }, ...CHAT_PARTICIPANT);
		const listed = await call(guestChat, { action: "list" });
		assert.equal(listed.isError, false, text(listed));
		for (const client of [owner, guest]) {
			const publicBroker = client.hold(Conversations, {}, BACKGROUND_CONTEXT);
			await expectChord(whenLive(publicBroker), "forbidden");
			publicBroker.release();
			const ingress = client.hold(PeerConversation, { session: alpha }, BACKGROUND_CONTEXT);
			await expectChord(whenLive(ingress), "forbidden");
			ingress.release();
		}
		await guest.close(BACKGROUND_CONTEXT);
		sharing.release();
		await a.send({ text: "subagent", requestId: "child" }, BACKGROUND_CONTEXT);
		const childList = await holdWith(owner, Subagents, {}, "children");
		const children = await until(childList.children, (value) => Boolean(value?.[alpha]?.length));
		const child = await holdWith(
			owner,
			Chat,
			{ session: alpha, conversation: children![alpha]![0]!.conversationId },
			...CHAT_PARTICIPANT,
		);
		const result = await call(child, { action: "list" });
		assert.equal(result.isError, true);
		assert.match(text(result), /not available/);
		child.release();
		childList.release();
	});
});
