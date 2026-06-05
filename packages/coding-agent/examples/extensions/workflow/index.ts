/**
 * Workflow extension - multi-agent orchestration with context firewall
 *
 * Runs an AgentStep tree (single | parallel | chain) in isolated child pi processes.
 * The main LLM only receives a condensed summary; full results live in tool details.
 *
 * Child spawns use workflow-core's runSingleAgent (no extensions; exclude run_workflow).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type AgentScope,
	type AgentStep,
	AgentStepSchema,
	DEFAULT_MAX_PARALLEL_TASKS,
	discoverAgents,
} from "../workflow-core/src/index.ts";
import { aggregateUsage, WorkflowExecutor, type WorkflowRunOutcome } from "./executor.ts";
import { loadWorkflowSettings } from "./settings.ts";

const MAX_PARALLEL_LEAVES = DEFAULT_MAX_PARALLEL_TASKS;

interface WorkflowToolDetails {
	runId: string;
	task: string;
	step: AgentStep;
	phases?: string[];
	summary: string;
	execution: WorkflowRunOutcome["execution"];
	usage: ReturnType<typeof aggregateUsage>;
}

function countLeaves(step: AgentStep): number {
	if (step.type === "single") return 1;
	return step.steps.reduce((sum, child) => sum + countLeaves(child), 0);
}

function isSubstantivePrompt(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 80) return false;
	if (/\b(ultrawork|workflow|orchestrat|fan[\s-]?out)\b/i.test(trimmed)) return true;
	if (/\b(audit|migrate|refactor|review all|every file|across the (repo|codebase))\b/i.test(trimmed)) return true;
	return trimmed.length >= 240;
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both".',
	default: "both",
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_workflow",
		label: "Workflow",
		description: [
			"Run a multi-agent workflow defined as an AgentStep tree (single, parallel, or chain).",
			"Child agents run in isolated pi subprocesses without extensions. Returns a summary only; full outputs are in tool details.",
			"Use {previous} in chain single-step tasks to inject the prior step output. Child agents cannot call run_workflow.",
		].join(" "),
		parameters: Type.Object({
			task: Type.String({ description: "High-level goal for this workflow run" }),
			step: AgentStepSchema,
			phases: Type.Optional(Type.Array(Type.String(), { description: "Optional phase labels for confirmation UI" })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const settings = loadWorkflowSettings(ctx.cwd);
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const leafCount = countLeaves(params.step);
			if (leafCount > MAX_PARALLEL_LEAVES) {
				return {
					content: [
						{ type: "text", text: `Workflow has ${leafCount} agent steps. Max is ${MAX_PARALLEL_LEAVES}.` },
					],
					details: {},
					isError: true,
				};
			}

			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgents = discovery.agents.filter((agent) => agent.source === "project");
				if (projectAgents.length > 0) {
					const names = projectAgents.map((agent) => agent.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run workflow with project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: {},
						};
					}
				}
			}

			if (params.phases?.length && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Run workflow?",
					params.phases.map((phase: string, index: number) => `${index + 1}. ${phase}`).join("\n"),
				);
				if (!ok) {
					return { content: [{ type: "text", text: "Workflow canceled." }], details: {} };
				}
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const executor = new WorkflowExecutor({
				sessionId,
				cwd: ctx.cwd,
				agents: discovery.agents,
				settings,
				signal,
				onPhase: (phase) => {
					onUpdate?.({
						content: [{ type: "text", text: `Phase: ${phase}` }],
						details: {},
					});
				},
			});

			const outcome = await executor.run({
				task: params.task,
				step: params.step,
				phases: params.phases,
			});

			pi.appendEntry("workflow_run", {
				runId: outcome.runId,
				task: params.task,
				status: outcome.record.status,
			});

			const details: WorkflowToolDetails = {
				runId: outcome.runId,
				task: params.task,
				step: params.step,
				phases: params.phases,
				summary: outcome.summary,
				execution: outcome.execution,
				usage: aggregateUsage(outcome.execution.results),
			};

			return {
				content: [{ type: "text", text: outcome.summary }],
				details,
				isError: outcome.record.status === "error",
			};
		},

		renderCall(args, theme) {
			const leafCount = args.step ? countLeaves(args.step as AgentStep) : 0;
			const phases = (args.phases as string[] | undefined)?.length ?? 0;
			let text = theme.fg("toolTitle", theme.bold("run_workflow "));
			text += theme.fg("accent", args.task as string);
			if (leafCount > 0) text += theme.fg("dim", ` (${leafCount} agent step${leafCount === 1 ? "" : "s"})`);
			if (phases > 0) text += theme.fg("dim", `, ${phases} phases`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as WorkflowToolDetails | undefined;
			const summary =
				details?.summary || (result.content[0]?.type === "text" ? result.content[0].text : "(no output)");
			if (!expanded || !details) {
				const preview = summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
				return new Text(theme.fg("toolOutput", preview), 0, 0);
			}
			const usage = details.usage;
			const usageLine = `agents:${usage.agents} turns:${usage.turns} cost:$${usage.cost.toFixed(4)}`;
			return new Text(`${summary}\n\n${theme.fg("dim", usageLine)}`, 0, 0);
		},
	});

	pi.registerCommand("workflow", {
		description: "Plan and run a multi-agent workflow: /workflow <task>",
		handler: async (args, ctx) => {
			const task = args.trim() || "complete the current request";
			await ctx.waitForIdle();
			pi.sendUserMessage(
				[
					`Plan a multi-agent workflow for: ${task}`,
					"Use the run_workflow tool with an AgentStep JSON tree (type: single | parallel | chain).",
					"Prefer parallel scouts for independent recon, then a chain step with {previous} for synthesis.",
					"Set phases for user confirmation when the plan has distinct stages.",
					"See examples/extensions/workflow/examples/auth-audit.json for a sample workflow.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs for the current session: /workflows",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const executor = new WorkflowExecutor({
				sessionId,
				cwd: ctx.cwd,
				agents: [],
				settings: loadWorkflowSettings(ctx.cwd),
			});
			const runs = executor.listRuns();
			if (runs.length === 0) {
				ctx.ui.notify("No workflow runs for this session.", "info");
				return;
			}
			const lines = runs
				.slice(0, 10)
				.map((run) => `${run.id} [${run.status}] ${run.task}`)
				.join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		const settings = loadWorkflowSettings(ctx.cwd);
		if (!settings.autoMode) return;
		if (!isSubstantivePrompt(event.text)) return;
		return {
			action: "transform",
			text: [
				event.text,
				"",
				"[auto-workflow] This looks like a multi-step task. Prefer run_workflow with parallel scouts and a synthesis chain step.",
				"Return only the workflow summary to the user unless they ask for raw agent output.",
			].join("\n"),
		};
	});
}
