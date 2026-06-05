import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, AgentStep } from "../../../examples/extensions/workflow-core/src/types.ts";
import { DEFAULT_PER_TASK_OUTPUT_CAP } from "../../../examples/extensions/workflow-core/src/types.ts";

const { runSingleAgentMock } = vi.hoisted(() => ({
	runSingleAgentMock: vi.fn(),
}));

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: AgentResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: AgentResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

vi.mock("../../../examples/extensions/workflow-core/src/spawn-subprocess.ts", () => ({
	runSingleAgent: runSingleAgentMock,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	emptyUsage,
	mapWithConcurrencyLimit,
}));

import { invokeAgent } from "../../../examples/extensions/workflow-core/src/invoke-agent.ts";
import { summarizeWorkflowResults } from "../../../examples/extensions/workflow-core/src/summarize.ts";

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function okResult(agent: string, task: string, output: string, step?: number): AgentResult {
	return {
		agent,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [assistantMessage(output)],
		stderr: "",
		usage: emptyUsage(),
		step,
	};
}

const mockAgents = [
	{
		name: "scout",
		description: "scout",
		systemPrompt: "",
		source: "user" as const,
		filePath: "/tmp/scout.md",
	},
	{
		name: "planner",
		description: "planner",
		systemPrompt: "",
		source: "user" as const,
		filePath: "/tmp/planner.md",
	},
];

describe("workflow-core", () => {
	beforeEach(() => {
		runSingleAgentMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("chain substitutes {previous} into the next step task", async () => {
		const tasks: string[] = [];
		runSingleAgentMock.mockImplementation(async (_cwd, _agents, agent: string, task: string) => {
			tasks.push(task);
			if (agent === "scout") return okResult(agent, task, "found 3 files", 1);
			return okResult(agent, task, "final plan", 2);
		});

		const step: AgentStep = {
			type: "chain",
			steps: [
				{ type: "single", agent: "scout", task: "scan codebase" },
				{ type: "single", agent: "planner", task: "plan using: {previous}" },
			],
		};

		const execution = await invokeAgent(step, { cwd: "/tmp", agents: mockAgents });

		expect(tasks).toEqual(["scan codebase", "plan using: found 3 files"]);
		expect(execution.failed).toBe(false);
		expect(execution.output).toBe("final plan");
	});

	it("parallel respects concurrency limit", async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		runSingleAgentMock.mockImplementation(async (_cwd, _agents, agent: string, task: string) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight--;
			return okResult(agent, task, `${agent}-done`);
		});

		const step: AgentStep = {
			type: "parallel",
			steps: [
				{ type: "single", agent: "scout", task: "a" },
				{ type: "single", agent: "scout", task: "b" },
				{ type: "single", agent: "scout", task: "c" },
				{ type: "single", agent: "scout", task: "d" },
				{ type: "single", agent: "scout", task: "e" },
			],
			maxConcurrency: 2,
		};

		const execution = await invokeAgent(step, { cwd: "/tmp", agents: mockAgents, maxConcurrency: 2 });

		expect(execution.failed).toBe(false);
		expect(execution.results).toHaveLength(5);
		expect(maxInFlight).toBeLessThanOrEqual(2);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it("summarizeWorkflowResults truncates parallel outputs", () => {
		const huge = "x".repeat(DEFAULT_PER_TASK_OUTPUT_CAP + 10_000);
		const step: AgentStep = {
			type: "parallel",
			steps: [
				{ type: "single", agent: "scout", task: "a" },
				{ type: "single", agent: "scout", task: "b" },
			],
		};
		const execution = {
			results: [okResult("scout", "a", huge), okResult("scout", "b", "small")],
			failed: false,
			output: `${huge}\n\n---\n\nsmall`,
		};

		const summary = summarizeWorkflowResults(step, execution);
		expect(Buffer.byteLength(summary, "utf8")).toBeLessThan(Buffer.byteLength(huge, "utf8"));
		expect(summary).toContain("[Output truncated:");
		expect(summary).toContain("small");
		expect(summary).toContain("Parallel: 2/2 succeeded");
	});

	it("summarizeWorkflowResults returns final chain output only", () => {
		const step: AgentStep = {
			type: "chain",
			steps: [
				{ type: "single", agent: "scout", task: "scan" },
				{ type: "single", agent: "planner", task: "plan" },
			],
		};
		const execution = {
			results: [okResult("scout", "scan", "verbose scout"), okResult("planner", "plan", "final plan")],
			failed: false,
			output: "final plan",
		};

		expect(summarizeWorkflowResults(step, execution)).toBe("final plan");
	});
});
