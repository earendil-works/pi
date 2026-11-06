// The chat's turns (src/web/activity/model.ts): a turn's thinking and texts stay in order, each run of consecutive tool
// calls becomes one activity (a wheel), the last text is the answer, then the results; the last run is live while the
// agent works; unchanged turns keep their items.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { chatItems, describe as describeStep, groupCalls, summary } from "../../src/web/activity/model.ts";
import type { Item, NestedCall, ToolView } from "../../src/web/transcript.ts";

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
	assert.equal(summary(activity.steps), "Ran a command, made an artifact");
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

test("unchanged turns keep their items; a changed one is rebuilt", () => {
	const items = turn();
	const first = chatItems(items, false);
	const second = chatItems([...items], false);
	assert.equal(first[3], second[3]);
	const changed = [...items.slice(0, 3), response("a3", 4, [{ type: "text", text: "Done." }])];
	assert.notEqual(chatItems(changed, false)[3], first[3]);
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

test("steps read as the work: verbs, files, commands and failures", () => {
	const step = (each: ToolView) => describeStep({ id: each.id, tool: each, status: "done" });
	assert.deepEqual(step(tool("r", "read", { path: "/w/src/a.ts", offset: 40, limit: 20 })).label, {
		kind: "read",
		verb: "Read",
		object: "a.ts",
		style: "file",
	});
	assert.equal(step(tool("r", "read", { path: "/w/src/a.ts", offset: 40, limit: 20 })).description, "Lines 40–59");
	assert.equal(step(tool("s", "bash", { command: "rg -n foo" })).label.verb, "Searched");
	const failed = describeStep({
		id: "f",
		status: "error",
		tool: tool("f", "bash", { command: "node x" }, { status: "error", output: "Error: boom\n  at x" }),
	});
	assert.equal(failed.description, "Error: boom");
});

test("a script's repeated identical calls are one entry; nested calls say so", () => {
	const call = (id: string, depth = 0, status: NestedCall["status"] = "done"): NestedCall => ({
		id,
		name: "bash",
		args: { command: "npm test" },
		status,
		depth,
	});
	const groups = groupCalls([call("1"), call("2"), call("3", 0, "error"), call("4", 1)]);
	assert.equal(groups.length, 2);
	assert.equal(groups[0]?.calls.length, 3);
	assert.equal(groups[0]?.status, "error");
	assert.equal(groups[0]?.description, "3 runs, 1 failed");
	assert.equal(groups[1]?.label.extra, "nested");
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

test("a terminal call reads as its tmux command line, and the summary counts it", () => {
	const terminal = tool("x", "terminal", { command: "send-keys", args: ["-t", "1", "C-c"] }, { output: "$ \n" });
	const step = { id: "x", tool: terminal, status: "done" as const };
	assert.deepEqual(describeStep(step).label, {
		kind: "command",
		verb: "Terminal",
		object: "send-keys -t 1 C-c",
		style: "code",
	});
	assert.equal(summary([step, step]), "Used the terminal 2 times");
});
