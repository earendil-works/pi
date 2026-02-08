import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";
import type { ToolName } from "../tools/index.js";
import { findRepoRoot } from "../utils/find-repo-root.js";
import { generateFileTree } from "./file-tree.js";

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

type ContextFile = { path: string; content: string; scope: "user" | "project" };

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

function formatContextFiles(contextFiles: ContextFile[]): string {
	if (contextFiles.length === 0) {
		return "";
	}

	return contextFiles
		.map(({ path: filePath, content, scope }) => {
			const tag = scope === "user" ? "user_instructions" : "project_instructions";
			return `<${tag} source="${filePath}">\n${content}\n</${tag}>`;
		})
		.join("\n\n");
}

/**
 * Build the complete system prompt
 */
export async function buildSystemPrompt(options: {
	customPrompt?: string;
	selectedTools?: ToolName[];
	contextFiles?: ContextFile[];
	includeFileTree?: boolean;
}): Promise<string> {
	const { customPrompt, selectedTools, contextFiles = [], includeFileTree = true } = options;

	// Generate file tree if enabled
	let fileTreeSection = "";
	if (includeFileTree) {
		const fileTree = await generateFileTree({ cwd: process.cwd(), limit: 200 });
		if (fileTree) {
			fileTreeSection = `\nProject files:\n${fileTree}`;
		}
	}

	// If custom prompt provided, use it with context appended
	if (customPrompt) {
		let prompt = `<system_instructions>\n${customPrompt}\n</system_instructions>`;
		const contextBlock = formatContextFiles(contextFiles);

		if (contextBlock) {
			prompt += `\n\n${contextBlock}`;
		}

		prompt += `\n\n<metadata>\nCurrent working directory: ${process.cwd()}${fileTreeSection}\n</metadata>`;

		return prompt;
	}

	// Build from template
	const config = loadSystemPromptConfig();
	const tools =
		selectedTools ||
		(["Read", "Bash", "Edit", "Write", "ListThreads", "ReadThread", "ReadImage", "Todo", "Handoff"] as ToolName[]);

	// Build tools list
	const toolDescriptions = config.toolDescriptions;
	const toolsList = tools.map((t) => `- ${t}: ${toolDescriptions[t]}`).join("\n");

	// Build guidelines
	const guidelinesText = buildGuidelines(tools)
		.map((g) => `- ${g}`)
		.join("\n");

	// Build context files section
	let contextFilesSection = "";
	const contextBlock = formatContextFiles(contextFiles);
	if (contextBlock) {
		contextFilesSection = `\n\n${contextBlock}`;
	}

	// Replace placeholders in template
	const prompt = config.systemPrompt
		.replace("{{TOOLS_LIST}}", toolsList)
		.replace("{{GUIDELINES}}", guidelinesText)
		.replace("{{CONTEXT_FILES}}", contextFilesSection)
		.replace("{{FILE_TREE}}", fileTreeSection)
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
 * Get the prompt for selecting file slices for handoff.
 */
export function getHandoffFileSelectionPrompt(goal: string): string {
	const cwd = process.cwd();
	const repoRoot = findRepoRoot(cwd);
	const repoLine = repoRoot ? `Repository root: ${repoRoot}` : "Repository root: (not found)";

	return `You are selecting the exact file paths and line slices needed to continue a coding task.

TARGET GOAL: "${goal}"

${repoLine}
Current working directory: ${cwd}

Path rules:
- Use absolute paths OR paths relative to the repository root above.
- Prefer repo-root relative paths when possible (e.g., packages/app/src/file.ts).
- Do NOT use paths relative to the current working directory unless it matches the repo root.
- If the repository root is not found, use absolute paths.

Pick the minimal, high-signal set of files from the repository.
- Use slice syntax when only part of a file is needed:
  - 'src/foo.ts' (full file)
  - 'src/foo.ts:42' (single line)
  - 'src/foo.ts:10-50' (line range)
  - 'src/foo.ts:100-' (from line 100 to end)

Output ONLY XML using <handoff_files> and <file> tags.
- You may place <file> tags anywhere in the response; they will be extracted.
- Each <file> tag must contain a single file selection.
- Do NOT wrap the XML in Markdown/code fences.
- Do NOT escape XML tags (no &lt;file&gt;...&lt;/file&gt;). Use literal <file> tags.
- Do NOT wrap file selections in backticks or quotes.
- Example:
	<handoff_files>
	  <file>src/foo.ts</file>
	  <file>src/bar.ts:10-50</file>
	</handoff_files>
	`;
}

/**
 * Build the full system prompt for the *handoff file selection* model call.
 *
 * This wraps getHandoffFileSelectionPrompt() and optionally injects a project file tree,
 * so the model can choose valid paths.
 */
export function buildHandoffFileSelectionPrompt(params: { goal: string; fileTree?: string }): string {
	const base = getHandoffFileSelectionPrompt(params.goal);
	const trimmedTree = params.fileTree?.trim();
	if (!trimmedTree) return base;

	return (
		base +
		`

Project file tree (paths are relative to the repository root when available):
<file_tree>
${trimmedTree}
</file_tree>

Select file paths that actually exist in the tree above.
`
	);
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

Even if the conversation is unclear, do NOT output a generic placeholder like "Continue the current task".
Instead, output your best concrete guess based on the most recent user request.

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
