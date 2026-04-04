/**
 * Plan Mode Extension — Prometheus 3-Phase Planning Flow
 *
 * Implements the full Prometheus planning pipeline:
 *   Phase 1: Interview (intent classification, research, clearance checks)
 *   Phase 2: Plan Generation (Metis consultation, wave-based plan, gap analysis)
 *   Phase 3: High Accuracy (Momus review loop)
 *   Execution: Wave-parallel step dispatch with 3-layer verification
 *
 * The main agent becomes Prometheus via systemPrompt injection from before_agent_start.
 * Metis and Momus remain subagents invoked by the agent during their respective phases.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	buildDraftPath,
	buildPlanPath,
	classifyIntent,
	createInitialState,
	extractMomusVerdict,
	isClearanceComplete,
	type PlanModeState,
	type PlanPhase,
	parseClearanceMarkers,
} from "./phases.js";
import {
	bugTriagePrompt,
	buildSystemPrompt,
	executionPrompt,
	ORCHESTRATOR_AWARENESS,
	postExecutionPrompt,
	verificationPrompt,
} from "./prompts.js";
import {
	auditToolCalls,
	extractTodoItems,
	extractWavePlan,
	formatEscalationContext,
	formatSiblingContext,
	generateVerificationChecks,
	getPlanningWriteRestriction,
	isSafeCommand,
	markCompletedSteps,
	type PlanFileMeta,
	selectRecentPlanFiles,
	type TodoItem,
} from "./utils.js";

// Phase-aware tool sets
const INTERVIEW_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit", "questionnaire", "subagent"];
const PLAN_GEN_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit", "subagent"];
const EXECUTION_TOOLS = ["read", "bash", "edit", "write", "subagent"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "subagent"];

const MAX_RETRIES = 2;

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Get the tool set for a given phase */
function toolsForPhase(phase: PlanPhase): string[] {
	switch (phase) {
		case "interview":
			return INTERVIEW_TOOLS;
		case "plan-generation":
		case "high-accuracy":
			return PLAN_GEN_TOOLS;
		case "execution":
			return EXECUTION_TOOLS;
		default:
			return NORMAL_MODE_TOOLS;
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	const _log = (msg: string) => {
		try {
			appendFileSync(join(homedir(), ".pi-plan-debug.log"), `${new Date().toISOString()} ${msg}\n`);
		} catch {}
	};
	_log("FACTORY: extension loaded (prometheus)");

	let state: PlanModeState = createInitialState();
	let promptStartMs = Date.now();

	// Track whether current input originated from a slash command (skill/template).
	// Set by the input handler (which sees original text before expansion),
	// consumed by before_agent_start.
	let inputIsSlashCommand = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (Prometheus planning flow)",
		type: "boolean",
		default: false,
	});

	// Detect slash commands before template expansion strips the "/" prefix.
	// Extension commands (/plan, /todos) are handled at Layer 1 in prompt() and
	// return before emitInput() fires — they never reach this handler.
	pi.on("input", async (event) => {
		inputIsSlashCommand = false; // Reset for every input (streaming safety)
		if (event.text.startsWith("/") && event.source !== "extension") {
			inputIsSlashCommand = true;
		}
	});

	// --- UI Helpers ---

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (state.phase === "execution" && state.todoItems.length > 0) {
			const completed = state.todoItems.filter((t) => t.completed).length;
			const current =
				state.currentWaveIndex < state.waves.length ? `wave ${state.waves[state.currentWaveIndex].wave}` : "";
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length} ${current}`),
			);
		} else if (state.phase !== "idle" && state.phase !== "complete") {
			const phaseLabel =
				state.phase === "interview"
					? "interview"
					: state.phase === "plan-generation"
						? "planning"
						: state.phase === "high-accuracy"
							? "review"
							: "plan";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `⏸ ${phaseLabel}`));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Sticky widget showing todo list
		if (state.todoItems.length > 0) {
			const header =
				state.phase === "execution"
					? ctx.ui.theme.fg("accent", "━━ Executing Plan ━━")
					: ctx.ui.theme.fg("warning", "━━ Plan ━━");
			const lines = [header];
			for (const item of state.todoItems) {
				if (item.completed) {
					lines.push(
						ctx.ui.theme.fg("success", "  ☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text)),
					);
				} else {
					lines.push(`  ${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`);
				}
			}
			if (state.phase === "execution") {
				const completed = state.todoItems.filter((t) => t.completed).length;
				lines.push(ctx.ui.theme.fg("muted", `  ${completed}/${state.todoItems.length} complete`));
			}
			ctx.ui.setWidget("plan-todos", lines, { maxLines: null });
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function resetState(): void {
		state = createInitialState();
		promptStartMs = Date.now();
	}

	function transitionTo(phase: PlanPhase, ctx: ExtensionContext): void {
		_log(`TRANSITION: ${state.phase} → ${phase}`);
		state.phase = phase;
		pi.setActiveTools(toolsForPhase(phase));
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			phase: state.phase,
			intent: state.intent,
			clearance: state.clearance,
			draftPath: state.draftPath,
			planPath: state.planPath,
			planText: state.planText,
			userPrompt: state.userPrompt,
			todoItems: state.todoItems,
			currentWaveIndex: state.currentWaveIndex,
			waves: state.waves,
		});
	}

	// --- Plan Saving ---

	function savePlan(cwd: string, planText: string, prompt: string, ctx: ExtensionContext): string {
		try {
			const planPath = buildPlanPath(cwd, prompt);
			const dir = join(cwd, ".pi", "plans");
			mkdirSync(dir, { recursive: true });

			const date = new Date().toISOString().slice(0, 10);
			const content = `# Plan: ${prompt}\n\n**Date:** ${date}\n\n${planText}\n`;
			writeFileSync(planPath, content, "utf-8");

			const relative = planPath.replace(`${cwd}/`, "");
			ctx.ui.notify(`Plan saved: ${relative}`, "info");
			return planPath;
		} catch {
			return "";
		}
	}

	function readPlanFiles(cwd: string): PlanFileMeta[] {
		const plansDir = join(cwd, ".pi", "plans");
		if (!existsSync(plansDir)) return [];
		const planFiles: PlanFileMeta[] = [];
		for (const fileName of readdirSync(plansDir).filter((f) => f.endsWith(".md"))) {
			const fullPath = join(plansDir, fileName);
			try {
				const fstat = statSync(fullPath);
				planFiles.push({ path: fullPath, mtimeMs: fstat.mtimeMs });
			} catch {
				/* ignore */
			}
		}
		return planFiles;
	}

	function getPlanCandidatePaths(cwd: string): string[] {
		const promptPlanPath = state.userPrompt ? buildPlanPath(cwd, state.userPrompt) : null;
		return selectRecentPlanFiles(readPlanFiles(cwd), promptStartMs, [state.planPath, promptPlanPath]);
	}

	function rehydrateTodoItemsFromSavedPlan(cwd?: string): boolean {
		const completedSteps = new Set(state.todoItems.filter((item) => item.completed).map((item) => item.step));
		const candidateTexts: string[] = [];

		if (state.planText?.trim()) {
			candidateTexts.push(state.planText);
		}

		const candidatePaths = new Set<string>();
		if (state.planPath) {
			candidatePaths.add(state.planPath);
		}
		if (cwd) {
			for (const planPath of getPlanCandidatePaths(cwd)) {
				candidatePaths.add(planPath);
			}
		}

		for (const planPath of candidatePaths) {
			try {
				const fileText = readFileSync(planPath, "utf-8");
				if (fileText.trim()) {
					candidateTexts.push(fileText);
					state.planPath = planPath;
				}
			} catch {
				/* ignore unreadable plan files */
			}
		}

		for (const planText of candidateTexts) {
			const wavePlan = extractWavePlan(planText);
			if (!wavePlan || wavePlan.todoItems.length === 0) continue;
			state.planText = planText;
			state.todoItems = wavePlan.todoItems.map((item) => ({
				...item,
				completed: completedSteps.has(item.step),
			}));
			state.waves = wavePlan.waves;
			return true;
		}

		return false;
	}

	// --- Execution ---

	/** Get current wave's uncompleted steps */
	function getCurrentWaveSteps(): TodoItem[] {
		if (state.currentWaveIndex >= state.waves.length) return [];
		const wave = state.waves[state.currentWaveIndex];
		return wave.steps
			.map((stepNum) => state.todoItems.find((t) => t.step === stepNum))
			.filter((t): t is TodoItem => t !== undefined && !t.completed);
	}

	function sendExecutionMessage(content: string, triggerTurn = true): void {
		// Keep execution control prompts out of chat. The sticky widget is the
		// single visible todo surface during execution.
		pi.sendMessage(
			{
				customType: "plan-mode-execute",
				content,
				display: false,
			},
			{ triggerTurn },
		);
	}

	/** Dispatch the next wave (or next step within current wave) */
	function dispatchNextWave(ctx: ExtensionContext): void {
		// Skip completed waves
		while (state.currentWaveIndex < state.waves.length) {
			const remaining = getCurrentWaveSteps();
			if (remaining.length > 0) break;
			state.currentWaveIndex++;
		}

		if (state.currentWaveIndex >= state.waves.length) {
			completeExecution(ctx);
			return;
		}

		const wave = state.waves[state.currentWaveIndex];
		const remaining = getCurrentWaveSteps();
		const allRemaining = state.todoItems.filter((t) => !t.completed);

		// Reset per-step tracking
		state.stepToolCalls = [];
		state.stepRetryCount = 0;
		state.verifyingStep = false;

		// Resolve all wave steps (including completed) for sibling context
		const allWaveSteps = wave.steps
			.map((stepNum) => state.todoItems.find((t) => t.step === stepNum))
			.filter((t): t is TodoItem => t !== undefined);

		if (remaining.length === 1) {
			// Single step — dispatch directly with sibling awareness
			const step = remaining[0];
			const siblingContext = formatSiblingContext(step, allWaveSteps);
			_log(`DISPATCH_STEP: wave ${wave.wave}, step ${step.step}`);
			sendExecutionMessage(executionPrompt(step, wave, allRemaining, siblingContext));
		} else {
			// Multiple steps — instruct agent to use subagent parallel mode with sibling annotations
			const stepList = remaining
				.map((t) => {
					const siblings = remaining.filter((s) => s.step !== t.step);
					const siblingNote =
						siblings.length > 0
							? `\n    Siblings: ${siblings.map((s) => `Step ${s.step} (${s.text})`).join(", ")}\n    DO NOT duplicate sibling work. Use stubs for sibling interfaces.`
							: "";
					return `- Step ${t.step}: ${t.text}${siblingNote}`;
				})
				.join("\n");
			_log(`DISPATCH_WAVE: wave ${wave.wave}, ${remaining.length} parallel steps`);
			sendExecutionMessage(`[EXECUTING PLAN — Wave ${wave.wave} — ${remaining.length} parallel tasks]

Execute these tasks in parallel using the subagent tool (parallel mode):

${stepList}

${ORCHESTRATOR_AWARENESS}

After all parallel tasks complete, report which steps are done with [DONE:N] markers.

Remaining steps (${allRemaining.length}):
${allRemaining.map((t) => `${t.step}. ${t.text}`).join("\n")}`);
		}
		updateStatus(ctx);
	}

	function completeExecution(ctx: ExtensionContext): void {
		const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
		const planName = state.userPrompt || "unknown";
		pi.sendMessage(
			{
				customType: "plan-complete",
				content: `**Plan Complete!** ✓\n\n${completedList}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		// Trigger post-execution learning recording
		_log("POST_EXECUTION: triggering learning recording");
		pi.sendMessage(
			{
				customType: "plan-mode-learn",
				content: postExecutionPrompt(planName),
				display: false,
			},
			{ triggerTurn: true },
		);

		resetState();
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		updateStatus(ctx);
		persistState();
	}

	/** Start execution from current plan */
	function startExecution(ctx: ExtensionContext): void {
		if (state.planText && ctx.cwd) {
			const planPath = savePlan(ctx.cwd, state.planText, state.userPrompt, ctx);
			if (planPath) state.planPath = planPath;
		}

		// Parse waves from plan text if not already done
		if (state.waves.length === 0 && state.planText) {
			const wavePlan = extractWavePlan(state.planText);
			if (wavePlan) {
				state.todoItems = wavePlan.todoItems;
				state.waves = wavePlan.waves;
			}
		}

		// Fallback: if still no todos, try extracting from "Plan:" header format
		if (state.todoItems.length === 0 && state.planText) {
			const extracted = extractTodoItems(state.planText);
			if (extracted.length > 0) {
				state.todoItems = extracted;
				state.waves = [{ wave: 1, steps: extracted.map((t) => t.step) }];
			}
		}

		// Last resort: read from plan file on disk (model may have written it via write tool)
		if (state.todoItems.length === 0 && ctx.cwd) {
			for (const planPath of getPlanCandidatePaths(ctx.cwd)) {
				try {
					const fileText = readFileSync(planPath, "utf-8");
					const wavePlan = extractWavePlan(fileText);
					if (wavePlan && wavePlan.todoItems.length > 0) {
						state.planText = fileText;
						state.todoItems = wavePlan.todoItems;
						state.waves = wavePlan.waves;
						state.planPath = planPath;
						_log(`EXECUTE_RECOVERED: from file ${planPath}, ${state.todoItems.length} items`);
						break;
					} else {
						const extracted = extractTodoItems(fileText);
						if (extracted.length > 0) {
							state.planText = fileText;
							state.todoItems = extracted;
							state.waves = [{ wave: 1, steps: extracted.map((t) => t.step) }];
							state.planPath = planPath;
							_log(`EXECUTE_RECOVERED: from file ${planPath} (fallback), ${state.todoItems.length} items`);
							break;
						}
					}
				} catch {
					/* ignore */
				}
			}
		}

		state.currentWaveIndex = 0;
		transitionTo("execution", ctx);
		persistState();

		if (state.todoItems.length > 0) {
			_log(`EXECUTE_START: ${state.todoItems.length} steps, ${state.waves.length} waves`);
			dispatchNextWave(ctx);
		} else {
			_log("EXECUTE_START: no todoItems extracted, dispatching generic execute");
			sendExecutionMessage("Execute the plan you just created.");
		}
	}

	// --- Commands ---

	pi.registerCommand("plan", {
		description: "Toggle plan mode (Prometheus planning flow)",
		handler: async (_args, ctx) => {
			if (state.phase !== "idle") {
				resetState();
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				ctx.ui.notify("Plan mode disabled. Full access restored.");
			} else {
				transitionTo("interview", ctx);
				ctx.ui.notify("Plan mode enabled (Prometheus interview phase).");
			}
			updateStatus(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (state.todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = state.todoItems
				.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (state.phase !== "idle") {
				resetState();
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				ctx.ui.notify("Plan mode disabled.");
			} else {
				transitionTo("interview", ctx);
				ctx.ui.notify("Plan mode enabled.");
			}
			updateStatus(ctx);
		},
	});

	// --- Event Handlers ---

	// Block destructive bash + enforce .pi/ path restriction during planning phases
	pi.on("tool_call", async (event) => {
		const inPlanning =
			state.phase === "interview" || state.phase === "plan-generation" || state.phase === "high-accuracy";

		// Track tools during step execution
		if (state.phase === "execution" && !state.verifyingStep) {
			state.stepToolCalls.push(event.toolName);
		}

		// .pi/ path restriction during planning phases.
		// Allow markdown docs anywhere under .pi/, plus machine specs under .pi/machines/.
		if (inPlanning && (event.toolName === "write" || event.toolName === "edit")) {
			const filePath = (event.input as { path?: string }).path || "";
			const restriction = getPlanningWriteRestriction(filePath, process.cwd());
			if (restriction) {
				return {
					block: true,
					reason: restriction,
				};
			}
		}

		// Bash safety during planning phases (read-only commands only)
		if (inPlanning && event.toolName === "bash") {
			const command = event.input.command as string;
			// Allow mkdir for .pi/ directories during planning
			const isMkdirPi = /^\s*mkdir\s+-p\s+.*\.pi\b/.test(command) || /^\s*mkdir\s+.*\.pi\b/.test(command);
			if (!isMkdirPi && !isSafeCommand(command)) {
				return {
					block: true,
					reason: `Planning phase: command blocked (not allowlisted). Use the write/edit tools for file operations in .pi/.\nCommand: ${command}`,
				};
			}
		}
	});

	// Filter out stale plan mode context when idle
	const STALE_MARKERS = ["[PLAN MODE ACTIVE]", "[plan-review]", "Prometheus"];

	pi.on("context", async (event) => {
		if (state.phase !== "idle") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === "plan-mode-execute") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !STALE_MARKERS.some((marker) => content.includes(marker));
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && STALE_MARKERS.some((marker) => (c as TextContent).text?.includes(marker)),
					);
				}
				return true;
			}),
		};
	});

	// System prompt injection — makes the agent become Prometheus
	pi.on("before_agent_start", async (event, ctx) => {
		_log(`BEFORE_AGENT_START: phase=${state.phase} prompt="${event.prompt?.slice(0, 50)}"`);
		if (!ctx.hasUI) return;

		// Auto-activate: classify intent and enter interview phase
		if (state.phase === "idle" && event.prompt) {
			// Skip auto-activation for slash commands (skills, templates).
			// The "/" prefix is stripped by template expansion before this event fires,
			// so we rely on the input handler (which sees original text) to set this flag.
			if (inputIsSlashCommand) {
				inputIsSlashCommand = false;
				_log(`SKIP_AUTO_ACTIVATE: slash command detected, letting it pass through`);
				return;
			}

			promptStartMs = Date.now();
			state.planPath = null;
			state.planText = "";
			state.todoItems = [];
			state.waves = [];
			state.currentWaveIndex = 0;

			state.userPrompt = event.prompt;
			state.intent = classifyIntent(event.prompt);
			_log(`INTENT: ${state.intent} for "${event.prompt.slice(0, 80)}"`);

			// Conversational signals — "continue", "yes", "go" — passthrough, no planning
			if (state.intent === "conversational") {
				_log("CONVERSATIONAL: passthrough, no planning");
				state.intent = null;
				state.userPrompt = "";
				return;
			}

			// Bug reports — delegate to debug agent, skip planning entirely
			if (state.intent === "bug") {
				_log("BUG: auto-delegating to debug agent");
				pi.sendMessage(
					{
						customType: "plan-mode-bug-triage",
						content: bugTriagePrompt(event.prompt),
						display: true,
					},
					{ triggerTurn: true },
				);
				// Stay idle — no Prometheus prompt injection, no phase transition
				state.intent = null;
				state.userPrompt = "";
				return;
			}

			// Questions — passthrough, no planning flow
			if (state.intent === "question") {
				_log("QUESTION: passthrough, no planning");
				// Stay idle — let the main agent handle the question naturally
				state.intent = null;
				state.userPrompt = "";
				return;
			}

			// Trivial requests skip interview, go straight to plan-generation
			if (state.intent === "trivial") {
				transitionTo("plan-generation", ctx);
			} else {
				transitionTo("interview", ctx);
			}
		}

		// Capture user prompt if not yet set
		if (!state.userPrompt && event.prompt) {
			state.userPrompt = event.prompt;
		}

		// Planning phases: inject Prometheus system prompt
		if (state.phase === "interview" || state.phase === "plan-generation" || state.phase === "high-accuracy") {
			return {
				systemPrompt: buildSystemPrompt(state),
			};
		}

		// Verification sub-turn during execution
		if (state.phase === "execution" && state.verifyingStep) {
			const step = state.todoItems.find((t) => !t.completed);
			if (step) {
				return {
					message: {
						customType: "plan-verify-context",
						content: verificationPrompt(step),
						display: false,
					},
				};
			}
		}
	});

	// Track clearance markers + [DONE:n] during execution
	pi.on("turn_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		const text = getTextContent(event.message);

		// Interview phase: scan for clearance markers
		if (state.phase === "interview") {
			const markers = parseClearanceMarkers(text);
			Object.assign(state.clearance, markers);
			state.interviewTurns++;
			_log(
				`TURN_END_INTERVIEW: turn=${state.interviewTurns} markers=${JSON.stringify(markers)} complete=${isClearanceComplete(state.clearance)}`,
			);
		}

		// Execution phase: track [DONE:n] markers
		if (state.phase === "execution" && state.todoItems.length > 0) {
			if (markCompletedSteps(text, state.todoItems) > 0) {
				updateStatus(ctx);
				persistState();
			}
		}
	});

	// Phase transition state machine
	pi.on("agent_end", async (event, ctx) => {
		_log(
			`AGENT_END: phase=${state.phase} hasUI=${ctx.hasUI} todoCount=${state.todoItems.length} waveIdx=${state.currentWaveIndex}`,
		);

		// --- Execution: verification turn completed ---
		if (state.phase === "execution" && state.verifyingStep) {
			state.verifyingStep = false;
			const step = state.todoItems.find((t) => !t.completed);
			if (!step) {
				dispatchNextWave(ctx);
				return;
			}

			const lastMsg = [...event.messages].reverse().find(isAssistantMessage);
			const verifyText = lastMsg ? getTextContent(lastMsg).toLowerCase() : "";
			const verifierFailed = verifyText.includes("[verification:fail]");

			if (verifierFailed && state.stepRetryCount < MAX_RETRIES) {
				state.stepRetryCount++;
				state.stepToolCalls = [];
				const errorDetail = lastMsg ? getTextContent(lastMsg) : "Verification failed";
				sendExecutionMessage(formatEscalationContext(step, state.stepRetryCount, MAX_RETRIES, errorDetail));
				return;
			}

			// Max retries exhausted — escalate to human if UI available
			if (verifierFailed && state.stepRetryCount >= MAX_RETRIES && ctx.hasUI) {
				const choice = await ctx.ui.select(`Step ${step.step} failed after ${MAX_RETRIES} retries. What to do?`, [
					"Retry once more",
					"Skip this step",
					"Abort execution",
				]);
				if (choice === "Retry once more") {
					state.stepRetryCount = 0;
					state.stepToolCalls = [];
					sendExecutionMessage(
						executionPrompt(
							step,
							null,
							state.todoItems.filter((t) => !t.completed),
						),
					);
					return;
				}
				if (choice === "Abort execution") {
					completeExecution(ctx);
					return;
				}
				// "Skip this step" falls through to mark complete
			}

			// Pass or skip — mark done and advance
			step.completed = true;
			state.stepToolCalls = [];
			state.stepRetryCount = 0;
			updateStatus(ctx);
			persistState();
			dispatchNextWave(ctx);
			return;
		}

		// --- Execution: step completed, run verification ---
		if (state.phase === "execution" && state.todoItems.length > 0) {
			const step = state.todoItems.find((t) => !t.completed);
			if (!step) {
				dispatchNextWave(ctx);
				return;
			}

			_log(`STEP_END: step ${step.step} tools=[${state.stepToolCalls.join(",")}]`);

			// Layer 1: Tool call audit
			const audit = auditToolCalls(step.text, state.stepToolCalls);
			if (!audit.pass && state.stepRetryCount < MAX_RETRIES) {
				state.stepRetryCount++;
				state.stepToolCalls = [];
				sendExecutionMessage(formatEscalationContext(step, state.stepRetryCount, MAX_RETRIES, audit.reason));
				return;
			}

			// Layer 2: Post-step verification commands
			const checks = generateVerificationChecks(step.text);
			const failures: string[] = [];
			for (const check of checks) {
				try {
					const result = await pi.exec(check.command, check.args, {
						cwd: ctx.cwd,
						timeout: 5000,
					});
					const expectedCode = check.expectExitCode ?? 0;
					if (result.code !== expectedCode) {
						failures.push(`${check.description}: exit code ${result.code} (expected ${expectedCode})`);
					}
					if (check.failOnEmpty && result.stdout.trim() === "") {
						failures.push(`${check.description}: no output`);
					}
				} catch {
					// skip failed checks
				}
			}

			if (failures.length > 0 && state.stepRetryCount < MAX_RETRIES) {
				state.stepRetryCount++;
				state.stepToolCalls = [];
				sendExecutionMessage(
					formatEscalationContext(
						step,
						state.stepRetryCount,
						MAX_RETRIES,
						failures.map((f) => `- ${f}`).join("\n"),
					),
				);
				return;
			}

			// Layer 3: Verifier turn for edit/create steps
			if (audit.action !== "read" && audit.action !== "general" && !state.verifyingStep) {
				state.verifyingStep = true;
				pi.sendMessage(
					{
						customType: "plan-verify",
						content: verificationPrompt(step),
						display: false,
					},
					{ triggerTurn: true },
				);
				return;
			}

			// Escalate to human if retries exhausted on audit/verification failures
			const hasUnresolvedFailures = (!audit.pass || failures.length > 0) && state.stepRetryCount >= MAX_RETRIES;
			if (hasUnresolvedFailures && ctx.hasUI) {
				const choice = await ctx.ui.select(`Step ${step.step} failed after ${MAX_RETRIES} retries. What to do?`, [
					"Retry once more",
					"Skip this step",
					"Abort execution",
				]);
				if (choice === "Retry once more") {
					state.stepRetryCount = 0;
					state.stepToolCalls = [];
					sendExecutionMessage(
						executionPrompt(
							step,
							null,
							state.todoItems.filter((t) => !t.completed),
						),
					);
					return;
				}
				if (choice === "Abort execution") {
					completeExecution(ctx);
					return;
				}
				// "Skip this step" falls through
			}

			// All checks passed or skipped — mark done
			step.completed = true;
			state.stepToolCalls = [];
			state.stepRetryCount = 0;
			updateStatus(ctx);
			persistState();
			dispatchNextWave(ctx);
			return;
		}

		// --- Interview phase: check clearance ---
		if (state.phase === "interview") {
			if (!ctx.hasUI) return;

			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const text = getTextContent(lastAssistant);
				// Re-check clearance markers from the final message
				const markers = parseClearanceMarkers(text);
				Object.assign(state.clearance, markers);

				if (isClearanceComplete(state.clearance)) {
					_log("CLEARANCE_COMPLETE: transitioning to plan-generation");
					if (ctx.cwd) {
						state.draftPath = buildDraftPath(ctx.cwd, state.userPrompt);
					}
					transitionTo("plan-generation", ctx);

					// Auto-trigger plan generation
					pi.sendUserMessage("All requirements clear. Generate the work plan now.", { deliverAs: "followUp" });
					return;
				}
			}

			// Fallback: if model wrote a plan file without emitting clearance markers,
			// force transition so plan-generation prompt (with TLA PreCheck) gets injected
			if (ctx.cwd) {
				const candidatePlanPaths = getPlanCandidatePaths(ctx.cwd);
				if (candidatePlanPaths.length > 0) {
					state.planPath = candidatePlanPaths[0];
					_log(`PLAN_FILE_DETECTED_IN_INTERVIEW: forcing transition to plan-generation (${state.planPath})`);
					state.draftPath = buildDraftPath(ctx.cwd, state.userPrompt);
					transitionTo("plan-generation", ctx);
					pi.sendUserMessage(
						"A plan file was written but the planning prompt was not applied. Re-evaluate the plan with the full plan-generation checklist, including the MANDATORY State Machine Assessment.",
						{ deliverAs: "followUp" },
					);
					return;
				}
			}

			// Not cleared yet — agent already asked a question per turn termination rules
			return;
		}

		// --- Plan generation phase: extract plan and show menu ---
		if (state.phase === "plan-generation") {
			if (!ctx.hasUI) return;

			// Strategy: try extracting TODOs from multiple sources
			// 1. Assistant message text (inline plan)
			// 2. Plan files on disk (model used write tool to save plan)
			// 3. Existing state.planPath if already set

			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const msgText = getTextContent(lastAssistant);

				// Try extracting from the assistant message first
				const wavePlan = extractWavePlan(msgText);
				if (wavePlan && wavePlan.todoItems.length > 0) {
					state.planText = msgText;
					state.todoItems = wavePlan.todoItems;
					state.waves = wavePlan.waves;
					_log(`PLAN_EXTRACTED: from assistant message, ${state.todoItems.length} items`);
				} else {
					const extracted = extractTodoItems(msgText);
					if (extracted.length > 0) {
						state.planText = msgText;
						state.todoItems = extracted;
						state.waves = [{ wave: 1, steps: extracted.map((t) => t.step) }];
						_log(`PLAN_EXTRACTED: from assistant message (fallback), ${state.todoItems.length} items`);
					}
				}

				// Save plan to .pi/plans/ if we have text
				if (ctx.cwd && msgText && msgText.length > 100) {
					const planPath = savePlan(ctx.cwd, msgText, state.userPrompt, ctx);
					if (planPath) state.planPath = planPath;
				}
			}

			// Fallback: if no TODOs extracted from message, read from plan files on disk
			// The model often writes the plan to .pi/plans/ via the write tool,
			// and the assistant message is just a summary ("Plan saved to...")
			if (state.todoItems.length === 0 && ctx.cwd) {
				for (const planPath of getPlanCandidatePaths(ctx.cwd)) {
					try {
						const fileText = readFileSync(planPath, "utf-8");
						const wavePlan = extractWavePlan(fileText);
						if (wavePlan && wavePlan.todoItems.length > 0) {
							state.planText = fileText;
							state.todoItems = wavePlan.todoItems;
							state.waves = wavePlan.waves;
							state.planPath = planPath;
							_log(`PLAN_EXTRACTED: from file ${planPath}, ${state.todoItems.length} items`);
							break;
						}
						const extracted = extractTodoItems(fileText);
						if (extracted.length > 0) {
							state.planText = fileText;
							state.todoItems = extracted;
							state.waves = [{ wave: 1, steps: extracted.map((t) => t.step) }];
							state.planPath = planPath;
							_log(`PLAN_EXTRACTED: from file ${planPath} (fallback), ${state.todoItems.length} items`);
							break;
						}
					} catch {
						/* ignore unreadable files */
					}
				}
			}

			_log(`PLAN_GEN_END: todoCount=${state.todoItems.length} waves=${state.waves.length}`);

			// Show plan only once via the sticky widget (avoid duplicate todo blocks in chat).
			if (state.todoItems.length > 0) {
				updateStatus(ctx);
			}

			// Smart menu: auto-execute for trivial, skip Momus option for non-complex
			if (state.intent === "trivial" && state.todoItems.length > 0) {
				_log("PLAN_AUTO_EXECUTE: trivial intent, skipping menu");
				startExecution(ctx);
				return;
			}

			const menuOptions: string[] = ["Start Work"];
			if (state.intent === "complex") {
				menuOptions.push("High Accuracy Review (Momus)");
			}
			menuOptions.push("Refine the plan", "Stay in plan mode");

			const choice = await ctx.ui.select("Plan generated — what next?", menuOptions);
			_log(`PLAN_MENU_CHOICE: "${choice}"`);

			if (choice === "Start Work") {
				startExecution(ctx);
			} else if (choice?.startsWith("High Accuracy")) {
				transitionTo("high-accuracy", ctx);
				pi.sendUserMessage("Submit the plan for high accuracy review.", {
					deliverAs: "followUp",
				});
			} else if (choice === "Refine the plan") {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
			}
			// "Stay in plan mode" — do nothing
			return;
		}

		// --- High accuracy phase: check Momus verdict ---
		if (state.phase === "high-accuracy") {
			if (!ctx.hasUI) return;

			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				const text = getTextContent(lastAssistant);
				const verdict = extractMomusVerdict(text);

				// Update plan text if the agent revised it
				if (text.includes("## TODOs") || text.includes("Plan:")) {
					state.planText = text;
					const wavePlan = extractWavePlan(text);
					if (wavePlan && wavePlan.todoItems.length > 0) {
						state.todoItems = wavePlan.todoItems;
						state.waves = wavePlan.waves;
					}
				}

				if (verdict === "REJECT") {
					state.momusCycles++;
					_log(`MOMUS_REJECT: cycle ${state.momusCycles}/${state.maxMomusCycles}`);

					if (state.momusCycles >= state.maxMomusCycles) {
						const continueChoice = await ctx.ui.select(`Momus rejected ${state.momusCycles} times. Continue?`, [
							"Continue reviewing",
							"Start Work anyway",
							"Refine manually",
						]);
						if (continueChoice === "Start Work anyway") {
							startExecution(ctx);
							return;
						}
						if (continueChoice === "Refine manually") {
							transitionTo("plan-generation", ctx);
							return;
						}
						state.momusCycles = 0;
					}

					pi.sendUserMessage("Momus rejected. Fix ALL issues and resubmit.", { deliverAs: "followUp" });
					return;
				}

				if (verdict === "OKAY") {
					_log("MOMUS_OKAY: plan approved");
					const menuOptions = ["Start Work", "Refine the plan"];
					const choice = await ctx.ui.select("Plan approved by Momus — what next?", menuOptions);
					if (choice === "Start Work") {
						startExecution(ctx);
					} else {
						transitionTo("plan-generation", ctx);
					}
					return;
				}

				// No verdict found — fallback menu
				const menuOptions = ["Start Work", "Continue review", "Refine the plan"];
				const choice = await ctx.ui.select("Review complete — what next?", menuOptions);
				if (choice === "Start Work") {
					startExecution(ctx);
				} else if (choice === "Continue review") {
					pi.sendUserMessage("Continue the Momus review.", {
						deliverAs: "followUp",
					});
				} else {
					transitionTo("plan-generation", ctx);
				}
			}
			return;
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		_log("SESSION_START fired");
		if (!ctx.hasUI) return;
		promptStartMs = Date.now();
		const startInPlanMode = pi.getFlag("plan") === true;

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| {
					data?: Partial<PlanModeState>;
			  }
			| undefined;

		if (planModeEntry?.data) {
			const d = planModeEntry.data;
			state.phase = d.phase ?? state.phase;
			state.intent = d.intent ?? state.intent;
			state.clearance = d.clearance ?? state.clearance;
			state.draftPath = d.draftPath ?? state.draftPath;
			state.planPath = d.planPath ?? state.planPath;
			state.planText = d.planText ?? state.planText;
			state.userPrompt = d.userPrompt ?? state.userPrompt;
			state.todoItems = d.todoItems ?? state.todoItems;
			state.currentWaveIndex = d.currentWaveIndex ?? state.currentWaveIndex;
			state.waves = d.waves ?? state.waves;
		}

		// Do not auto-resume interview/plan-generation/review across app restarts.
		// Those phases are prompt-bound and become confusing when restored later.
		if (
			!startInPlanMode &&
			(state.phase === "interview" || state.phase === "plan-generation" || state.phase === "high-accuracy")
		) {
			_log(`SESSION_RESET_NON_EXEC_PHASE: dropping stale ${state.phase} state`);
			resetState();
		}

		if (startInPlanMode) {
			state.phase = "interview";
		}

		if (state.phase === "execution" && state.todoItems.length > 0) {
			rehydrateTodoItemsFromSavedPlan(ctx.cwd);
		}

		// On resume: re-scan messages to rebuild completion state
		const isResume = planModeEntry !== undefined;
		if (isResume && state.phase === "execution" && state.todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, state.todoItems);
		}

		if (state.phase !== "idle" && state.phase !== "complete") {
			pi.setActiveTools(toolsForPhase(state.phase));
		}
		updateStatus(ctx);
	});
}
