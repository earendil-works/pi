/**
 * Subagent tool — delegate a task to a specialized sub-agent running in an
 * isolated pi process (ported from
 * packages/coding-agent/examples/extensions/subagent/, single mode only).
 *
 * Agent types are markdown files with frontmatter (name, description, tools,
 * model) in ~/.pi/agent/agents/ (or .pi/agents/ in the project). Two built-in
 * types always exist: "worker" (full toolset) and "explore" (read-only).
 * Sub-agents cannot spawn their own sub-agents unless their definition
 * explicitly lists the "subagent" tool.
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { getMarkdownTheme, type Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { getBuiltinAgents } from "./builtin.ts";
import {
	COLLAPSED_ITEM_COUNT,
	type DisplayItem,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type SubagentResult,
	truncateOutput,
} from "./format.ts";
import { runSingleAgent } from "./run.ts";

const SubagentParams = Type.Object({
	description: Type.String({ description: "Short (3-5 word) summary of the task being delegated" }),
	prompt: Type.String({ description: "Full instructions for the sub-agent" }),
	agent: Type.Optional(
		Type.String({ description: 'Agent type name. Omit to use "worker" (full toolset). Built-in: worker, explore.' }),
	),
	model: Type.Optional(
		Type.String({ description: "Model override (provider/model). Defaults to the session model." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent process" })),
});

const RUNNING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_SPINNER_INTERVAL_MS = 120;

interface RunningSpinner {
	timer: ReturnType<typeof setInterval>;
	frame: number;
}

/**
 * Stop the running-state ticker, if any. Called on every re-render once the
 * sub-agent is no longer executing (final result or pre-start).
 */
function stopRunningSpinner(state: Record<string, unknown> | undefined): void {
	if (!state) return;
	const spinner = state.runningSpinner as RunningSpinner | undefined;
	if (!spinner) return;
	clearInterval(spinner.timer);
	delete state.runningSpinner;
}

/**
 * Current spinner frame for a running sub-agent. The ticker lives in the
 * tool component's renderer state (persisted across re-renders by the shell)
 * and drives re-renders via the context's invalidate callback. The timer is
 * unref'd so a leaked ticker (e.g. block discarded mid-run) never holds the
 * process open; without renderer state (non-TUI contexts) a static frame is
 * rendered instead of starting a ticker that cannot be persisted.
 */
function nextRunningSpinnerFrame(state: Record<string, unknown> | undefined, invalidate: () => void): string {
	if (!state) return RUNNING_SPINNER_FRAMES[0];
	let spinner = state.runningSpinner as RunningSpinner | undefined;
	if (!spinner) {
		const tick: RunningSpinner = { timer: undefined as unknown as ReturnType<typeof setInterval>, frame: 0 };
		tick.timer = setInterval(() => {
			tick.frame = (tick.frame + 1) % RUNNING_SPINNER_FRAMES.length;
			invalidate();
		}, RUNNING_SPINNER_INTERVAL_MS);
		tick.timer.unref();
		state.runningSpinner = tick;
		spinner = tick;
	}
	return RUNNING_SPINNER_FRAMES[spinner.frame];
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme): string {
	const toShow = expanded ? items : items.slice(-COLLAPSED_ITEM_COUNT);
	const skipped = !expanded && items.length > COLLAPSED_ITEM_COUNT ? items.length - COLLAPSED_ITEM_COUNT : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function resultToUsage(result: SubagentResult): Usage {
	return {
		input: result.usage.input,
		output: result.usage.output,
		cacheRead: result.usage.cacheRead,
		cacheWrite: result.usage.cacheWrite,
		totalTokens: result.usage.contextTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.usage.cost },
	};
}

export function registerSubagent(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a specialized sub-agent running in an isolated pi process with its own context window.",
			`Agent types are markdown files with frontmatter (name, description, tools, model) in ${path.join(getAgentDir(), "agents")}`,
			`or .pi/agents in the project. Built-in types: "worker" (full toolset), "explore" (read-only).`,
			'Sub-agents cannot spawn further sub-agents unless their definition lists the "subagent" tool.',
			"To run several tasks concurrently, issue multiple subagent calls in one turn.",
		].join(" "),
		parameters: SubagentParams,
		executionMode: "parallel",
		// Render without the default tool shell: its blue/green background is
		// replaced by explicit status words ("running" / "done" / "failed").
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd);
			const agentsByName = new Map<string, AgentConfig>();
			for (const agent of getBuiltinAgents()) agentsByName.set(agent.name, agent);
			for (const agent of discovery.agents) agentsByName.set(agent.name, agent);

			const agentName = params.agent ?? "worker";
			const agent = agentsByName.get(agentName);
			if (!agent) {
				const available = Array.from(agentsByName.keys())
					.map((n) => `"${n}"`)
					.join(", ");
				throw new Error(`Unknown agent: "${agentName}". Available agents: ${available}.`);
			}

			if (agent.source === "project" && ctx.hasUI && !ctx.isProjectTrusted()) {
				const ok = await ctx.ui.confirm(
					"Run project-local agent?",
					`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) throw new Error("Canceled: project-local agent not approved.");
			}

			const dispatchDefaults = {
				model: params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				thinkingLevel: ctx.thinkingLevel,
			};

			const result = await runSingleAgent(
				ctx.cwd,
				dispatchDefaults,
				agent,
				params.prompt,
				params.cwd,
				signal,
				onUpdate,
			);
			if (isFailedResult(result)) {
				throw new Error(`Subagent ${result.stopReason || "failed"}: ${getResultOutput(result)}`);
			}
			const output = getFinalOutput(result.messages) || "(no output)";
			const toolResult: AgentToolResult<SubagentResult> = {
				content: [{ type: "text", text: truncateOutput(output) }],
				details: result,
				usage: resultToUsage(result),
			};
			return toolResult;
		},

		renderCall(args, theme, context) {
			const agentName = args.agent || "worker";
			const preview = args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}...` : args.prompt;
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", ` ${args.description || ""}`);
			text += `\n  ${theme.fg("dim", preview)}`;
			if (context.executionStarted && context.isPartial) {
				const frame = nextRunningSpinnerFrame(context.state, context.invalidate);
				text += `\n${theme.fg("warning", `${frame} running`)}`;
			} else {
				stopRunningSpinner(context.state);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SubagentResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const r = details;
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			if (isPartial) {
				// The "running" status word comes from renderCall; while the
				// sub-agent works we only stream its activity below it.
				if (displayItems.length === 0) return new Text("", 0, 0);
				let text = renderDisplayItems(displayItems, expanded, theme);
				if (!expanded && displayItems.length > COLLAPSED_ITEM_COUNT) {
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				return new Text(text, 0, 0);
			}

			const isError = isFailedResult(r);
			const status = isError ? theme.fg("error", "✗ failed") : theme.fg("success", "✓ done");
			let header =
				`${status}${theme.fg("dim", " · ")}` +
				`${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(header, 0, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				} else {
					for (const item of displayItems) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			let text = header;
			if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else {
				text += `\n${renderDisplayItems(displayItems, false, theme)}`;
				if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		},
	});
}
