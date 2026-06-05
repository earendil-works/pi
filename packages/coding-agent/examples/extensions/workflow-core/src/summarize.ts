/**
 * Context firewall: summarize workflow results for the main LLM
 */

import type { InvokeAgentResult } from "./invoke-agent.ts";
import { getResultOutput, isFailedResult } from "./spawn-subprocess.ts";
import type { AgentResult, AgentStep } from "./types.ts";
import { DEFAULT_PER_TASK_OUTPUT_CAP } from "./types.ts";

export interface SummarizeOptions {
	perTaskOutputCap?: number;
	includeStepPath?: boolean;
}

function truncateOutput(output: string, cap: number): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;

	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

function summarizeResult(result: AgentResult, cap: number, includeStepPath: boolean): string {
	const output = truncateOutput(getResultOutput(result), cap);
	const status = isFailedResult(result)
		? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
		: "completed";
	const prefix = includeStepPath && result.stepPath ? `[${result.stepPath}] ` : "";
	return `### ${prefix}[${result.agent}] ${status}\n\n${output}`;
}

export function summarizeWorkflowResults(
	step: AgentStep,
	execution: InvokeAgentResult,
	options: SummarizeOptions = {},
): string {
	const cap = options.perTaskOutputCap ?? DEFAULT_PER_TASK_OUTPUT_CAP;
	const includeStepPath = options.includeStepPath ?? step.type !== "single";

	if (step.type === "single" && execution.results.length === 1) {
		const result = execution.results[0];
		if (isFailedResult(result)) {
			return `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`;
		}
		return truncateOutput(getResultOutput(result), cap);
	}

	if (step.type === "chain") {
		if (execution.failed) {
			return execution.error ?? "Chain failed";
		}
		const last = execution.results[execution.results.length - 1];
		return last ? truncateOutput(getResultOutput(last), cap) : "(no output)";
	}

	const successCount = execution.results.filter((r) => !isFailedResult(r)).length;
	const summaries = execution.results.map((r) => summarizeResult(r, cap, includeStepPath));
	return `Parallel: ${successCount}/${execution.results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
}

export function summarizeAgentResults(results: AgentResult[], options: SummarizeOptions = {}): string {
	const cap = options.perTaskOutputCap ?? DEFAULT_PER_TASK_OUTPUT_CAP;
	const includeStepPath = options.includeStepPath ?? true;
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => summarizeResult(r, cap, includeStepPath));
	return `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
}
