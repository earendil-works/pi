import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentResult,
	type AgentStep,
	type InvokeAgentResult,
	invokeAgent,
	summarizeWorkflowResults,
} from "../workflow-core/src/index.ts";
import type { WorkflowSettings } from "./settings.ts";

export type WorkflowStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface WorkflowRunRecord {
	id: string;
	sessionId: string;
	task: string;
	createdAt: string;
	step: AgentStep;
	phases?: string[];
	status: WorkflowStatus;
	execution?: InvokeAgentResult;
	summary?: string;
	error?: string;
}

export interface WorkflowExecutorOptions {
	sessionId: string;
	cwd: string;
	agents: AgentConfig[];
	settings: WorkflowSettings;
	signal?: AbortSignal;
	onPhase?: (phase: string) => void;
	onProgress?: (record: WorkflowRunRecord) => void;
}

export interface WorkflowRunOutcome {
	runId: string;
	summary: string;
	execution: InvokeAgentResult;
	record: WorkflowRunRecord;
}

function workflowsDir(sessionId: string): string {
	return path.join(getAgentDir(), "workflows", sessionId);
}

export function createRunId(): string {
	return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class WorkflowStore {
	private sessionId: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	private runPath(runId: string): string {
		return path.join(workflowsDir(this.sessionId), `${runId}.json`);
	}

	ensureDir(): void {
		fs.mkdirSync(workflowsDir(this.sessionId), { recursive: true });
	}

	save(record: WorkflowRunRecord): void {
		this.ensureDir();
		fs.writeFileSync(this.runPath(record.id), JSON.stringify(record, null, 2), "utf-8");
	}

	load(runId: string): WorkflowRunRecord | undefined {
		const filePath = this.runPath(runId);
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkflowRunRecord;
	}

	list(): WorkflowRunRecord[] {
		const dir = workflowsDir(this.sessionId);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as WorkflowRunRecord)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}

export function aggregateUsage(results: AgentResult[]) {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
		agents: results.length,
	};
	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.cost += result.usage.cost;
		usage.contextTokens = Math.max(usage.contextTokens, result.usage.contextTokens);
		usage.turns += result.usage.turns;
	}
	return usage;
}

export class WorkflowExecutor {
	private options: WorkflowExecutorOptions;
	private store: WorkflowStore;

	constructor(options: WorkflowExecutorOptions) {
		this.options = options;
		this.store = new WorkflowStore(options.sessionId);
	}

	async run(input: { task: string; step: AgentStep; phases?: string[] }): Promise<WorkflowRunOutcome> {
		const runId = createRunId();
		const record: WorkflowRunRecord = {
			id: runId,
			sessionId: this.options.sessionId,
			task: input.task,
			createdAt: new Date().toISOString(),
			step: input.step,
			phases: input.phases,
			status: "running",
		};
		this.store.save(record);
		this.options.onProgress?.(record);

		try {
			const execution = await invokeAgent(input.step, {
				cwd: this.options.cwd,
				agents: this.options.agents,
				signal: this.options.signal,
				maxConcurrency: this.options.settings.maxConcurrency,
				onProgress: (progress) => {
					if (progress.mode === "single" && progress.results[0]?.agent) {
						this.options.onPhase?.(progress.results[0].agent);
					}
				},
			});

			const summary = summarizeWorkflowResults(input.step, execution);
			const done: WorkflowRunRecord = {
				...record,
				status: execution.failed ? "error" : "done",
				execution,
				summary,
				error: execution.error,
			};
			this.store.save(done);
			this.options.onProgress?.(done);
			return { runId, summary, execution, record: done };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failed: WorkflowRunRecord = {
				...record,
				status: this.options.signal?.aborted ? "aborted" : "error",
				error: message,
				summary: `Workflow failed: ${message}`,
			};
			this.store.save(failed);
			this.options.onProgress?.(failed);
			throw error;
		}
	}

	listRuns(): WorkflowRunRecord[] {
		return this.store.list();
	}
}
