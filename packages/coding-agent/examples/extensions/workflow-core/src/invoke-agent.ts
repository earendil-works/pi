/**
 * Recursive workflow execution for single, parallel, and chain steps
 */

import type { AgentConfig } from "./discover-agents.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSingleAgent,
} from "./spawn-subprocess.ts";
import type { AgentProgress, AgentResult, AgentScope, AgentStep } from "./types.ts";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_PARALLEL_TASKS } from "./types.ts";

export interface InvokeAgentOptions {
	cwd: string;
	agents: AgentConfig[];
	agentScope?: AgentScope;
	signal?: AbortSignal;
	maxParallelTasks?: number;
	maxConcurrency?: number;
	onProgress?: (progress: AgentProgress) => void;
}

export interface InvokeAgentResult {
	results: AgentResult[];
	failed: boolean;
	error?: string;
	output: string;
}

function joinStepPath(parent: string | undefined, segment: string): string {
	return parent ? `${parent}.${segment}` : segment;
}

function emitProgress(
	options: InvokeAgentOptions,
	stepPath: string,
	mode: AgentProgress["mode"],
	results: AgentResult[],
	total: number,
): void {
	if (!options.onProgress) return;
	const running = results.filter((r) => r.exitCode === -1).length;
	const completed = results.filter((r) => r.exitCode !== -1).length;
	options.onProgress({
		stepPath,
		mode,
		results: [...results],
		running,
		completed,
		total,
	});
}

function placeholderResult(agent: string, task: string, stepPath: string): AgentResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stepPath,
	};
}

export async function invokeAgent(
	step: AgentStep,
	options: InvokeAgentOptions,
	stepPath = "root",
): Promise<InvokeAgentResult> {
	const maxParallelTasks = options.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

	if (step.type === "single") {
		emitProgress(options, stepPath, "single", [], 1);
		const result = await runSingleAgent(options.cwd, options.agents, step.agent, step.task, {
			cwd: step.cwd,
			stepPath,
			signal: options.signal,
			onUpdate: (partial) => {
				emitProgress(options, stepPath, "single", [partial], 1);
			},
		});

		const failed = isFailedResult(result);
		return {
			results: [result],
			failed,
			error: failed ? getResultOutput(result) : undefined,
			output: getFinalOutput(result.messages),
		};
	}

	if (step.type === "chain") {
		const results: AgentResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < step.steps.length; i++) {
			const child = step.steps[i];
			const childPath = joinStepPath(stepPath, `chain[${i}]`);

			if (child.type === "single") {
				const taskWithContext = child.task.replace(/\{previous\}/g, previousOutput);
				emitProgress(options, childPath, "chain", [...results], step.steps.length);

				const result = await runSingleAgent(options.cwd, options.agents, child.agent, taskWithContext, {
					cwd: child.cwd,
					step: i + 1,
					stepPath: childPath,
					signal: options.signal,
					onUpdate: (partial) => {
						emitProgress(options, childPath, "chain", [...results, partial], step.steps.length);
					},
				});
				results.push(result);

				if (isFailedResult(result)) {
					return {
						results,
						failed: true,
						error: `Chain stopped at step ${i + 1} (${child.agent}): ${getResultOutput(result)}`,
						output: previousOutput,
					};
				}
				previousOutput = getFinalOutput(result.messages);
				continue;
			}

			const nested = await invokeAgent(child, options, childPath);
			results.push(...nested.results);

			if (nested.failed) {
				return {
					results,
					failed: true,
					error: nested.error ?? `Chain stopped at step ${i + 1}`,
					output: previousOutput,
				};
			}
			previousOutput = nested.output;
		}

		return {
			results,
			failed: false,
			output: previousOutput,
		};
	}

	if (step.steps.length > maxParallelTasks) {
		return {
			results: [],
			failed: true,
			error: `Too many parallel tasks (${step.steps.length}). Max is ${maxParallelTasks}.`,
			output: "",
		};
	}

	const concurrency = Math.min(step.maxConcurrency ?? maxConcurrency, maxConcurrency);
	const placeholders: AgentResult[] = step.steps.map((child, index) => {
		if (child.type === "single") {
			return placeholderResult(child.agent, child.task, joinStepPath(stepPath, `parallel[${index}]`));
		}
		return placeholderResult("(nested)", "(nested step)", joinStepPath(stepPath, `parallel[${index}]`));
	});

	emitProgress(options, stepPath, "parallel", placeholders, step.steps.length);

	const allResults: AgentResult[] = new Array(step.steps.length);

	const nestedResults = await mapWithConcurrencyLimit(step.steps, concurrency, async (child, index) => {
		const childPath = joinStepPath(stepPath, `parallel[${index}]`);

		const nested = await invokeAgent(child, options, childPath);
		allResults[index] = nested.results[nested.results.length - 1] ?? {
			agent: child.type === "single" ? child.agent : "(nested)",
			agentSource: "unknown",
			task: child.type === "single" ? child.task : "(nested step)",
			exitCode: nested.failed ? 1 : 0,
			messages: [],
			stderr: nested.error ?? "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stepPath: childPath,
		};

		const flatResults = placeholders.map((p, i) => (i === index ? allResults[index] : p));
		emitProgress(options, stepPath, "parallel", flatResults, step.steps.length);

		return nested;
	});

	const flatResults = nestedResults.flatMap((r) => r.results);
	const failedResult = nestedResults.find((r) => r.failed);
	const successOutputs = nestedResults.filter((r) => !r.failed).map((r) => r.output);

	return {
		results: flatResults,
		failed: Boolean(failedResult),
		error: failedResult?.error,
		output: successOutputs.join("\n\n---\n\n"),
	};
}
