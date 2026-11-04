import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piExecutor } from "../../examples/extensions/async-mode/executor.ts";
import asyncMode from "../../examples/extensions/async-mode/index.ts";
import type { Decision } from "../../examples/extensions/async-mode/routing.ts";
import { createHarness, createTestUiContext, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

vi.mock("../../examples/extensions/async-mode/executor.ts", () => ({ piExecutor: vi.fn() }));

type Responses = Parameters<Harness["setResponses"]>[0];
const route = (decision: Decision) => fauxAssistantMessage(JSON.stringify(decision));
const independent = (context = ""): Decision => ({
	route: "independent",
	execution: "lightweight",
	context,
	reason: "One-shot question",
});
interface RecordData {
	id: string;
	topicId?: string;
	status: string;
	answer: string;
	question: string;
	childSessionFile?: string;
}
function records(harness: Harness): RecordData[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "async-dialogue")
		.map((entry) => (entry as { data: RecordData }).data);
}
function mainId(harness: Harness): string {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === "async-main-task");
	return (entry as { data: { id: string } }).data.id;
}

describe("smart async dialogue", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.clearAllMocks();
	});

	async function blocked(responses: Responses, mode: "async" | "default" = "async") {
		let selectedMode = mode;
		let release!: () => void;
		let entered = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notices: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				asyncMode,
				(pi) => {
					pi.registerTool({
						name: "gate",
						label: "gate",
						description: "Hold foreground work",
						parameters: Type.Object({}),
						execute: async () => {
							entered = true;
							await gate;
							return { content: [{ type: "text", text: "main tool finished" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notices.push(message),
				select: async () => (selectedMode === "async" ? "Async" : "Default"),
			}),
		});
		await harness.session.prompt("/mode");
		harness.setResponses([fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }), ...responses]);
		const running = harness.session.prompt("Run the main task");
		await vi.waitFor(() => expect(entered).toBe(true));
		return {
			harness,
			notices,
			release,
			running,
			setMode: async (next: "async" | "default") => {
				selectedMode = next;
				await harness.session.prompt("/mode");
			},
		};
	}

	it("routes questions and corrections semantically without user commands, while keeping the main task running", async () => {
		const execute = vi.fn(async () => ({ success: true, result: "Independent inspection complete" }));
		vi.mocked(piExecutor).mockReturnValue(execute);
		const setup = await blocked([
			route(independent("Only validation facts")),
			fauxAssistantMessage(
				[fauxToolCall("execute_independent_request", { task: "Inspect validation instructions" })],
				{ stopReason: "toolUse" },
			),
			() => route({ route: "steer", taskId: mainId(setup.harness), reason: "New execution constraint" }),
			fauxAssistantMessage("Main task followed the correction"),
		]);
		const { harness, notices, release, running } = setup;
		try {
			await harness.session.prompt("如何检测？", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Independent inspection complete"));
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(getUserTexts(harness)).not.toContain("如何检测？");
			await harness.session.prompt("只做本地测试", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(harness.session.getSteeringMessages()).toEqual(["只做本地测试"]));
		} finally {
			release();
		}
		await running;
		expect(getAssistantTexts(harness)).toContain("Main task followed the correction");
		expect(records(harness).findLast((item) => item.question === "如何检测？")).toMatchObject({
			status: "completed",
			answer: "Independent inspection complete",
		});
	});

	it("isolates topics and promotes only stateful work to a reusable persistent session", async () => {
		const execute = vi.fn(async () => ({ success: true, result: "Persistent result" }));
		vi.mocked(piExecutor).mockReturnValue(execute);
		let topicA = "";
		const setup = await blocked([
			route(independent("Selected main fact A")),
			fauxAssistantMessage("Answer A"),
			route(independent("Selected main fact B")),
			fauxAssistantMessage("Unrelated answer B"),
			() =>
				route({
					route: "independent",
					execution: "session",
					topicId: topicA,
					context: "Relevant A",
					reason: "Iterative modification and tests",
				}),
			() =>
				route({
					route: "independent",
					execution: "lightweight",
					topicId: topicA,
					context: "Continue A",
					reason: "Follow-up to the same topic",
				}),
			fauxAssistantMessage("Main done"),
		]);
		const { harness, release, running } = setup;
		try {
			await harness.session.prompt("Question A", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("completed"));
			topicA = records(harness).at(-1)!.topicId!;
			await harness.session.prompt("Question B", { streamingBehavior: "steer" });
			await vi.waitFor(() =>
				expect(records(harness).at(-1)).toMatchObject({ question: "Question B", status: "completed" }),
			);
			expect(piExecutor).not.toHaveBeenCalled();
			await harness.session.prompt("Modify and repeatedly validate A", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("completed"));
			const firstFile = vi.mocked(piExecutor).mock.calls[0][5];
			expect(firstFile).toContain("async-subtasks");
			expect(execute.mock.calls[0]).toBeDefined();
			const contexts = execute.mock.calls as unknown as Array<[{ context: string }]>;
			expect(contexts[0][0].context).toContain("Answer A");
			expect(contexts[0][0].context).not.toContain("Unrelated answer B");
			await harness.session.prompt("Continue A from its saved state", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
			expect(vi.mocked(piExecutor).mock.calls[1][5]).toBe(firstFile);
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("completed"));
		} finally {
			release();
		}
		await running;
		const notices: string[] = [];
		const resumed = await createHarness({ sessionManager: harness.sessionManager, extensionFactories: [asyncMode] });
		harnesses.push(resumed);
		await resumed.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
		});
		const tool = resumed.session.agent.state.tools.find((item) => item.name === "async_dialogue_read")!;
		const full = await tool.execute("read", { topicId: topicA }, new AbortController().signal);
		expect(JSON.stringify(full)).toContain("Persistent result");
	});

	it("does not release dependencies on agent_end, and starts them after an explicit task-completed milestone", async () => {
		const setup = await blocked([
			() =>
				route({
					route: "after_task",
					taskId: mainId(setup.harness),
					execution: "lightweight",
					context: "Use the final result",
					reason: "Needs completed main output",
				}),
			fauxAssistantMessage("I need your decision before finishing"),
			fauxAssistantMessage("Dependent question answered from completed output"),
		]);
		const { harness, notices, release, running } = setup;
		try {
			await harness.session.prompt("完成后解释最终结果", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("waiting"));
		} finally {
			release();
		}
		await running;
		expect(records(harness).at(-1)?.status).toBe("waiting");
		expect(notices.join("\n")).not.toContain("Dependent question answered");
		await setup.setMode("default");
		const tool = harness.session.agent.state.tools.find((item) => item.name === "async_main_state")!;
		await tool.execute(
			"complete",
			{ status: "completed", summary: "The full main task is now complete" },
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(notices.join("\n")).toContain("Dependent question answered from completed output"));
		expect(records(harness).at(-1)?.status).toBe("completed");
	});

	it("cancels a waiting request using ordinary language without executing it", async () => {
		let waitingId = "";
		const setup = await blocked([
			() =>
				route({
					route: "after_task",
					taskId: mainId(setup.harness),
					execution: "lightweight",
					context: "",
					reason: "Depends on main output",
				}),
			() => route({ route: "cancel", taskId: waitingId, reason: "User cancelled the queued question" }),
			fauxAssistantMessage("main done"),
		]);
		const { harness, release, running } = setup;
		try {
			await harness.session.prompt("结束后再解释", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("waiting"));
			waitingId = records(harness).at(-1)!.id;
			await harness.session.prompt("取消刚才那个后续问题", { streamingBehavior: "steer" });
			await vi.waitFor(() =>
				expect(records(harness).findLast((item) => item.id === waitingId)?.status).toBe("cancelled"),
			);
			expect(piExecutor).not.toHaveBeenCalled();
		} finally {
			release();
		}
		await running;
	});

	it("keeps invalid routing output from changing the main task or launching work", async () => {
		const { harness, notices, release, running } = await blocked([
			fauxAssistantMessage("not JSON"),
			fauxAssistantMessage("main done"),
		]);
		try {
			await harness.session.prompt("Ambiguous request", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("failed"));
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(piExecutor).not.toHaveBeenCalled();
			expect(notices.join("\n")).toContain("request has not been executed");
		} finally {
			release();
		}
		await running;
	});

	it.each([
		{ route: "independent", execution: "session", topicId: "unknown-topic", context: "", reason: "Invalid topic" },
		{
			route: "after_task",
			execution: "lightweight",
			taskId: "unknown-task",
			context: "",
			reason: "Invalid dependency",
		},
	])("rejects model references outside the current session: $route", async (invalid) => {
		const { harness, release, running } = await blocked([
			fauxAssistantMessage(JSON.stringify(invalid)),
			fauxAssistantMessage("main done"),
		]);
		try {
			await harness.session.prompt("Request with a bad reference", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("failed"));
			expect(piExecutor).not.toHaveBeenCalled();
			expect(harness.session.getSteeringMessages()).toEqual([]);
		} finally {
			release();
		}
		await running;
	});

	it.each(["failed", "cancelled"] as const)("does not execute work whose dependency is %s", async (status) => {
		const setup = await blocked([
			() =>
				route({
					route: "after_task",
					taskId: mainId(setup.harness),
					execution: "session",
					context: "",
					reason: "Needs final main output",
				}),
			fauxAssistantMessage("Main did not complete"),
		]);
		const { harness, notices, release, running } = setup;
		try {
			await harness.session.prompt("Continue after main finishes", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("waiting"));
		} finally {
			release();
		}
		await running;
		const tool = harness.session.agent.state.tools.find((item) => item.name === "async_main_state")!;
		await tool.execute("terminal", { status, summary: "Main task stopped" }, new AbortController().signal);
		await vi.waitFor(() => expect(records(harness).at(-1)?.status).toBe("failed"));
		expect(piExecutor).not.toHaveBeenCalled();
		expect(notices.join("\n")).toContain("dependent request was not executed");
	});

	it("preserves Pi's ordinary steering when default mode is selected", async () => {
		const { harness, release, running } = await blocked([fauxAssistantMessage("done")], "default");
		try {
			await harness.session.prompt("A normal correction", { streamingBehavior: "steer" });
			expect(harness.session.getSteeringMessages()).toEqual(["A normal correction"]);
		} finally {
			release();
		}
		await running;
	});
});
