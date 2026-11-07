// Planner: turns goal + intent into task graph, checks, budgets, thinking, strict prompts.
// Prompts are versioned rows in the DB (auditable).
import type { Store } from "@earendil-works/pi-orchestra-core";
import { emptyBudget } from "@earendil-works/pi-orchestra-core";
import { assignThinking } from "./thinking.ts";

export interface PlanTask {
	title: string;
	spec: string;
	ownsGlobs: string[];
	checks: { kind: "cmd" | "screenshot_diff" | "dom_assert"; config: Record<string, unknown> }[];
	thinking: string;
	reasoning: string;
}

export interface PlanInput {
	goal: string;
	intent: string;
	tasks: PlanTask[];
	agentCount: number;
	thinkingMode: "fixed" | "dynamic";
	fixedLevel?: string;
	agentsCountWarn?: boolean;
}

export interface PlanOutput {
	taskIds: string[];
	agentIds: string[];
	promptIds: string[];
}

export function composeAgentPrompt(input: {
	goal: string;
	agentName: string;
	taskTitle: string;
	taskSpec: string;
	ownsGlobs: string[];
	checks: { kind: string; config: Record<string, unknown> }[];
	teammates: { name: string; owns: string[] }[];
	thinkingLevel: string;
}): string {
	const lines: string[] = [];
	lines.push(`Run goal (verbatim): ${input.goal}`);
	lines.push(
		"Done means checks pass, not claims. A claim of completion counts for nothing until the supervisor runs your acceptance checks in your worktree.",
	);
	lines.push("");
	lines.push(`Your task: ${input.taskTitle}`);
	lines.push(`Spec: ${input.taskSpec}`);
	lines.push(`Thinking level: ${input.thinkingLevel}`);
	lines.push("Owned paths (you may only edit these; the guard enforces this):");
	for (const g of input.ownsGlobs) lines.push(`- ${g}`);
	if (input.ownsGlobs.length === 0) lines.push("(none specified — supervisor will assign)");
	lines.push("Acceptance checks (literal, run by supervisor in your worktree):");
	if (input.checks.length === 0) lines.push("- (none yet)");
	for (const c of input.checks) lines.push(`- [${c.kind}] ${JSON.stringify(c.config)}`);
	lines.push("");
	lines.push("Teammates:");
	if (input.teammates.length === 0) lines.push("- (none)");
	for (const t of input.teammates)
		lines.push(`- ${t.name}: owns ${t.owns.join(", ") || "—"} (message via send_message)`);
	lines.push(
		"Required workflow: brief plan, implement, run the tests, typecheck, self-review the diff; for UI work also screenshot, dom_metrics and baseline diff after the last edit.",
	);
	lines.push("Required evidence in your `done` message: commands run and their results.");
	lines.push("Forbidden: reverting others' work, touching unowned files, claiming completion without evidence.");
	return lines.join("\n");
}

export function planRun(store: Store, input: PlanInput): PlanOutput {
	if (input.agentCount > 12) throw new Error("max agents 12");
	if (input.agentsCountWarn && input.agentCount >= 8) {
		// RAM warning is surfaced by caller; planner just records decision.
	}
	const runId = `run-${Date.now()}`;
	store.createRun({ runId, goal: input.goal });
	const taskIds: string[] = [];
	const agentIds: string[] = [];
	const promptIds: string[] = [];
	const teammates = input.tasks.map((t) => ({ name: t.title.slice(0, 24), owns: t.ownsGlobs }));
	// Exact count inside envelope: planner picks min(tasks, agents requested). Never idle agents.
	const pickCount = Math.min(input.agentCount, Math.max(1, input.tasks.length));
	store.logDecision({
		trigger: "plan",
		inputRef: runId,
		decision: `agents=${pickCount}`,
		rationale: `requested ${input.agentCount}, tasks ${input.tasks.length}`,
		by: "reconciler",
	});
	for (let i = 0; i < pickCount; i++) {
		const spec = input.tasks[i % input.tasks.length]!;
		const thinking =
			input.thinkingMode === "fixed"
				? (input.fixedLevel ?? "medium")
				: assignThinking({ spec: spec.spec, ownsGlobs: spec.ownsGlobs, checks: spec.checks }).level;
		const task = store.createTask({ title: spec.title, spec: spec.spec, ownsGlobs: spec.ownsGlobs });
		for (const chk of spec.checks) store.addCheck({ taskId: task.id, kind: chk.kind as never, config: chk.config });
		const agent = store.createAgent({
			name: `agent-${i + 1}`,
			role: "builder",
			taskId: task.id,
			thinkingLevel: thinking,
		});
		store.setTaskOwner(task.id, agent.id);
		store.setBudget("agent", agent.id, emptyBudget());
		const promptText = composeAgentPrompt({
			goal: input.goal,
			agentName: agent.name,
			taskTitle: spec.title,
			taskSpec: spec.spec,
			ownsGlobs: spec.ownsGlobs,
			checks: spec.checks,
			teammates,
			thinkingLevel: thinking,
		});
		const prompt = store.addPrompt({ agentId: agent.id, text: promptText, reason: `plan run ${runId}` });
		taskIds.push(task.id);
		agentIds.push(agent.id);
		promptIds.push(prompt.id);
		store.logDecision({
			trigger: "thinking",
			inputRef: agent.id,
			decision: thinking,
			rationale:
				input.thinkingMode === "fixed"
					? "fixed"
					: assignThinking({ spec: spec.spec, ownsGlobs: spec.ownsGlobs, checks: spec.checks }).reason,
			by: "proxy",
		});
	}
	return { taskIds, agentIds, promptIds };
}
