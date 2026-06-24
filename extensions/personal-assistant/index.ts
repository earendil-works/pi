import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemory, loadConfig, DEFAULT_DB_PATH, DEFAULT_ATOMS_DIR } from "./memory.ts";
import { registerTools } from "./tools.ts";
import { registerCron } from "./cron.ts";
import { registerAskUserQuestion } from "./ask_user_question.ts";
import type {
	MemoryAtom,
	MemoryAtomType,
	RecallResult,
	ExtractionItem,
	ExtractionResult,
	ExtractionPlan,
} from "./types.ts";
import type {
	RunMemoryExtractionOptions,
	RunMemoryExtractionResult,
	PersonalAssistantConfig,
} from "./memory.ts";

export default function (pi: ExtensionAPI): void {
	registerMemory(pi);
	registerTools(pi);
	registerCron(pi);
	registerAskUserQuestion(pi);
}

// Re-export v2 types
export type {
	MemoryAtom,
	MemoryAtomType,
	RecallResult,
	ExtractionItem,
	ExtractionResult,
	ExtractionPlan,
	RunMemoryExtractionOptions,
	RunMemoryExtractionResult,
	PersonalAssistantConfig,
};

// Re-export v2 runtime API (for webui consumption)
export { runMemoryExtraction, extractionPlanSchema, EXTRACT_PROMPT_V2, parseExtractionJson, executePlan, scoreUserTone, buildExtractionPrompt } from "./extraction.ts";
export { loadConfig, DEFAULT_DB_PATH, DEFAULT_ATOMS_DIR };