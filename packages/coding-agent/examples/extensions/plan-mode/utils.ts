/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	// File operations — anchored to command position to avoid matching paths
	/^\s*rm\b/i,
	/^\s*rmdir\b/i,
	/^\s*mv\b/i,
	/^\s*cp\b/i,
	/^\s*mkdir\b/i,
	/^\s*touch\b/i,
	/^\s*chmod\b/i,
	/^\s*chown\b/i,
	/^\s*chgrp\b/i,
	/^\s*ln\b/i,
	/^\s*tee\b/i,
	/^\s*truncate\b/i,
	/^\s*dd\b/i,
	/^\s*shred\b/i,
	// Redirects (after stripping >/dev/null and 2>&1)
	/(^|[^<\d])>(?!>)(?!\/dev\/null)/,
	/>>(?!\/dev\/null)/,
	// Package managers — subcommand patterns (anchored)
	/^\s*npm\s+(install|uninstall|update|ci|link|publish)/i,
	/^\s*yarn\s+(add|remove|install|publish)/i,
	/^\s*pnpm\s+(add|remove|install|publish)/i,
	/^\s*pip\s+(install|uninstall)/i,
	/^\s*apt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/^\s*brew\s+(install|uninstall|upgrade)/i,
	// Git write commands (anchored)
	/^\s*git\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	// Dangerous commands — anchored
	/^\s*sudo\b/i,
	/^\s*su\b/i,
	/^\s*kill\b/i,
	/^\s*pkill\b/i,
	/^\s*killall\b/i,
	/^\s*reboot\b/i,
	/^\s*shutdown\b/i,
	/^\s*systemctl\s+(start|stop|restart|enable|disable)/i,
	/^\s*service\s+\S+\s+(start|stop|restart)/i,
	// Editors — anchored
	/^\s*(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const _SAFE_PATTERNS = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

export function isSafeCommand(command: string): boolean {
	// Strip harmless shell redirections before checking (2>&1, >/dev/null, etc.)
	const cleaned = command.replace(/\d*>&\d+/g, "").replace(/\d*>\/dev\/null/g, "");
	// Split compound commands (&&, ||, ;, |) and check each part
	const parts = cleaned.split(/\s*(?:&&|\|\||[;|])\s*/);
	return parts.every((part) => {
		const trimmed = part.trim();
		if (!trimmed) return true;
		const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed));
		// Allow any command that isn't destructive, OR is explicitly safelisted
		return !isDestructive;
	});
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const stepNum = parseInt(match[1], 10);
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: stepNum, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

export interface PlanFileMeta {
	path: string;
	mtimeMs: number;
}

/**
 * Select candidate plan files for the active prompt.
 * Keeps only files touched after the prompt started, then prioritizes
 * known/preferred paths before generic recency order.
 */
export function selectRecentPlanFiles(
	files: PlanFileMeta[],
	minMtimeMs: number,
	preferredPaths: Array<string | null | undefined> = [],
): string[] {
	const recent = files.filter((f) => f.mtimeMs >= minMtimeMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
	const ordered: string[] = [];

	for (const preferredPath of preferredPaths) {
		if (!preferredPath) continue;
		if (recent.some((f) => f.path === preferredPath) && !ordered.includes(preferredPath)) {
			ordered.push(preferredPath);
		}
	}

	for (const file of recent) {
		if (!ordered.includes(file.path)) {
			ordered.push(file.path);
		}
	}

	return ordered;
}

// --- Step verification ---

export type StepAction = "create" | "edit" | "delete" | "test" | "install" | "read" | "general";

const ACTION_PATTERNS: [StepAction, RegExp][] = [
	["create", /\b(create|new file|new component|add file|scaffold|generate|write file|set up|initialize)\b/i],
	["edit", /\b(edit|modify|update|change|refactor|fix|adjust|rename|replace|restructure|move.*to|simplify)\b/i],
	["delete", /\b(delete|remove file|drop|clean up unused)\b/i],
	["test", /\b(tests?|run tests?|verify|check.*pass|ensure.*work|validate)\b/i],
	["install", /\b(install|add dependency|add package|npm add|yarn add|pnpm add)\b/i],
	["read", /\b(read|check|review|inspect|examine|analyze|explore|look at)\b/i],
];

/** Infer what type of work a step is supposed to do */
export function inferStepAction(stepText: string): StepAction {
	for (const [action, pattern] of ACTION_PATTERNS) {
		if (pattern.test(stepText)) return action;
	}
	return "general";
}

/** Expected tools for each action type — at least one must appear */
const EXPECTED_TOOLS: Record<StepAction, string[]> = {
	create: ["write", "edit", "bash"],
	edit: ["edit", "write"],
	delete: ["bash", "edit", "write"],
	test: ["bash"],
	install: ["bash"],
	read: [], // read-only steps don't need specific tools
	general: [], // anything goes
};

export interface AuditResult {
	pass: boolean;
	reason: string;
	action: StepAction;
}

/** Check if the tools called match what the step expected */
export function auditToolCalls(stepText: string, toolsCalled: string[]): AuditResult {
	const action = inferStepAction(stepText);
	const expected = EXPECTED_TOOLS[action];

	// No expectations for read/general steps
	if (expected.length === 0) {
		return { pass: true, reason: "", action };
	}

	// No tools called at all is suspicious for action steps
	if (toolsCalled.length === 0) {
		return { pass: false, reason: `No tools called. Expected: ${expected.join("/")}`, action };
	}

	// Check if at least one expected tool was used
	if (expected.some((t) => toolsCalled.includes(t))) {
		return { pass: true, reason: "", action };
	}

	return {
		pass: false,
		reason: `Step action "${action}" expected ${expected.join("/")} tool(s) but only used: ${[...new Set(toolsCalled)].join(", ")}`,
		action,
	};
}

/** Extract file paths from step text */
export function extractFilePaths(text: string): string[] {
	const paths: string[] = [];
	// Match paths like src/foo/bar.ts, ./foo.js, components/Header.tsx
	for (const match of text.matchAll(
		/(?:^|\s|`)((?:\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|css|scss|html|vue|svelte|yaml|yml|toml))\b/g,
	)) {
		paths.push(match[1]);
	}
	return [...new Set(paths)];
}

export interface VerificationCheck {
	description: string;
	command: string;
	args: string[];
	expectExitCode?: number; // default 0
	failOnEmpty?: boolean;
}

/** Generate bash checks to verify a step was actually completed */
export function generateVerificationChecks(stepText: string, fullStepText?: string): VerificationCheck[] {
	const checks: VerificationCheck[] = [];
	const action = inferStepAction(stepText);
	const source = fullStepText || stepText;
	const filePaths = extractFilePaths(source);

	if (action === "create" && filePaths.length > 0) {
		for (const fp of filePaths) {
			checks.push({
				description: `File ${fp} exists`,
				command: "test",
				args: ["-f", fp],
				expectExitCode: 0,
			});
		}
	}

	if ((action === "edit" || action === "create") && filePaths.length > 0) {
		// Check git diff includes the expected files
		checks.push({
			description: "Git diff shows changes",
			command: "git",
			args: ["diff", "--name-only"],
			failOnEmpty: true,
		});
	}

	if (action === "delete" && filePaths.length > 0) {
		for (const fp of filePaths) {
			checks.push({
				description: `File ${fp} is deleted`,
				command: "test",
				args: ["!", "-f", fp],
				expectExitCode: 0,
			});
		}
	}

	return checks;
}

// --- Sibling awareness ---

/**
 * Format sibling context for parallel wave dispatch.
 * Lists other tasks in the same wave so the executing agent knows
 * what NOT to duplicate and can define stubs for sibling interfaces.
 *
 * Adapted from ComposioHQ/agent-orchestrator's sibling awareness pattern.
 */
export function formatSiblingContext(currentStep: TodoItem, allWaveSteps: TodoItem[]): string {
	const siblings = allWaveSteps.filter((s) => s.step !== currentStep.step);
	if (siblings.length === 0) return "";

	const siblingList = siblings.map((s) => `- Step ${s.step}: ${s.text}`).join("\n");
	return `## Parallel Siblings (DO NOT duplicate)
${siblingList}
Stay focused on YOUR task only. Do not implement functionality that belongs to sibling tasks.
If you need interfaces/types from siblings, define reasonable local stubs.`;
}

/**
 * Format an escalation/retry context message with error details.
 * Used when a step fails and needs to be retried with richer context.
 *
 * Adapted from ComposioHQ/agent-orchestrator's reaction engine pattern.
 */
export function formatEscalationContext(
	step: TodoItem,
	retryCount: number,
	maxRetries: number,
	errorContext: string,
): string {
	return `[Step ${step.step} — RETRY ${retryCount}/${maxRetries}] Previous attempt failed.

Error context:
${errorContext}

Re-do: ${step.text}

Fix the issue described above. If you need a different approach, explain what you'll change.`;
}

// --- Parallel execution waves ---

export interface FullStep {
	step: number;
	text: string; // full description from plan
	dependencies: number[]; // step numbers this depends on
}

export interface ExecutionWave {
	wave: number;
	steps: number[]; // step numbers in this wave
}

const FOUNDATION_PATTERN =
	/\b(scaffold|setup|set up|init|install|create project|project structure|bootstrap|configure|configuration)\b/i;
const FINALIZATION_PATTERN =
	/\b(polish|final|test|deploy|review|responsive|optimize|clean.?up|documentation|readme)\b/i;

/** Extract full step text blocks from a plan (not truncated like TodoItem) */
export function extractFullSteps(planText: string): FullStep[] {
	const headerMatch = planText.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return [];

	const planSection = planText.slice(planText.indexOf(headerMatch[0]) + headerMatch[0].length);

	// Find all numbered step start positions
	const stepStartPattern = /^\s*(\d+)[.)]\s+/gm;
	const starts: { index: number; num: number; matchLen: number }[] = [];
	for (const match of planSection.matchAll(stepStartPattern)) {
		starts.push({ index: match.index, num: parseInt(match[1], 10), matchLen: match[0].length });
	}

	const steps: FullStep[] = [];
	for (let i = 0; i < starts.length; i++) {
		const textStart = starts[i].index + starts[i].matchLen;
		const textEnd = i + 1 < starts.length ? starts[i + 1].index : planSection.length;
		const text = planSection.slice(textStart, textEnd).trim();
		if (text.length > 0) {
			steps.push({ step: starts[i].num, text, dependencies: [] });
		}
	}

	// Analyze dependencies
	for (const step of steps) {
		step.dependencies = detectDependencies(step, steps);
	}

	return steps;
}

function detectDependencies(step: FullStep, allSteps: FullStep[]): number[] {
	const deps = new Set<number>();
	const lower = step.text.toLowerCase();

	// Explicit references: "after step 1", "from step 2", "using step 3"
	for (const match of lower.matchAll(/(?:after|from|using|once|requires?|depends?\s+on)\s+step\s+(\d+)/g)) {
		const ref = parseInt(match[1], 10);
		if (ref !== step.step) deps.add(ref);
	}

	// Foundation steps: all non-foundation steps depend on step 1 if it's a setup step
	if (deps.size === 0 && step.step > 1) {
		const step1 = allSteps.find((s) => s.step === 1);
		if (step1 && FOUNDATION_PATTERN.test(step1.text)) {
			deps.add(1);
		}
	}

	// Finalization steps: depend on all non-finalization steps
	if (FINALIZATION_PATTERN.test(step.text)) {
		for (const other of allSteps) {
			if (other.step < step.step && !FINALIZATION_PATTERN.test(other.text)) {
				deps.add(other.step);
			}
		}
	}

	return [...deps].filter((d) => d !== step.step);
}

/** Group steps into parallel execution waves based on dependencies */
export function createWaves(steps: FullStep[]): ExecutionWave[] {
	if (steps.length === 0) return [];

	const waves: ExecutionWave[] = [];
	const completed = new Set<number>();
	const remaining = new Set(steps.map((s) => s.step));

	let waveNum = 1;
	while (remaining.size > 0) {
		const waveSteps: number[] = [];

		for (const stepNum of remaining) {
			const step = steps.find((s) => s.step === stepNum);
			if (!step) continue;
			if (step.dependencies.every((d) => completed.has(d))) {
				waveSteps.push(stepNum);
			}
		}

		if (waveSteps.length === 0) {
			// Unresolvable dependencies — dump remaining into final wave
			waveSteps.push(...remaining);
		}

		waves.push({ wave: waveNum, steps: waveSteps.sort((a, b) => a - b) });
		for (const s of waveSteps) {
			completed.add(s);
			remaining.delete(s);
		}
		waveNum++;
	}

	return waves;
}

// --- Auto-plan detection ---

// Minimum word count to consider a prompt for auto-planning
const AUTO_PLAN_MIN_WORDS = 8;

/** Classify a user prompt as complex enough to require auto-planning */
export function isRequestComplex(prompt: string): boolean {
	const lower = prompt.toLowerCase();

	// Skip short prompts, questions, and single-task requests
	const words = prompt.trim().split(/\s+/);
	if (words.length < AUTO_PLAN_MIN_WORDS) return false;

	// Skip pure questions (likely asking for info, not building)
	if (/^\s*(what|how|why|where|when|can you explain|tell me)\b/i.test(prompt) && words.length < 20) return false;

	// Skip fix/debug requests — these are targeted, not multi-step builds
	if (
		/^\s*(fix|debug|resolve|investigate|check|review|update|change|rename|move|delete|remove)\b/i.test(prompt) &&
		words.length < 20
	)
		return false;

	// Build verbs — signals a construction task (not a fix/tweak)
	const buildVerb =
		/^\s*(make|create|build|develop|set up|setup|scaffold|generate|design|implement|start|launch|spin up)\b/i;
	const hasBuildVerb = buildVerb.test(prompt);

	// Scope keywords — signals a multi-step build task
	const scopeKeywords =
		/\b(website|web app|webapp|application|app|platform|dashboard|portal|system|service|api|landing page|saas|mvp|prototype|clone|store|shop|marketplace|ecommerce|e-commerce)\b/i;

	// Technology signals — multiple tech mentions = complexity
	const techPatterns = [
		/\b(react|nextjs|next\.js|vue|svelte|angular|remix|astro)\b/i,
		/\b(tailwind|css|styled|sass|scss)\b/i,
		/\b(node|express|fastify|nest|hono|bun)\b/i,
		/\b(postgres|mysql|sqlite|mongodb|prisma|drizzle|supabase|firebase)\b/i,
		/\b(stripe|pays?|payments?|checkout|billing|paypal)\b/i,
		/\b(auth|login|signup|session|jwt|oauth)\b/i,
		/\b(docker|deploy|ci\/cd|vercel|cloudflare|aws)\b/i,
		/\b(api|rest|graphql|trpc|endpoint)\b/i,
	];
	const techMatches = techPatterns.filter((p) => p.test(lower)).length;

	// Multiple deliverables — "with X, Y, and Z"
	const deliverablePattern = /\bwith\b.*\b(and|,)\b/i;
	const hasMultipleDeliverables = deliverablePattern.test(prompt);

	// Scoring
	const hasScope = scopeKeywords.test(lower);
	const isLong = words.length >= 25;

	// Complex if: build verb + scope + any tech (the clearest signal — "make a website with stripe")
	if (hasBuildVerb && hasScope && techMatches >= 1) return true;
	// scope + multiple tech
	if (hasScope && techMatches >= 2) return true;
	// scope + multiple deliverables + tech
	if (hasScope && hasMultipleDeliverables && techMatches >= 1) return true;
	// 3+ tech mentions alone
	if (techMatches >= 3) return true;
	// scope + long prompt + tech
	if (hasScope && isLong && techMatches >= 1) return true;

	return false;
}

// --- .pi/ path restriction ---

import { resolve } from "node:path";

/**
 * Check if a file path is within the .pi/ directory of the given cwd.
 * Used to enforce write restrictions during planning phases.
 */
export function isWithinPiDir(filePath: string, cwd: string): boolean {
	const resolved = resolve(cwd, filePath);
	const piDir = resolve(cwd, ".pi");
	return resolved.startsWith(`${piDir}/`) || resolved === piDir;
}

export function getPlanningWriteRestriction(filePath: string, cwd: string): string | null {
	const normalizedPath = filePath.replace(/\\/g, "/");
	const isMarkdownPath = normalizedPath.endsWith(".md");
	const isMachinePath = /(^|\/)\.pi\/machines\/.+\.machine\.ts$/.test(normalizedPath);

	if (!isWithinPiDir(filePath, cwd)) {
		return `Planning phase: writes restricted to .md files in .pi/ and .machine.ts files in .pi/machines/. Path "${filePath}" is outside .pi/.`;
	}

	if (/(^|\/)\.pi\/machines\/.+\.machine\.js$/.test(normalizedPath)) {
		return `Planning phase: ".machine.js" is an execution artifact, not a planning artifact. Write only ".pi/machines/*.machine.ts" during planning, and delegate verification to the tla-precheck subagent.`;
	}

	if (!isMarkdownPath && !isMachinePath) {
		return `Planning phase: only .md files or .pi/machines/*.machine.ts files are allowed. Path "${filePath}" is not an allowed planning file.`;
	}

	return null;
}

// --- Wave plan extraction ---

export interface WavePlan {
	title: string;
	waves: ExecutionWave[];
	steps: FullStep[];
	todoItems: TodoItem[];
}

/**
 * Parse a plan with explicit ### Wave N headers and numbered task items.
 * Falls back to extractFullSteps + createWaves when no wave headers are found.
 */
export function extractWavePlan(planText: string): WavePlan | null {
	// Try to extract title from first # heading
	const titleMatch = planText.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1].trim() : "Untitled Plan";

	// Try explicit wave format first: ### Wave N headers
	const waveHeaderPattern = /###\s*Wave\s+(\d+)[^\n]*/gi;
	const waveHeaders: { wave: number; index: number }[] = [];
	for (const match of planText.matchAll(waveHeaderPattern)) {
		waveHeaders.push({ wave: parseInt(match[1], 10), index: match.index });
	}

	if (waveHeaders.length > 0) {
		return parseExplicitWaves(planText, title, waveHeaders);
	}

	// Fallback: check for ## TODOs section (Prometheus plan format)
	const todosMatch = planText.match(/^##\s+TODOs?\s*$/im);
	if (todosMatch) {
		return parseTodoSection(planText, title, todosMatch.index!);
	}

	// Final fallback: use existing extractFullSteps + createWaves
	const fullSteps = extractFullSteps(planText);
	if (fullSteps.length === 0) return null;

	const waves = createWaves(fullSteps);
	const todoItems: TodoItem[] = fullSteps.map((s) => ({
		step: s.step,
		text: cleanStepText(s.text.split("\n")[0]),
		completed: false,
	}));

	return { title, waves, steps: fullSteps, todoItems };
}

function parseExplicitWaves(planText: string, title: string, waveHeaders: { wave: number; index: number }[]): WavePlan {
	const steps: FullStep[] = [];
	const waves: ExecutionWave[] = [];
	const todoItems: TodoItem[] = [];

	for (let i = 0; i < waveHeaders.length; i++) {
		const start = waveHeaders[i].index;
		const end = i + 1 < waveHeaders.length ? waveHeaders[i + 1].index : planText.length;
		const section = planText.slice(start, end);
		const waveNum = waveHeaders[i].wave;

		const waveSteps: number[] = [];
		// Match task items: "├── Task N:" or "- [ ] N." or numbered items
		const taskPattern = /(?:├──\s*Task\s+(\d+)|─\s*Task\s+(\d+)|-\s*\[[ x]\]\s*(\d+)\.|^\s*(\d+)[.)]\s+)/gim;
		for (const match of section.matchAll(taskPattern)) {
			const num = parseInt(match[1] || match[2] || match[3] || match[4], 10);
			if (!Number.isFinite(num)) continue;

			// Extract the text after the task number
			const afterMatch = section.slice(match.index! + match[0].length);
			const lineEnd = afterMatch.indexOf("\n");
			const firstLine = lineEnd >= 0 ? afterMatch.slice(0, lineEnd).trim() : afterMatch.trim();
			const text = firstLine
				.replace(/^\*{1,2}/, "")
				.replace(/\*{1,2}$/, "")
				.trim();

			if (text.length > 0) {
				const deps = waveNum > 1 ? waves.flatMap((w) => w.steps) : [];
				steps.push({ step: num, text, dependencies: deps });
				todoItems.push({ step: num, text: cleanStepText(text), completed: false });
				waveSteps.push(num);
			}
		}

		if (waveSteps.length > 0) {
			waves.push({ wave: waveNum, steps: waveSteps });
		}
	}

	if (steps.length === 0) return { title, waves: [], steps: [], todoItems: [] };
	return { title, waves, steps, todoItems };
}

function parseTodoSection(planText: string, title: string, todosIndex: number): WavePlan {
	const section = planText.slice(todosIndex);
	// Stop at next ## heading
	const nextHeading = section.match(/\n##\s+[^#]/);
	const todoText = nextHeading ? section.slice(0, nextHeading.index!) : section;

	const steps: FullStep[] = [];
	const todoItems: TodoItem[] = [];

	// Match "- [ ] N. [Title]" pattern
	const todoPattern = /^-\s*\[[ x]\]\s*(\d+)\.\s+(.+)$/gm;
	for (const match of todoText.matchAll(todoPattern)) {
		const num = parseInt(match[1], 10);
		const text = match[2]
			.trim()
			.replace(/^\*{1,2}/, "")
			.replace(/\*{1,2}$/, "")
			.trim();

		// Look for Blocked By in subsequent lines (before next todo item)
		const afterMatch = todoText.slice(match.index! + match[0].length);
		const nextItemIdx = afterMatch.search(/^-\s*\[[ x]\]\s*\d+\./m);
		const blockSearchArea = nextItemIdx >= 0 ? afterMatch.slice(0, nextItemIdx) : afterMatch;
		const blockedByMatch = blockSearchArea.match(/\*{0,2}Blocked\s+By\*{0,2}:\s*([^\n]+)/i);
		const deps: number[] = [];
		if (blockedByMatch && !/none/i.test(blockedByMatch[1])) {
			for (const depMatch of blockedByMatch[1].matchAll(/(\d+)/g)) {
				deps.push(parseInt(depMatch[1], 10));
			}
		}

		steps.push({ step: num, text, dependencies: deps });
		todoItems.push({ step: num, text: cleanStepText(text), completed: false });
	}

	if (steps.length === 0) return null as unknown as WavePlan;

	const waves = createWaves(steps);
	return { title, waves, steps, todoItems };
}

// --- Plan complexity detection ---

const COMPLEX_STEP_THRESHOLD = 4;

/** Determine if a plan is complex based on step count and content signals */
export function isPlanComplex(planText: string, stepCount: number): boolean {
	if (stepCount >= COMPLEX_STEP_THRESHOLD) return true;

	// Multi-domain signals
	const hasFrontend = /\b(component|tsx|jsx|css|ui|react|layout|style)\b/i.test(planText);
	const hasBackend = /\b(api|endpoint|database|migration|server|route|middleware)\b/i.test(planText);
	if (hasFrontend && hasBackend) return true;

	// Dependency signals — steps explicitly referencing other steps
	const dependencyPattern = /\b(after step\s*\d|depends on step|requires step\s*\d|before step\s*\d|blocked by)\b/i;
	if (dependencyPattern.test(planText)) return true;

	// Multi-file signals
	const fileRefs = planText.match(/\b[\w/-]+\.(ts|js|tsx|jsx|py|go|rs|md)\b/g);
	if (fileRefs && new Set(fileRefs).size > 3) return true;

	return false;
}
