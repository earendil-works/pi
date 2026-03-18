/**
 * Plan Mode State Machine
 *
 * Types, phase transitions, and pure logic for the 3-phase planning flow.
 * Extracted for testability — no side effects, no extension API dependencies.
 */

import { join } from "node:path";
import { type ExecutionWave, isRequestComplex, type TodoItem } from "./utils.js";

// --- Types ---

export type PlanPhase = "idle" | "interview" | "plan-generation" | "high-accuracy" | "execution" | "complete";

export type IntentClass = "conversational" | "bug" | "question" | "trivial" | "simple" | "complex";

export interface ClearanceCheck {
	objectiveClear: boolean;
	scopeBoundaries: boolean;
	noAmbiguities: boolean;
	technicalApproach: boolean;
	testStrategy: boolean;
	noBlockingQuestions: boolean;
}

export interface PlanModeState {
	phase: PlanPhase;
	intent: IntentClass | null;
	clearance: ClearanceCheck;
	draftPath: string | null;
	planPath: string | null;
	planText: string;
	userPrompt: string;
	interviewTurns: number;
	momusCycles: number;
	maxMomusCycles: number;
	todoItems: TodoItem[];
	currentWaveIndex: number;
	waves: ExecutionWave[];
	stepToolCalls: string[];
	stepRetryCount: number;
	verifyingStep: boolean;
}

// --- State Factory ---

export function createInitialState(): PlanModeState {
	return {
		phase: "idle",
		intent: null,
		clearance: {
			objectiveClear: false,
			scopeBoundaries: false,
			noAmbiguities: false,
			technicalApproach: false,
			testStrategy: false,
			noBlockingQuestions: false,
		},
		draftPath: null,
		planPath: null,
		planText: "",
		userPrompt: "",
		interviewTurns: 0,
		momusCycles: 0,
		maxMomusCycles: 3,
		todoItems: [],
		currentWaveIndex: 0,
		waves: [],
		stepToolCalls: [],
		stepRetryCount: 0,
		verifyingStep: false,
	};
}

// --- Intent Classification ---

/** Minimum word count for simple intent (below = trivial) */
const TRIVIAL_MAX_WORDS = 7;

// --- Conversational Signal Detection ---

/**
 * Conversational signals — continuations, confirmations, approvals, and short
 * non-task inputs that should never enter the planning flow.
 */
const CONVERSATIONAL_PATTERNS = [
	// Continuations
	/^\s*(continue|go on|keep going|proceed|next|carry on)\s*[.!]?\s*$/i,
	// Confirmations / approvals
	/^\s*(yes|yeah|yep|yup|sure|ok|okay|k|go|go ahead|do it|ship it|lgtm|looks good|sounds good|perfect|great|fine|approved|correct|right|exactly|agreed|ack)\s*[.!]?\s*$/i,
	// Negations / cancels
	/^\s*(no|nope|nah|cancel|stop|abort|never\s*mind|nevermind)\s*[.!]?\s*$/i,
	// Gratitude
	/^\s*(thanks|thank you|thx|ty|cheers)\s*[.!]?\s*$/i,
	// Short follow-ups that reference prior context
	/^\s*(and|also|plus|but|wait|actually|hmm)\b.{0,20}$/i,
];

/** Maximum word count for conversational signals */
const CONVERSATIONAL_MAX_WORDS = 5;

/** Check if prompt is a conversational signal (not a task) */
function isConversationalSignal(prompt: string): boolean {
	const words = prompt.trim().split(/\s+/);
	if (words.length > CONVERSATIONAL_MAX_WORDS) return false;
	return CONVERSATIONAL_PATTERNS.some((p) => p.test(prompt));
}

// --- Bug Detection ---

/** Build/create verbs that should never be classified as bug or question */
const BUILD_VERB_PATTERN =
	/^\s*(build|create|implement|make|set\s*up|setup|scaffold|generate|develop|design|add|write|start|launch|spin\s*up)\b/i;

/** Bug signals — error reports, broken functionality, stack traces */
const BUG_PATTERNS = [
	/\b(broken|crash(?:es|ed|ing)?|not\s+working|stopped\s+working|doesn'?t\s+work|does\s+not\s+work|won'?t\s+work|isn'?t\s+working)\b/i,
	/\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/,
	/\b(ECONNREFUSED|ENOENT|EPERM|EACCES|ETIMEDOUT|ECONNRESET)\b/,
	/\b(undefined\s+is\s+not|cannot\s+read|null\s+pointer|segfault|panic|FATAL)\b/i,
	/\b(regression|broke\b|breaks\b|breaking\b)\b/i,
	/\b(500\s+error|404\s+error|403\s+error|401\s+error|502\s+error|503\s+error)\b/i,
	/\bstack\s*trace\b/i,
	/\b(exception|error)\b.*\b(thrown|occurred|happening|keeps|getting)\b/i,
	/\b(getting|seeing|got|received)\b.*\b(error|exception|crash|failure)\b/i,
];

/** Check if prompt describes a bug report (not a build request involving error-like words) */
function isBugReport(prompt: string): boolean {
	// Build requests are never bugs, even if they mention error-related words
	if (BUILD_VERB_PATTERN.test(prompt)) return false;
	return BUG_PATTERNS.some((p) => p.test(prompt));
}

// --- Question Detection ---

const QUESTION_START_PATTERN =
	/^\s*(what|how|why|where|when|who|which|can\s+you\s+explain|tell\s+me|is\s+it|is\s+there|are\s+there|does|do|should|could|would)\b/i;

/** Check if prompt is a pure question (not a build/action request) */
function isQuestionPrompt(prompt: string): boolean {
	if (BUILD_VERB_PATTERN.test(prompt)) return false;
	const hasQuestionMark = prompt.trim().endsWith("?");
	const startsWithQuestion = QUESTION_START_PATTERN.test(prompt);
	return hasQuestionMark || startsWithQuestion;
}

// --- Intent Classification ---

/**
 * Classify user prompt into bug / question / trivial / simple / complex.
 *
 * Priority order:
 * 1. bug: error reports, stack traces, "not working" signals (unless it's a build request)
 * 2. question: information requests, "how/what/why" (unless it's a build request)
 * 3. trivial: fewer than 8 words, single-action verbs, short fix requests
 * 4. complex: passes isRequestComplex (multi-tech, multi-deliverable, build verbs + scope)
 * 5. simple: everything else
 */
export function classifyIntent(prompt: string): IntentClass {
	const words = prompt.trim().split(/\s+/);

	// Conversational signals — "continue", "yes", "go", "ok" — never plan these
	if (isConversationalSignal(prompt)) return "conversational";

	// Bug reports — error signals, stack traces, "not working" (excludes build requests)
	if (words.length > TRIVIAL_MAX_WORDS && isBugReport(prompt)) return "bug";

	// Questions — pure information requests, but only longer ones (short questions stay trivial)
	if (isQuestionPrompt(prompt) && words.length > TRIVIAL_MAX_WORDS) return "question";

	// Short prompts and pure questions are trivial
	if (words.length <= TRIVIAL_MAX_WORDS) return "trivial";
	if (/^\s*(what|how|why|where|when|can you explain|tell me)\b/i.test(prompt) && words.length < 20) return "trivial";

	// Single-action fix/debug requests are trivial
	if (/^\s*(fix|debug|resolve|rename|move|delete|remove|typo)\b/i.test(prompt) && words.length < 15) return "trivial";

	// Complex if multi-domain/multi-tech/multi-deliverable
	if (isRequestComplex(prompt)) return "complex";

	return "simple";
}

// --- Clearance Check ---

const CLEARANCE_MARKERS: Record<string, keyof ClearanceCheck> = {
	"[CLEAR:objective]": "objectiveClear",
	"[CLEAR:scope]": "scopeBoundaries",
	"[CLEAR:ambiguities]": "noAmbiguities",
	"[CLEAR:approach]": "technicalApproach",
	"[CLEAR:tests]": "testStrategy",
	"[CLEAR:questions]": "noBlockingQuestions",
};

/**
 * Scan text for [CLEAR:*] markers and return the matched fields.
 */
export function parseClearanceMarkers(text: string): Partial<ClearanceCheck> {
	const result: Partial<ClearanceCheck> = {};
	for (const [marker, field] of Object.entries(CLEARANCE_MARKERS)) {
		if (text.includes(marker)) {
			result[field] = true;
		}
	}
	return result;
}

/**
 * Check if all 6 clearance conditions are met.
 */
export function isClearanceComplete(check: ClearanceCheck): boolean {
	return (
		check.objectiveClear &&
		check.scopeBoundaries &&
		check.noAmbiguities &&
		check.technicalApproach &&
		check.testStrategy &&
		check.noBlockingQuestions
	);
}

// --- Momus Verdict ---

/**
 * Extract Momus verdict from text. Returns "OKAY", "REJECT", or null.
 */
export function extractMomusVerdict(text: string): "OKAY" | "REJECT" | null {
	if (/\[OKAY\]/i.test(text)) return "OKAY";
	if (/\[REJECT\]/i.test(text)) return "REJECT";
	return null;
}

// --- Path Builders ---

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50)
		.replace(/-$/, "");
}

export function buildDraftPath(cwd: string, prompt: string): string {
	const slug = slugify(prompt) || "draft";
	return join(cwd, ".pi", "drafts", `${slug}.md`);
}

export function buildPlanPath(cwd: string, prompt: string): string {
	const slug = slugify(prompt) || "plan";
	return join(cwd, ".pi", "plans", `${slug}.md`);
}

export function buildEvidencePath(cwd: string, taskNum: number, slug: string, ext: string): string {
	return join(cwd, ".pi", "evidence", `task-${taskNum}-${slug}.${ext}`);
}
