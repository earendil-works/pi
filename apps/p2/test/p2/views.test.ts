// Views (plugins/views) with the fake provider: the agent's view tools (code mode, namespace `view`) open, list, close
// and arrange views and resolve annotations; people select and annotate, and their next message carries that once;
// stored views of the removed custom kind are not listed.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { VIEW_INPUT, Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** The script result that follows the newest input saying `said` (the view is a window of the newest entries). */
const scriptAfter = (view: ConversationView | null | undefined, said: string): ToolResultMessage | undefined => {
	const entries = view?.entries ?? [];
	const asked = entries.findLastIndex((entry) => (entry.data as { text?: string } | undefined)?.text === said);
	if (asked < 0) return undefined;
	return entries
		.slice(asked + 1)
		.flatMap((entry) => entry.model ?? [])
		.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		);
};
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
/** What a completed script returned, as its result's text gives it. */
const output = (message: ToolResultMessage | undefined): string =>
	text(message).replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n\n?/, "");

describe("views (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let views: RefIn<typeof Views, "editor">;
	let sent = 0;

	/** Has the agent run `code` in code mode; its result (`isError` when the script threw). */
	const script = async (code: string): Promise<ToolResultMessage> => {
		// Each message its own text: the same script twice must not find the first one's result.
		const said = `codemode ${code}\n// ${++sent}`;
		await chat.send({ text: said, requestId: `script-${sent}` }, BACKGROUND_CONTEXT);
		let result: ToolResultMessage | undefined;
		await until(chat.view, (value) => {
			result = scriptAfter(value, said);
			return result !== undefined && idle(value);
		});
		return result!;
	};
	/** Runs `code`, which must complete; what it returned, parsed. */
	const run = async (code: string): Promise<unknown> => {
		const result = await script(code);
		assert.equal(result.isError, false, text(result));
		return JSON.parse(output(result));
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

	it("opens, lists and closes views by kind and item", async () => {
		assert.deepEqual(
			await run('return await tools.view_open({ kind: "markdown", title: "Notes", item: "notes.md" });'),
			{ id: "notes" },
		);
		assert.deepEqual(await run('return await tools.view_open({ kind: "changes", id: "diff" });'), { id: "diff" });
		const listed = await until(views.views, (value) => value.length === 2);
		assert.deepEqual(
			listed.map((view) => [view.id, view.kind, view.item ?? null]),
			[
				["notes", "markdown", "notes.md"],
				["diff", "changes", null],
			],
		);
		const list = (await run("return await tools.view_list({});")) as { views: unknown[] };
		assert.deepEqual(list.views, [
			{ id: "notes", kind: "markdown", item: "notes.md", title: "Notes" },
			{ id: "diff", kind: "changes", title: "Changes" },
		]);
		// Opening an existing ID shows it again in front; another kind under it is refused.
		const focus = views.views.value.find((view) => view.id === "notes")?.focus ?? 0;
		await run('return await tools.view_open({ kind: "markdown", id: "notes" });');
		await until(views.views, (value) => (value.find((view) => view.id === "notes")?.focus ?? 0) > focus);
		assert.match(
			text(await script('await tools.view_open({ kind: "changes", id: "notes" });')),
			/is a markdown view, not changes/,
		);
		assert.match(text(await script('await tools.view_open({ kind: "markdown", title: "x" });')), /needs item/);
		assert.deepEqual(await run('return await tools.view_close({ id: "diff" });'), { closed: "diff" });
		await until(views.views, (value) => value.length === 1);
	});

	it("carries selections and annotations with the next message, once", async () => {
		await views.select(
			{ id: "notes", selection: { summary: "The letter a", data: { line: 3 } } },
			BACKGROUND_CONTEXT,
		);
		await views.annotate(
			{ kind: "comment", view: "transcript", quote: "Echo", note: "too loud" },
			BACKGROUND_CONTEXT,
		);
		await views.annotate({ kind: "delete", view: "notes", quote: "letter" }, BACKGROUND_CONTEXT);
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
		assert.match(sentText, /Selected in view "notes" \(markdown notes.md, "Notes"\): The letter a/);
		assert.match(sentText, /Comment in the transcript on «Echo»: too loud/);
		assert.match(sentText, /Remove from view "notes".*«letter»/);
		await until(views.annotations, (value) => value.length === 2 && value.every((annotation) => annotation.sent));
		assert.equal(views.views.value.find((each) => each.id === "notes")?.selection?.sent, true);
		// Nothing new: the next message is a plain input.
		await chat.send({ text: "and again", requestId: "context-2" }, BACKGROUND_CONTEXT);
		const next = await until(chat.view, (value) =>
			(value?.entries ?? []).some(
				(each) => each.kind === "p2.input" && (each.data as { text?: string }).text === "and again",
			),
		);
		assert.ok(next);
		// The agent reads annotations and resolves them.
		const list = (await run("return await tools.view_list({});")) as {
			selections: { view: string }[];
			annotations: { text: string }[];
		};
		assert.deepEqual(
			list.selections.map((each) => each.view),
			["notes"],
		);
		assert.ok(list.annotations.some((annotation) => annotation.text.includes("too loud")));
		assert.deepEqual(await run('return await tools.view_resolve({ view: "transcript" });'), { resolved: 1 });
		await until(views.annotations, (value) => value.length === 1);
		// What the person drops never goes.
		await views.annotate({ kind: "comment", view: "notes", quote: "letter", note: "drop me" }, BACKGROUND_CONTEXT);
		await views.discard(BACKGROUND_CONTEXT);
		await until(views.annotations, (value) => value.every((annotation) => annotation.sent));
	});

	it("carries a selection in an item shown in the transcript, once, and lists it", async () => {
		await views.selectInline(
			{ kind: "html", item: "counter", title: "Counter", selection: { summary: "count 42", data: { count: 42 } } },
			BACKGROUND_CONTEXT,
		);
		await until(views.inline, (value) => value.length === 1 && !value[0]?.selection.sent);
		await chat.send({ text: "what did I pick", requestId: "inline-1" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) =>
			(value?.entries ?? []).some(
				(entry) => entry.kind === VIEW_INPUT && (entry.data as { text?: string }).text === "what did I pick",
			),
		);
		const entry = view?.entries.findLast((each) => each.kind === VIEW_INPUT);
		const model = (entry?.model?.[0] as UserMessage | undefined)?.content;
		const sentText = Array.isArray(model)
			? model.map((part) => (part.type === "text" ? part.text : "")).join("")
			: "";
		assert.match(sentText, /Selected in html "counter" \("Counter"\) shown in the transcript: count 42/);
		await until(views.inline, (value) => value[0]?.selection.sent === true);
		await until(chat.view, idle);
		const list = (await run("return await tools.view_list({});")) as {
			selections: { view: string; kind?: string; item?: string; summary: string }[];
		};
		assert.deepEqual(
			list.selections.filter((each) => each.item === "counter"),
			[{ view: "transcript", kind: "html", item: "counter", summary: "count 42", data: { count: 42 }, sent: true }],
		);
	});

	it("arranges the person's panes and refuses layouts that name no view", async () => {
		await run(
			'return await tools.view_arrange({ layout: { column: ["notes", { tabs: ["transcript"] }], sizes: [2, 1] } });',
		);
		const arranged = await until(views.arrangement, (value) => value !== null);
		assert.deepEqual(arranged?.layout, { column: ["notes", { tabs: ["transcript"] }], sizes: [2, 1] });
		assert.match(
			text(await script('await tools.view_arrange({ layout: { row: ["transcript", "nope"] } });')),
			/no view "nope"/,
		);
		const list = (await run("return await tools.view_list({});")) as { arrangement?: { layout: unknown } };
		assert.deepEqual(list.arrangement?.layout, { column: ["notes", { tabs: ["transcript"] }], sizes: [2, 1] });
	});

	it("offers the view tools to code mode only, in the namespace view", async () => {
		const described = await run('return await describeNamespace("view");');
		assert.match(JSON.stringify(described), /view_open/);
		await chat.send(
			{ text: `view_open ${JSON.stringify({ kind: "changes" })}`, requestId: "direct" },
			BACKGROUND_CONTEXT,
		);
		const view = await until(chat.view, (value) =>
			(value?.entries ?? []).some((entry) =>
				(entry.model ?? []).some((message) => message.role === "toolResult" && message.toolName === "view_open"),
			),
		);
		const direct = (view?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.find(
				(message): message is ToolResultMessage =>
					message.role === "toolResult" && message.toolName === "view_open",
			);
		assert.equal(direct?.isError, true, "the model is not offered it");
		await until(chat.view, idle);
	});
});
