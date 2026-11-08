// The chat's turns (src/web/activity/model.ts): a turn's thinking and texts stay in order, each run of consecutive tool
// calls becomes one activity (a wheel), the last text is the answer, then the results; the last run is live while the
// agent works; unchanged turns keep their items.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	argumentOf,
	chatItems as chatItemsWith,
	describe as describeStep,
	groupCalls,
	live,
	stepState,
	summary,
	type ToolActivity,
	type ToolActivityTable,
	thoughtPreview,
} from "../../src/web/activity/model.ts";
import type { Item, NestedCall, ToolView } from "../../src/web/transcript.ts";

const edited = (count: number) => (count === 1 ? "edited a file" : `edited ${count} files`);
/** Contributions as plugins make them (the plugins' own are React modules, tested in the browser). */
const TOOLS: ToolActivityTable = new Map<string, ToolActivity>([
	[
		"bash",
		{
			describe: (step) => ({
				label: { kind: "command", verb: "Ran", object: String(step.tool.args.command), style: "code" },
			}),
			failure: (tool) => /exited with code (\d+)/.exec(tool.output)?.[1]?.replace(/^/, "exit "),
			summary: (count) => (count === 1 ? "ran a command" : `ran ${count} commands`),
		},
	],
	[
		"artifact",
		{
			summary: (count) => (count === 1 ? "made an artifact" : `made ${count} artifacts`),
			hasResult: (tool) => (tool.details === undefined ? false : tool.args.inline === true ? "inline" : "after"),
		},
	],
	["edit", { summary: edited }],
	["write", { summary: edited }],
]);
/** The turn's parts at detail 3 (thinking and texts in the transcript, runs of calls on wheels), which most tests check. */
const chatItems = (items: readonly Item[], working: boolean, known = true) =>
	chatItemsWith(items, working, known, TOOLS, 3);

const user = (key: string, text: string): Item => ({ type: "user", key, text, images: [], files: [], entryId: 1 });

function response(
	key: string,
	entryId: number,
	content: AssistantMessage["content"],
	tools: ToolView[] = [],
	extra: Partial<AssistantMessage> = {},
): Extract<Item, { type: "assistant" }> {
	return {
		type: "assistant",
		key,
		entryId,
		message: { ...fauxAssistantMessage([]), content, stopReason: "stop", ...extra },
		tools,
		streaming: false,
	};
}

const tool = (id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolView> = {}): ToolView => ({
	id,
	name,
	args,
	status: "done",
	output: "",
	images: [],
	...extra,
});

function turn(): Item[] {
	const bash = tool("t1", "bash", { command: "npm test" }, { output: "ok\n1 passed" });
	const artifact = tool(
		"t2",
		"artifact",
		{ name: "report" },
		{ details: { name: "report", title: "Report", type: "html", version: 1 } },
	);
	return [
		user("u1", "Run the tests"),
		response(
			"a1",
			2,
			[
				{ type: "thinking", thinking: "Run them first." },
				{ type: "text", text: "Running the tests." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
			],
			[bash],
		),
		response("a2", 3, [{ type: "toolCall", id: "t2", name: "artifact", arguments: { name: "report" } }], [artifact]),
		response("a3", 4, [{ type: "text", text: "All **tests** pass." }]),
	];
}

test("a turn keeps its thought and texts in order; its consecutive calls are one activity", () => {
	const made = turn();
	const items = chatItems(made, false);
	assert.deepEqual(
		items.map((item) => item.type),
		["user", "thought", "text", "activity", "answer", "results"],
	);
	const activity = items[3] as Extract<(typeof items)[number], { type: "activity" }>;
	assert.deepEqual(
		activity.steps.map((step) => step.tool.name),
		["bash", "artifact"],
	);
	assert.equal(activity.working, false);
	assert.deepEqual(activity.entryIds, [2, 3]);
	// Keyed by the response and part of its first call.
	assert.equal(activity.key, "activity:a1:2");
	// From the response with its first call until the response after its last began.
	const timestamp = (index: number) => (made[index] as Extract<Item, { type: "assistant" }>).message.timestamp;
	assert.equal(activity.startedAt, timestamp(1));
	assert.equal(activity.endedAt, timestamp(3));
	const text = items[2] as Extract<(typeof items)[number], { type: "text" }>;
	assert.equal(text.text, "Running the tests.");
	const answer = items[4] as Extract<(typeof items)[number], { type: "answer" }>;
	assert.equal(answer.text, "All **tests** pass.");
	assert.equal(answer.entryId, 4);
	const results = items[5] as Extract<(typeof items)[number], { type: "results" }>;
	assert.deepEqual(
		results.tools.map((each) => each.name),
		["artifact"],
	);
	assert.equal(summary(activity.steps, TOOLS), "Ran a command, made an artifact");
});

test("a result shown in place comes right after its call and splits the run of calls around it", () => {
	const inline = (id: string) =>
		tool(id, "artifact", { name: id, inline: true }, { details: { name: id, title: id, type: "html", version: 1 } });
	const bash = (id: string) => tool(id, "bash", { command: `echo ${id}` });
	const call = (each: ToolView): ToolCall => ({
		type: "toolCall",
		id: each.id,
		name: each.name,
		arguments: each.args as ToolCall["arguments"],
	});
	const card = tool(
		"c1",
		"artifact",
		{ name: "card" },
		{ details: { name: "card", title: "Card", type: "html", version: 1 } },
	);
	const made = [bash("b1"), inline("i1"), bash("b2"), card, bash("b3")];
	const turnOf = (tools: ToolView[], answer = true): Item[] => [
		user("u1", "Go"),
		response("a1", 2, tools.map(call), tools),
		...(answer ? [response("a2", 3, [{ type: "text" as const, text: "Done." }])] : []),
	];
	const items = chatItems(turnOf(made), false);
	assert.deepEqual(
		items.map((item) =>
			item.type === "activity"
				? `activity:${item.steps.map((step) => step.id).join(",")}`
				: item.type === "results"
					? `results:${item.tools.map((each) => each.id).join(",")}`
					: item.type,
		),
		// The inline artifact's wheel holds the calls up to it; the card waits for the answer.
		["user", "activity:b1,i1", "results:i1", "activity:b2,c1,b3", "answer", "results:c1"],
	);
	// The wheel after a result in place is keyed by it: the row that waited there while the agent worked.
	assert.equal(items[1]?.key, "activity:u1");
	assert.equal(items[2]?.key, "results:i1");
	assert.equal(items[3]?.key, "activity:results:i1");
	// Working after the result in place, nothing new yet: the waiting row, which the next call's wheel then is.
	const waiting = chatItems(turnOf(made.slice(0, 2), false), true);
	assert.deepEqual(
		waiting.map((item) => [item.type, item.key, item.type === "activity" && item.working]),
		[
			["user", "u1", false],
			["activity", "activity:u1", false],
			["results", "results:i1", false],
			["activity", "activity:results:i1", true],
		],
	);
	const next = chatItems(
		[...turnOf(made.slice(0, 2), false), response("a3", 3, [call(bash("b2"))], [bash("b2")])],
		true,
	);
	const wheel = next.at(-1);
	assert.equal(wheel?.key, "activity:results:i1");
	assert.equal(wheel?.type === "activity" && wheel.working, true);
	// At every level but 1 the result stays in place: at 2 (the default) between the wheels, at 4 between the rows. At 1
	// the turn keeps its one wheel, and the result joins those after the answer.
	const shape = (detail: 1 | 2 | 3 | 4) =>
		chatItemsWith(turnOf(made), false, true, TOOLS, detail).map((item) =>
			item.type === "activity"
				? `${item.rows ? "rows" : "activity"}:${item.steps.map((step) => step.id).join(",")}`
				: item.type === "results"
					? `results:${item.tools.map((each) => each.id).join(",")}`
					: item.type,
		);
	assert.deepEqual(shape(2), ["user", "activity:b1,i1", "results:i1", "activity:b2,c1,b3", "answer", "results:c1"]);
	assert.deepEqual(shape(4), ["user", "rows:b1,i1", "results:i1", "rows:b2,c1,b3", "answer", "results:c1"]);
	assert.deepEqual(shape(1), ["user", "activity:b1,i1,b2,c1,b3", "answer", "results:i1,c1"]);
	// At 2, the wheel after the result is the row that waited there, even when thinking comes first.
	const thinking = chatItemsWith(
		[
			...turnOf(made.slice(0, 2), false),
			response("a3", 3, [{ type: "thinking", thinking: "Next." }, call(bash("b2"))], [bash("b2")]),
		],
		true,
		true,
		TOOLS,
		2,
	);
	assert.equal(thinking.at(-1)?.key, "activity:results:i1");
	// While the call runs (no result yet), nothing splits.
	const running = { ...inline("i1"), status: "running" as const, details: undefined };
	assert.deepEqual(
		chatItems(turnOf([bash("b1"), running, bash("b2")], false), true).map((item) => item.type),
		["user", "activity"],
	);
});

test("thought, text, calls, text, calls: the texts in order and one activity per run of calls", () => {
	const items = chatItems(
		[
			user("u1", "Go"),
			response(
				"a1",
				2,
				[
					{ type: "thinking", thinking: "Plan." },
					{ type: "text", text: "First the tests." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "t2", name: "read", arguments: { path: "a.ts" } },
				],
				[tool("t1", "bash", { command: "npm test" }), tool("t2", "read", { path: "a.ts" })],
			),
			response(
				"a2",
				3,
				[
					{ type: "text", text: "Now the fix." },
					{ type: "toolCall", id: "t3", name: "edit", arguments: { path: "a.ts" } },
				],
				[tool("t3", "edit", { path: "a.ts" })],
			),
			response("a3", 4, [{ type: "text", text: "Fixed." }]),
		],
		true,
	);
	assert.deepEqual(
		items.map((item) => (item.type === "activity" ? `activity:${item.steps.length}:${item.working}` : item.type)),
		["user", "thought", "text", "activity:2:false", "text", "activity:1:false", "answer"],
	);
	// While the last run of calls is the newest part, it is live.
	const running = chatItems(
		[
			user("u1", "Go"),
			response("a1", 2, [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }], [], {
				stopReason: "toolUse",
			}),
		],
		true,
	);
	assert.deepEqual(
		running.map((item) => [item.type, item.key, item.type === "activity" && item.working]),
		[
			["user", "u1", false],
			// The first part: keyed by the message before it, the same row as the one that waited for it.
			["activity", "activity:u1", true],
		],
	);
});

test("while working, the last turn is live, and a waiting turn has an activity row", () => {
	const waiting = chatItems([user("u1", "Hi")], true);
	assert.deepEqual(
		waiting.map((item) => [item.type, item.key]),
		[
			["user", "u1"],
			["activity", "activity:u1"],
		],
	);
	const items = chatItems(turn().slice(0, 3), true);
	const activity = items.find((item) => item.type === "activity");
	assert.equal(activity?.type === "activity" && activity.working, true);
	assert.equal(activity?.key, "activity:a1:2");
	// Done, the same turn is not live.
	assert.equal(
		chatItems(turn().slice(0, 3), false).some((item) => item.type === "activity" && item.working),
		false,
	);
});

test("unchanged turns keep their items; in a changed one, only what shows differently is new", () => {
	const items = turn();
	const first = chatItems(items, false);
	const second = chatItems([...items], false);
	assert.equal(first[3], second[3]);
	// Begun when the answer it replaces began: the run of calls ends there.
	const begun = (items[3] as Extract<Item, { type: "assistant" }>).message.timestamp;
	const changed = [
		...items.slice(0, 3),
		response("a3", 4, [{ type: "text", text: "Done." }], [], { timestamp: begun }),
	];
	const rebuilt = chatItems(changed, false);
	// The run of calls shows the same: the same object, so its row does not render again; the answer is new.
	assert.equal(rebuilt[3], first[3]);
	assert.equal(rebuilt[2], first[2]);
	assert.notEqual(rebuilt[4], first[4]);
});

test("while an answer streams, the parts before its newest words keep their objects", () => {
	const streaming = (text: string): Item => ({
		...response("live", 9, [
			{ type: "thinking", thinking: "Considering." },
			{ type: "text", text },
		]),
		streaming: true,
	});
	const start = chatItems([user("u9", "Go"), streaming("One")], true);
	const later = chatItems([user("u9", "Go"), streaming("One two")], true);
	assert.equal(later[1], start[1], "the thought");
	assert.notEqual(later[2], start[2], "the words");
	// Words that turn out not to be the last (a call follows) keep their row's key: the answer was that text's row.
	const called = chatItems(
		[
			user("u9", "Go"),
			{
				...response("live", 9, [
					{ type: "thinking", thinking: "Considering." },
					{ type: "text", text: "One two" },
					{ type: "toolCall", id: "x1", name: "bash", arguments: { command: "ls" } },
				]),
				streaming: true,
			},
		],
		true,
	);
	assert.equal(start[2]?.type, "answer");
	assert.equal(called[2]?.type, "text");
	assert.equal(called[2]?.key, start[2]?.key);
});

test("thinking right after thinking is one thought; words or calls between them keep them apart", () => {
	const kinds = (items: ReturnType<typeof chatItems>) =>
		items.map((item) => (item.type === "thought" ? `thought:${item.text}` : item.type));
	// Two blocks in one response, and a block at the end of one response and the start of the next.
	assert.deepEqual(
		kinds(
			chatItems(
				[
					user("u1", "Hi"),
					response("r1", 2, [
						{ type: "thinking", thinking: "First." },
						{ type: "thinking", thinking: "Second." },
						{ type: "text", text: " " },
					]),
					response("r2", 3, [
						{ type: "thinking", thinking: "Third." },
						{ type: "text", text: "Answer." },
					]),
				],
				false,
			),
		),
		["user", "thought:First.\n\nSecond.\n\nThird.", "answer"],
	);
	// Words between: two thoughts. A run of calls between: two thoughts around its wheel.
	assert.deepEqual(
		kinds(
			chatItems(
				[
					user("u1", "Hi"),
					response("r1", 2, [
						{ type: "thinking", thinking: "First." },
						{ type: "text", text: "Looking." },
						{ type: "thinking", thinking: "Second." },
						{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "ls" } },
						{ type: "thinking", thinking: "Third." },
						{ type: "text", text: "Answer." },
					]),
				],
				false,
			),
		),
		["user", "thought:First.", "text", "thought:Second.", "activity", "thought:Third.", "answer"],
	);
	// The thought streams as one: live while its last block is.
	const live = chatItems(
		[
			user("u1", "Hi"),
			{
				...response("r1", 2, [
					{ type: "thinking", thinking: "First." },
					{ type: "thinking", thinking: "Sec" },
				]),
				streaming: true,
			},
		],
		true,
	);
	assert.deepEqual(
		live.map((item) => (item.type === "thought" ? [item.text, item.live] : item.type)),
		["user", ["First.\n\nSec", true]],
	);
});

test("a stopped turn without text shows its notice as the answer", () => {
	const items = chatItems(
		[
			user("u1", "Go"),
			response(
				"a1",
				2,
				[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 9" } }],
				[tool("t1", "bash", { command: "sleep 9" }, { status: "interrupted" })],
				{ stopReason: "aborted" },
			),
		],
		false,
	);
	assert.deepEqual(
		items.map((item) => item.type),
		["user", "activity", "answer"],
	);
	const activity = items[1];
	assert.equal(activity?.type === "activity" && activity.steps[0]?.status, "error");
});

test("a tool's contribution gives its words; a tool without one reads as its name and first short argument", () => {
	const step = (each: ToolView, status: "done" | "error" | "running" = "done") => ({
		id: each.id,
		tool: each,
		status,
	});
	assert.deepEqual(describeStep(step(tool("b", "bash", { command: "npm test" })), TOOLS).label, {
		kind: "command",
		verb: "Ran",
		object: "npm test",
		style: "code",
	});
	const fetch = tool("f", "web_fetch", { limit: 3, url: "https://example.com\nmore" });
	assert.deepEqual(describeStep(step(fetch), TOOLS).label, {
		kind: "tool",
		verb: "web_fetch",
		object: "https://example.com",
		style: "code",
	});
	// While it runs, without words of its own for that, the same.
	assert.deepEqual(live(step(fetch, "running"), TOOLS), describeStep(step(fetch), TOOLS).label);
	assert.equal(argumentOf(fetch, TOOLS, undefined), "https://example.com");
	// A failure says what went wrong; the tool may say how in its row.
	const failed = tool(
		"x",
		"bash",
		{ command: "node x" },
		{ status: "error", output: "Error: boom\nCommand exited with code 2" },
	);
	assert.equal(stepState(step(failed, "error"), TOOLS), "✗ exit 2");
	assert.equal(stepState(step({ ...fetch, status: "error", output: "Error: boom" }, "error"), TOOLS), "✗ failed");
	assert.equal(
		describeStep(step({ ...fetch, status: "error", output: "Error: boom" }, "error"), TOOLS).description,
		"Error: boom",
	);
	// Tools sharing their words count together; a tool without words of its own is "used" by name.
	const edits = [tool("e", "edit", {}), tool("w", "write", {}), fetch, fetch, tool("g", "grep", {})].map((each) =>
		step(each),
	);
	assert.equal(summary(edits, TOOLS), "Edited 2 files, used web_fetch 2 times, used grep");
	assert.equal(summary([], TOOLS), "Done");
});

test("a script's repeated identical calls are one entry; nested calls say so", () => {
	const call = (id: string, depth = 0, status: NestedCall["status"] = "done"): NestedCall => ({
		id,
		name: "bash",
		args: { command: "npm test" },
		status,
		depth,
	});
	const calls = [call("1"), call("2"), call("3", 0, "error"), call("4", 1)];
	// The calling tool's words for repeats (a script's: "3 runs").
	const script: ToolActivity = { repeated: (count, failed) => `${count} runs${failed ? `, ${failed} failed` : ""}` };
	const groups = groupCalls(calls, new Map([...TOOLS, ["script", script]]), "script");
	assert.equal(groups.length, 2);
	assert.equal(groups[0]?.calls.length, 3);
	assert.equal(groups[0]?.status, "error");
	assert.equal(groups[0]?.description, "3 runs, 1 failed");
	assert.equal(groups[1]?.label.extra, "nested");
	// A caller without them: the repeated tool's own summary.
	assert.equal(groupCalls(calls, TOOLS, "other")[0]?.description, "Ran 3 commands · 1 failed");
});

test("before the live state is known, an unfinished last turn shows as live, not finished", () => {
	const running = turn().slice(0, 2);
	(running[1] as Extract<Item, { type: "assistant" }>).message.stopReason = "toolUse";
	const live = (items: ReturnType<typeof chatItems>) => items.some((item) => item.type === "activity" && item.working);
	// Kept copy: not known, the entries say the run goes on.
	assert.equal(live(chatItems(running, false, false)), true);
	// The server says idle: an interrupted run is shown as done, not spinning.
	assert.equal(live(chatItems(running, false, true)), false);
	// A finished turn stays finished either way.
	assert.equal(live(chatItems(turn(), false, false)), false);
});

test("settings.json's detail: how much of a turn shows in the transcript, the rest on its wheels", () => {
	const at = (detail: 1 | 2 | 3 | 4, working = false) => chatItemsWith(turn(), working, true, TOOLS, detail);
	type Activity = Extract<ReturnType<typeof at>[number], { type: "activity" }>;
	const kinds = (activity: Activity | undefined) =>
		activity?.entries?.map((entry) => (entry.kind === "call" ? entry.step.tool.name : entry.kind));
	// 1: only the answer and results; the thought, the text and the calls on one wheel, keyed like the waiting one.
	const one = at(1);
	assert.deepEqual(
		one.map((item) => item.type),
		["user", "activity", "answer", "results"],
	);
	const wheel = one[1] as Activity;
	assert.equal(wheel.key, "activity:u1");
	assert.deepEqual(kinds(wheel), ["thought", "text", "bash", "artifact"]);
	assert.deepEqual(wheel.entryIds, [2, 3]);
	// 2: the text in the transcript; the thought on the wheel before it, the calls on the one after.
	const two = at(2);
	assert.deepEqual(
		two.map((item) => [item.type, item.key]),
		[
			["user", "u1"],
			["activity", "activity:u1"],
			["text", "text:a1:1"],
			["activity", "activity:a1:2"],
			["answer", "text:a3:0"],
			["results", "results:a1"],
		],
	);
	assert.deepEqual(kinds(two[1] as Activity), ["thought"]);
	assert.deepEqual(kinds(two[3] as Activity), ["bash", "artifact"]);
	// 2 is the default: as without the setting.
	const shape = (items: ReturnType<typeof at>) => items.map((item) => [item.type, item.key]);
	assert.deepEqual(shape(chatItemsWith(turn(), false, true, TOOLS)), shape(two));
	// 3: the thought collapsed in the transcript, only the calls on a wheel.
	assert.deepEqual(
		shape(at(3)).map(([type]) => type),
		["user", "thought", "text", "activity", "answer", "results"],
	);
	assert.equal((at(3)[3] as Activity).entries, undefined);
	// 4: the thought open, the calls as rows.
	const four = at(4);
	assert.equal((four[1] as Extract<(typeof four)[number], { type: "thought" }>).full, true);
	assert.equal((four[3] as Activity).rows, true);
	// While the agent works, the turn's one wheel is live (no answer yet).
	const working = chatItemsWith(turn().slice(0, 3), true, true, TOOLS, 1);
	assert.deepEqual(
		working.map((item) => [item.type, item.type === "activity" && item.working]),
		[
			["user", false],
			["activity", true],
			["results", false],
		],
	);
	// Its last text, even with nothing after it yet, stays on the wheel while the agent works (a call may follow), and
	// becomes the answer only once the agent stopped.
	const writing = chatItemsWith(turn(), true, true, TOOLS, 1);
	assert.deepEqual(
		writing.map((item) => item.type),
		["user", "activity", "results"],
	);
	assert.deepEqual(kinds(writing[1] as Activity), ["thought", "text", "bash", "artifact", "text"]);
	assert.equal((writing[1] as Activity).working, true);
	assert.deepEqual(
		at(1).map((item) => item.type),
		["user", "activity", "answer", "results"],
	);
	// At the other levels a text is in the transcript anyway: the answer shows as it streams.
	assert.deepEqual(
		chatItemsWith(turn(), true, true, TOOLS, 2).map((item) => item.type),
		["user", "activity", "text", "activity", "answer", "results"],
	);
});

test("at detail 1, a rebuilt run keeps its wheel when it shows the same", () => {
	const made = turn();
	const first = chatItemsWith(made, false, true, TOOLS, 1);
	// The answer's response again, as a new object (a delta that changed nothing shown): the run is made again.
	const again = [...made.slice(0, -1), { ...(made.at(-1) as Extract<Item, { type: "assistant" }>) }];
	const second = chatItemsWith(again, false, true, TOOLS, 1);
	assert.equal(second[1], first[1]);
});

test("an active wheel previews its latest thought, but not while that thought is the current step", () => {
	const content: AssistantMessage["content"] = [
		{ type: "thinking", thinking: "First plan." },
		{ type: "toolCall", id: "a", name: "bash", arguments: { command: "check" } },
		{ type: "thinking", thinking: "Wait for the deployment." },
		{ type: "toolCall", id: "b", name: "bash", arguments: { command: "watch" } },
	];
	const preview = (parts: AssistantMessage["content"], working: boolean) => {
		const items = chatItemsWith(
			[user("preview", "Go"), response("preview-response", 2, parts)],
			working,
			true,
			TOOLS,
		);
		const activity = items.findLast((item) => item.type === "activity");
		assert.ok(activity?.type === "activity");
		return thoughtPreview(activity.entries ?? [], activity.working, activity.thought);
	};
	assert.equal(preview(content, true), "Wait for the deployment.");
	assert.equal(preview(content.slice(0, -1), true), undefined);
	assert.equal(preview(content, false), undefined);
	assert.equal(preview([content[3]!], true), undefined);
	assert.equal(thoughtPreview([], true), undefined);
});

test("the latest thought survives a note splitting wheels, but never leaks into another turn", () => {
	const made = turn().slice(0, 3);
	const shown = chatItemsWith(made, true, true, TOOLS);
	const active = shown.findLast((item) => item.type === "activity");
	assert.ok(active?.type === "activity");
	assert.equal(thoughtPreview(active.entries ?? [], active.working, active.thought), "Run them first.");
	const next = chatItemsWith(
		[
			...made,
			user("next-preview", "Next"),
			response("next-response", 5, [{ type: "toolCall", id: "next", name: "bash", arguments: {} }]),
		],
		true,
		true,
		TOOLS,
	);
	const current = next.findLast((item) => item.type === "activity");
	assert.ok(current?.type === "activity");
	assert.equal(thoughtPreview(current.entries ?? [], current.working, current.thought), undefined);
});
