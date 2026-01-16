import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";
import type { ToolName } from "../tools/index.js";

// -----------------------------------------------------------------------------
// Handoff Nudge Constants
// -----------------------------------------------------------------------------

export { HANDOFF_NUDGE_THRESHOLD } from "../auto-handoff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types for the system.yaml structure
interface GuidelineCondition {
	present?: ToolName[];
	absent?: ToolName[];
	anyPresent?: ToolName[];
}

interface Guideline {
	condition?: GuidelineCondition;
	text: string;
}

interface SystemPromptConfig {
	systemPrompt: string;
	toolDescriptions: Record<ToolName, string>;
	guidelines: Guideline[];
}

// Cache for loaded configs
let systemPromptConfig: SystemPromptConfig | null = null;
let toolDescriptionsConfig: Record<string, string> | null = null;

/**
 * Load and parse the system prompt configuration
 */
function loadSystemPromptConfig(): SystemPromptConfig {
	if (systemPromptConfig) {
		return systemPromptConfig;
	}

	const yamlPath = join(__dirname, "system.yaml");
	const content = readFileSync(yamlPath, "utf-8");
	systemPromptConfig = parse(content) as SystemPromptConfig;
	return systemPromptConfig;
}

/**
 * Load and parse the tool descriptions configuration
 */
function loadToolDescriptionsConfig(): Record<string, string> {
	if (toolDescriptionsConfig) {
		return toolDescriptionsConfig;
	}

	const yamlPath = join(__dirname, "tools.yaml");
	const content = readFileSync(yamlPath, "utf-8");
	toolDescriptionsConfig = parse(content) as Record<string, string>;
	return toolDescriptionsConfig;
}

/**
 * Get the short tool descriptions for the system prompt
 */
export function getToolDescriptions(): Record<ToolName, string> {
	const config = loadSystemPromptConfig();
	return config.toolDescriptions;
}

/**
 * Get the full tool description for a specific tool (used in tool definitions sent to LLM)
 */
export function getToolDescription(toolName: string): string {
	const config = loadToolDescriptionsConfig();
	const description = config[toolName];
	if (!description) {
		throw new Error(`No description found for tool: ${toolName}`);
	}
	return description.trim();
}

/**
 * Check if a guideline's condition is satisfied given the selected tools
 */
function isGuidelineSatisfied(condition: GuidelineCondition | undefined, selectedTools: ToolName[]): boolean {
	if (!condition) {
		return true; // No condition means always include
	}

	// Check "present" - all listed tools must be present
	if (condition.present) {
		for (const tool of condition.present) {
			if (!selectedTools.includes(tool)) {
				return false;
			}
		}
	}

	// Check "absent" - all listed tools must be absent
	if (condition.absent) {
		for (const tool of condition.absent) {
			if (selectedTools.includes(tool)) {
				return false;
			}
		}
	}

	// Check "anyPresent" - at least one of the listed tools must be present
	if (condition.anyPresent) {
		let anyFound = false;
		for (const tool of condition.anyPresent) {
			if (selectedTools.includes(tool)) {
				anyFound = true;
				break;
			}
		}
		if (!anyFound) {
			return false;
		}
	}

	return true;
}

/**
 * Build the guidelines list based on selected tools
 */
export function buildGuidelines(selectedTools: ToolName[]): string[] {
	const config = loadSystemPromptConfig();
	const guidelines: string[] = [];

	for (const guideline of config.guidelines) {
		if (isGuidelineSatisfied(guideline.condition, selectedTools)) {
			guidelines.push(guideline.text);
		}
	}

	return guidelines;
}

/**
 * Build the complete system prompt
 */
export function buildSystemPrompt(options: {
	customPrompt?: string;
	selectedTools?: ToolName[];
	contextFiles?: Array<{ path: string; content: string }>;
}): string {
	const { customPrompt, selectedTools, contextFiles = [] } = options;

	// If custom prompt provided, use it with context appended
	if (customPrompt) {
		let prompt = customPrompt;

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "The following project context files have been loaded:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		prompt += `\n<metadata>\nCurrent working directory: ${process.cwd()}\n</metadata>`;

		return prompt;
	}

	// Build from template
	const config = loadSystemPromptConfig();
	const tools =
		selectedTools ||
		([
			"Read",
			"Bash",
			"Edit",
			"Write",
			"Grep",
			"Glob",
			"ListThreads",
			"ReadThread",
			"ReadImage",
			"TodoWrite",
			"Handoff",
		] as ToolName[]);

	// Build tools list
	const toolDescriptions = config.toolDescriptions;
	const toolsList = tools.map((t) => `- ${t}: ${toolDescriptions[t]}`).join("\n");

	// Build guidelines
	const guidelinesText = buildGuidelines(tools)
		.map((g) => `- ${g}`)
		.join("\n");

	// Build context files section
	let contextFilesSection = "";
	if (contextFiles.length > 0) {
		contextFilesSection = "\n\n# Project Context\n\n";
		contextFilesSection += "The following project context files have been loaded:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			contextFilesSection += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Replace placeholders in template
	const prompt = config.systemPrompt
		.replace("{{TOOLS_LIST}}", toolsList)
		.replace("{{GUIDELINES}}", guidelinesText)
		.replace("{{CONTEXT_FILES}}", contextFilesSection)
		.replace("{{CWD}}", process.cwd());

	return prompt;
}

/**
 * Get the prompt for generating a handoff document
 */
export function getHandoffPrompt(goal: string): string {
	return `You are generating a handoff document for a new coding session.

TARGET GOAL: "${goal}"

Based on the conversation history, output a Markdown document with these sections:

## Context Summary
High-level architectural context and key decisions made.

## Current Status
What was just completed and the current state of the code.

## Relevant Files
List of file paths crucial for the goal (full paths as bullet points).

## Next Steps
Concrete instructions to achieve the target goal.

IMPORTANT: Output ONLY the Markdown document. Do NOT include any preamble, introduction, or conversational text like "Here is the handoff document" or "I'll generate...". Start directly with "## Context Summary".`;
}

/**
 * Get the prompt for auto-generating a handoff goal from conversation context.
 * Used when context reaches 95% and auto-handoff triggers.
 */
export function getAutoHandoffGoalPrompt(): string {
	return `You are selecting the single most useful next step for the user based on the conversation.

Output ONE short, imperative goal (max 12 words).
- No quotes
- No markdown
- No trailing punctuation
- Start with a verb (e.g., "Implement", "Fix", "Add", "Complete")

If the conversation is unclear about what to do next, output: "Continue the current task"

Examples of good goals:
- Implement the OAuth logout flow
- Fix the failing unit tests
- Add error handling to the API endpoint
- Complete the database migration`;
}

/**
 * Get the system reminder content for handoff nudge.
 * This is appended to the last tool result to encourage voluntary handoff.
 * @param ratio - Current context usage ratio (0.0 to 1.0)
 */
export function getHandoffNudgeReminder(ratio: number): string {
	const percent = Math.round(ratio * 100);
	return `

<system_reminder>
Context usage is at ${percent}%. Consider using the Handoff tool to start a fresh session with selected file context before auto-handoff triggers at 95%.
</system_reminder>`;
}
