import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export type AgentScope = "user" | "project" | "both";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface AgentResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	stepPath?: string;
}

export interface AgentProgress {
	stepPath: string;
	mode: "single" | "parallel" | "chain";
	results: AgentResult[];
	running: number;
	completed: number;
	total: number;
}

export const SingleStepSchema = Type.Object({
	type: Type.Literal("single"),
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const AgentStepSchema = Type.Cyclic(
	{
		AgentStep: Type.Union([
			SingleStepSchema,
			Type.Object({
				type: Type.Literal("parallel"),
				steps: Type.Array(Type.Ref("AgentStep"), {
					minItems: 1,
					description: "Steps to run concurrently",
				}),
				maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent subprocesses (default: 4)" })),
			}),
			Type.Object({
				type: Type.Literal("chain"),
				steps: Type.Array(Type.Ref("AgentStep"), {
					minItems: 1,
					description: "Steps to run sequentially",
				}),
			}),
		]),
	},
	"AgentStep",
);

export type SingleStep = {
	type: "single";
	agent: string;
	task: string;
	cwd?: string;
};

export type ParallelStep = {
	type: "parallel";
	steps: AgentStep[];
	maxConcurrency?: number;
};

export type ChainStep = {
	type: "chain";
	steps: AgentStep[];
};

export type AgentStep = SingleStep | ParallelStep | ChainStep;

export const DEFAULT_MAX_PARALLEL_TASKS = 8;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_PER_TASK_OUTPUT_CAP = 50 * 1024;
