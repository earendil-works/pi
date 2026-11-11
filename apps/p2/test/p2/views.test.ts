// Views (plugins/views) with the fake provider: the agent's `view` tool opens, reads, changes and closes views; people
// select and annotate, and their next message carries that once; a custom view's page is served with its bridge to
// the session's viewers only; the owner's library keeps views for other sessions.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Held } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SavedViews, VIEW_INPUT, ViewState, Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const PAGE = "<!doctype html><html><head><title>Glyph</title></head><body><p id=p>glyph</p></body></html>";

const toolResults = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "view",
		),
	);
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

describe("views (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let views: RefIn<typeof Views, "editor">;
	let sent = 0;

	/** Has the agent call `view` with `args`; its result's text. */
	const tool = async (args: Record<string, unknown>, on = chat): Promise<string> => {
		const before = toolResults(on.view.value).length;
		await on.send({ text: `view ${JSON.stringify(args)}`, requestId: `view-${++sent}` }, BACKGROUND_CONTEXT);
		const view = await until(on.view, (value) => toolResults(value).length === before + 1 && idle(value));
		return text(toolResults(view).at(-1));
	};

	before(async () => {
		fixture = await startFixture();
		writeFileSync(join(fixture.workspace, "notes.md"), "# Notes\n\nThe letter a.\n");
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		views = await holdIn(owner, Views, { session }, "editor");
	});
	after(async () => {
		await fixture?.close();
	});

	it("opens views, reads and changes their state, and closes them", async () => {
		assert.match(
			await tool({ action: "open", kind: "markdown", title: "Notes", path: "notes.md" }),
			/Opened view "notes"/,
		);
		assert.match(
			await tool({ action: "open", kind: "custom", title: "Glyph", id: "glyph", html: PAGE, state: { points: 3 } }),
			/Opened view "glyph"/,
		);
		const listed = await until(views.views, (value) => value.length === 2);
		assert.deepEqual(
			listed.map((view) => [view.id, view.kind, view.source ?? null]),
			[
				["notes", "markdown", null],
				["glyph", "custom", 1],
			],
		);
		const state: Held<typeof ViewState> = owner.hold(ViewState, { session, view: "glyph" }, BACKGROUND_CONTEXT);
		await until(state.value, (value) => JSON.stringify(value) === '{"points":3}');
		await tool({ action: "update", id: "glyph", merge: { selected: 1 } });
		await until(state.value, (value) => JSON.stringify(value) === '{"points":3,"selected":1}');
		assert.match(
			await tool({ action: "update", id: "glyph", html: PAGE.replace("glyph", "glyph v2") }),
			/html \(version 2\)/,
		);
		await until(views.views, (value) => value.find((view) => view.id === "glyph")?.source === 2);
		assert.match(await tool({ action: "read", id: "glyph" }), /State: \{"points":3,"selected":1\}/);
		// Opening an existing ID updates it and brings it to the front; another kind under it is refused.
		const focus = views.views.value.find((view) => view.id === "notes")?.focus ?? 0;
		await tool({ action: "open", kind: "markdown", title: "Notes", id: "notes" });
		await until(views.views, (value) => (value.find((view) => view.id === "notes")?.focus ?? 0) > focus);
		assert.match(await tool({ action: "open", kind: "changes", title: "x", id: "notes" }), /is a markdown view/);
		assert.match(await tool({ action: "close", id: "notes" }), /Closed view "notes"/);
		await until(views.views, (value) => value.length === 1);
		state.release();
	});

	it("carries selections and annotations with the next message, once", async () => {
		await views.select(
			{ id: "glyph", selection: { summary: "point 2 of glyph a", data: { point: 2 } } },
			BACKGROUND_CONTEXT,
		);
		await views.annotate(
			{ kind: "comment", view: "transcript", quote: "Echo", note: "too loud" },
			BACKGROUND_CONTEXT,
		);
		await views.annotate({ kind: "delete", view: "glyph", quote: "glyph v2" }, BACKGROUND_CONTEXT);
		await chat.send({ text: "make it bolder", requestId: "context-1" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) =>
			(value?.entries ?? []).some((entry) => entry.kind === VIEW_INPUT && idle(value)),
		);
		const entry = view?.entries.find((each) => each.kind === VIEW_INPUT);
		assert.equal((entry?.data as { text: string }).text, "make it bolder");
		const model = (entry?.model?.[0] as UserMessage | undefined)?.content;
		const sentText = Array.isArray(model)
			? model.map((part) => (part.type === "text" ? part.text : "")).join("")
			: "";
		assert.match(sentText, /make it bolder\n\n<views>/);
		assert.match(sentText, /Selected in view "glyph" \(custom, "Glyph"\): point 2 of glyph a/);
		assert.match(sentText, /Comment in the transcript on «Echo»: too loud/);
		assert.match(sentText, /Remove from view "glyph".*«glyph v2»/);
		await until(views.annotations, (value) => value.length === 2 && value.every((annotation) => annotation.sent));
		assert.equal(views.views.value.find((each) => each.id === "glyph")?.selection?.sent, true);
		// Nothing new: the next message is a plain input.
		await chat.send({ text: "and again", requestId: "context-2" }, BACKGROUND_CONTEXT);
		const next = await until(chat.view, (value) =>
			(value?.entries ?? []).some(
				(each) => each.kind === "p2.input" && (each.data as { text?: string }).text === "and again",
			),
		);
		assert.ok(next);
		// The agent reads annotations and resolves them.
		assert.match(await tool({ action: "read", id: "transcript" }), /too loud/);
		assert.match(await tool({ action: "resolve", id: "transcript" }), /Resolved 1 annotation/);
		await until(views.annotations, (value) => value.length === 1);
		// What the person drops never goes.
		await views.annotate({ kind: "comment", view: "glyph", quote: "glyph", note: "drop me" }, BACKGROUND_CONTEXT);
		await views.discard(BACKGROUND_CONTEXT);
		await until(views.annotations, (value) => value.every((annotation) => annotation.sent));
	});

	it("arranges the person's panes and refuses layouts that name no view", async () => {
		assert.match(
			await tool({ action: "arrange", layout: { column: ["glyph", { tabs: ["transcript"] }], sizes: [2, 1] } }),
			/Arranged/,
		);
		const arranged = await until(views.arrangement, (value) => value !== null);
		assert.deepEqual(arranged?.layout, { column: ["glyph", { tabs: ["transcript"] }], sizes: [2, 1] });
		assert.match(await tool({ action: "arrange", layout: { row: ["transcript", "nope"] } }), /no view "nope"/);
		assert.match(await tool({ action: "list" }), /Layout you arranged last/);
	});

	it("takes state, merge and layout given as JSON text, and refuses a state that is no object", async () => {
		// Its own session: a harness that sends objects as strings.
		const own = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		const ownChat = await holdIn(owner, Chat, { session: own, conversation: 1 }, "participant");
		const ownViews = await holdIn(owner, Views, { session: own }, "editor");
		await tool(
			{
				action: "open",
				kind: "custom",
				title: "Note",
				id: "note",
				html: PAGE,
				state: JSON.stringify({ text: "hi" }),
			},
			ownChat,
		);
		const state = await holdIn(owner, ViewState, { session: own, view: "note" }, "editor");
		await until(state.value, (value) => JSON.stringify(value) === '{"text":"hi"}');
		await tool({ action: "update", id: "note", merge: JSON.stringify({ more: 1 }) }, ownChat);
		await until(state.value, (value) => JSON.stringify(value) === '{"text":"hi","more":1}');
		assert.match(
			await tool({ action: "arrange", layout: JSON.stringify({ row: ["transcript", "note"] }) }, ownChat),
			/Arranged/,
		);
		assert.deepEqual((await until(ownViews.arrangement, (value) => value !== null))?.layout, {
			row: ["transcript", "note"],
		});
		// A plain string is a view ID for a layout, and no state.
		assert.match(await tool({ action: "arrange", layout: "note" }, ownChat), /Arranged/);
		assert.doesNotMatch(await tool({ action: "update", id: "note", state: "plain text" }, ownChat), /Updated/);
		assert.doesNotMatch(await tool({ action: "update", id: "note", state: [1, 2] }, ownChat), /Updated/);
		assert.equal(JSON.stringify(state.value.value), '{"text":"hi","more":1}');
		state.release();
	});

	it("saves people's state changes within bounds", async () => {
		const state = await holdIn(owner, ViewState, { session, view: "glyph" }, "editor");
		await state.set({ value: { points: 4 } }, BACKGROUND_CONTEXT);
		await until(state.value, (value) => JSON.stringify(value) === '{"points":4}');
		await assert.rejects(state.set({ value: "x".repeat(300 * 1024) }, BACKGROUND_CONTEXT), /at most/);
		state.release();
	});

	it("serves a custom view's page with its bridge, sandboxed, to the session's viewers only", async () => {
		const url = (version: number, id = session) =>
			`/view-frame?${new URLSearchParams({ session: id, view: "glyph", version: String(version) })}`;
		const page = await fixture.http(url(2));
		assert.equal(page.status, 200);
		assert.match(page.body, /window\.p2view/);
		assert.match(page.body, /glyph v2/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /sandbox allow-scripts allow-modals allow-pointer-lock/);
		assert.ok(!csp.includes("allow-same-origin"));
		assert.equal((await fixture.http(url(3))).status, 404);
		assert.equal((await fixture.http(url(1), { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
		const other = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		assert.equal((await fixture.http(url(1, other))).status, 404);
	});

	it("saves views to the owner's library and opens them in another session", async () => {
		assert.match(
			await tool({ action: "save", id: "glyph", name: "glyph-editor", description: "Edits glyphs" }),
			/Saved/,
		);
		const library = await holdIn(owner, SavedViews, {}, "owner");
		await until(library.saved, (value) => value.some((each) => each.name === "glyph-editor"));
		const other = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		const otherChat = await holdIn(owner, Chat, { session: other, conversation: 1 }, "participant");
		assert.match(await tool({ action: "load", name: "glyph-editor" }, otherChat), /Opened view "glyph-editor"/);
		const state = await holdIn(owner, ViewState, { session: other, view: "glyph-editor" }, "editor");
		await until(state.value, (value) => JSON.stringify(value) === '{"points":4}');
		// From the Views sheet too, under a free ID.
		const otherViews = await holdIn(owner, Views, { session: other }, "editor");
		assert.deepEqual(await otherViews.open({ saved: "glyph-editor" }, BACKGROUND_CONTEXT), { id: "glyph-editor-2" });
		await library.remove({ name: "glyph-editor" }, BACKGROUND_CONTEXT);
		await until(library.saved, (value) => !value.some((each) => each.name === "glyph-editor"));
		assert.match(await tool({ action: "saved" }, otherChat), /No saved views/);
		state.release();
		otherChat.release();
	});
});
