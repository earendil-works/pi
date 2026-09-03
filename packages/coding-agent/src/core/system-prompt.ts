/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. */
	selectedTools: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt: string;
	/** Text appended at the absolute end of the rendered prompt. */
	promptTail: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills: Skill[];
}

/** Backwards-compatible input accepted by the prompt builder. Hooks receive normalized options. */
export type BuildSystemPromptInput = Pick<BuildSystemPromptOptions, "cwd"> &
	Partial<Omit<BuildSystemPromptOptions, "cwd">>;

export type SystemPromptPiece = { type: "literal"; text: string } | { type: "value"; key: string; text: string };

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const SYSTEM_PROMPT_VALUE_SUBJECTS: Record<string, string> = {
	projectContext: "project-specific instructions",
	skills: "skill guidance",
	tools: "available tool guidance",
	guidelines: "operating guidelines",
	promptTail: "additional system guidance",
};

/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptInput): BuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? [])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		promptTail: input.promptTail ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

export function renderSystemPrompt(pieces: readonly SystemPromptPiece[]): string {
	return pieces.map((piece) => piece.text).join("");
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return "";
	let context = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of contextFiles) {
		context += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${context}</project_context>\n`;
}

function appendCustomSectionPieces(
	pieces: SystemPromptPiece[],
	sections: Record<string, string>,
	separator: string,
	suffix: string,
): void {
	for (const [name, content] of Object.entries(sections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name)) {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
		if (content.length === 0) continue;
		pieces.push({
			type: "value",
			key: `section:${name}`,
			text: `${separator}<${name}>\n${content}\n</${name}>${suffix}`,
		});
	}
}

/** Build the system prompt as immutable literals interleaved with keyed dynamic values. */
export function buildSystemPromptPieces(input: BuildSystemPromptInput): SystemPromptPiece[] {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		forceSystemPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		promptTail,
		sections,
		cwd,
		contextFiles,
		skills,
	} = options;

	if (forceSystemPrompt !== undefined) {
		return [{ type: "value", key: "forceSystemPrompt", text: forceSystemPrompt }];
	}

	const promptCwd = cwd.replace(/\\/g, "/");
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const projectContext = renderProjectContext(contextFiles);
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => selectedTools.includes(tool));

	if (customPrompt) {
		const pieces: SystemPromptPiece[] = [
			{ type: "value", key: "customPrompt", text: customPrompt },
			{ type: "value", key: "appendSystemPrompt", text: appendSection },
			{ type: "value", key: "projectContext", text: projectContext },
			{
				type: "value",
				key: "skills",
				text: skillFileReadTool && skills.length > 0 ? formatSkillsForPrompt(skills, skillFileReadTool) : "",
			},
			{ type: "literal", text: "\nCurrent working directory: " },
			{ type: "value", key: "cwd", text: promptCwd },
			{ type: "literal", text: "\n" },
		];
		appendCustomSectionPieces(pieces, sections, "\n", "\n");
		pieces.push({ type: "value", key: "promptTail", text: promptTail });
		return pieces;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const guideline of toolGuidelines[name] ?? []) addGuideline(guideline);
	}
	for (const guideline of promptGuidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
	const pieces: SystemPromptPiece[] = [
		{
			type: "literal",
			text: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n",
		},
		{ type: "value", key: "tools", text: toolsList },
		{
			type: "literal",
			text: "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n",
		},
		{ type: "value", key: "guidelines", text: guidelines },
		{
			type: "literal",
			text: `\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`,
		},
		{ type: "value", key: "appendSystemPrompt", text: appendSection },
		{ type: "value", key: "projectContext", text: projectContext },
		{
			type: "value",
			key: "skills",
			text: skillFileReadTool && skills.length > 0 ? formatSkillsForPrompt(skills, skillFileReadTool) : "",
		},
		{ type: "literal", text: "\nCurrent working directory: " },
		{ type: "value", key: "cwd", text: promptCwd },
	];
	appendCustomSectionPieces(pieces, sections, "\n\n", "");
	pieces.push({ type: "value", key: "promptTail", text: promptTail });
	return pieces;
}

/** Build the system prompt with tools, guidelines, and context. */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
	return renderSystemPrompt(buildSystemPromptPieces(input));
}

export type SystemPromptDiff = { type: "unchanged" } | { type: "update"; text: string } | { type: "replace" };

/** Keys whose change cannot be expressed as an appended instruction. */
const BASE_INSTRUCTION_KEYS = new Set(["forceSystemPrompt", "customPrompt", "appendSystemPrompt"]);

/**
 * Render semantic, source-specific instructions for changed prompt values.
 *
 * Both piece lists come from the same builder, so their literal skeletons only
 * differ when the prompt switched template (default, custom, or forced). That,
 * or a change to the base instructions themselves, requires a new baseline.
 * Every other change is a keyed value update that can be appended.
 */
export function diffSystemPrompts(
	previous: readonly SystemPromptPiece[],
	current: readonly SystemPromptPiece[],
): SystemPromptDiff {
	const literals = (pieces: readonly SystemPromptPiece[]): string =>
		JSON.stringify(pieces.flatMap((piece) => (piece.type === "literal" ? [piece.text] : [])));
	if (literals(previous) !== literals(current)) return { type: "replace" };

	const values = (pieces: readonly SystemPromptPiece[]): Map<string, string> =>
		new Map(pieces.flatMap((piece) => (piece.type === "value" ? [[piece.key, piece.text] as const] : [])));
	const previousValues = values(previous);
	const currentValues = values(current);
	const updates: string[] = [];
	for (const key of new Set([...previousValues.keys(), ...currentValues.keys()])) {
		const oldValue = (previousValues.get(key) ?? "").trim();
		const newValue = (currentValues.get(key) ?? "").trim();
		if (oldValue === newValue) continue;
		if (BASE_INSTRUCTION_KEYS.has(key)) return { type: "replace" };
		updates.push(renderSystemPromptValueUpdate(key, oldValue, newValue));
	}
	if (updates.length === 0) return { type: "unchanged" };
	return { type: "update", text: updates.join("\n\n") };
}

function renderSystemPromptValueUpdate(key: string, previous: string, current: string): string {
	if (key === "cwd") return `The current working directory is now: ${current}`;
	const subject =
		SYSTEM_PROMPT_VALUE_SUBJECTS[key] ??
		(key.startsWith("section:") ? `<${key.slice("section:".length)}> system guidance` : "system guidance");
	if (!current) return `The previous ${subject} no longer applies.`;
	if (!previous) return `The following ${subject} now applies:\n\n${current}`;
	return `The ${subject} has changed. The following supersedes the previous ${subject}:\n\n${current}`;
}
