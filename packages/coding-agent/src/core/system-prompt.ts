/**
 * System prompt construction and project context loading
 */

import { isDeepStrictEqual } from "node:util";
import type { SystemMessage, Tool, ToolReference, TranscriptCapabilities } from "@earendil-works/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/** A normal prompt has an exact prefix followed by independently replaceable sections. */
export type SystemPromptDefinition =
	| { type: "structured"; prefix: string; sections: Record<string, string> }
	| { type: "override"; text: string };

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderSection(name: string, content: string): string {
	return `<${name}>\n${content}\n</${name}>`;
}

export function renderSystemPrompt(prompt: SystemPromptDefinition): string {
	if (prompt.type === "override") return prompt.text;
	const sections = Object.entries(prompt.sections).map(([name, content]) => renderSection(name, content));
	return prompt.prefix ? [prompt.prefix, ...sections].join("\n\n") : sections.join("\n\n");
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the exact prefix and independently replaceable sections of the system prompt. */
export function buildSystemPromptDefinition(input: BuildSystemPromptOptions): SystemPromptDefinition {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		forceSystemPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	if (forceSystemPrompt !== undefined) {
		return { type: "override", text: forceSystemPrompt };
	}

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name)) {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const promptSections: Record<string, string> = {};
	let prefix: string;
	if (customPrompt) {
		prefix = customPrompt;
	} else {
		prefix =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = buildRules(selectedTools, toolGuidelines, promptGuidelines);
		promptSections.docs = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => selectedTools.includes(tool));
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	return { type: "structured", prefix, sections: promptSections };
}

/** Build the system prompt with tools, rules, and context. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return renderSystemPrompt(buildSystemPromptDefinition(input));
}

export type SystemPromptDiff = { type: "unchanged" } | { type: "update"; text: string } | { type: "replace" };

/** Compare structured prompt sections. Prefix or opaque override changes require a complete replacement. */
export function diffSystemPrompts(previous: SystemPromptDefinition, current: SystemPromptDefinition): SystemPromptDiff {
	if (previous.type === "override" || current.type === "override") {
		return renderSystemPrompt(previous) === renderSystemPrompt(current) ? { type: "unchanged" } : { type: "replace" };
	}
	if (previous.prefix !== current.prefix) return { type: "replace" };

	const updates: string[] = [];
	for (const [name, content] of Object.entries(current.sections)) {
		if (previous.sections[name] !== content) updates.push(renderSection(name, content));
	}
	const removed = Object.keys(previous.sections).filter((name) => current.sections[name] === undefined);
	if (removed.length > 0) {
		updates.push(`Removed system prompt sections: ${removed.map((name) => `<${name}>`).join(", ")}.`);
	}
	return updates.length > 0 ? { type: "update", text: updates.join("\n\n") } : { type: "unchanged" };
}

export interface ModelContextState {
	prompt: SystemPromptDefinition;
	tools: Map<string, Tool>;
	modelKey: string;
}

/** Prepare one coherent prompt and tool transition for the next provider request. */
export function prepareModelContextUpdate(input: {
	options: NormalizedBuildSystemPromptOptions;
	tools: Map<string, Tool>;
	previous?: ModelContextState;
	capabilities: TranscriptCapabilities;
	modelKey: string;
}): { state: ModelContextState; message?: SystemMessage } {
	const { options, tools, previous, capabilities, modelKey } = input;
	const prompt = buildSystemPromptDefinition(options);
	const currentPrompt = renderSystemPrompt(prompt);
	const state: ModelContextState = { prompt, tools, modelKey };
	if (!previous) {
		return {
			state,
			message: {
				role: "system",
				content: currentPrompt,
				toolsAdded: [...tools.values()],
				timestamp: Date.now(),
			},
		};
	}

	const promptDiff = diffSystemPrompts(previous.prompt, prompt);
	const toolsAdded = [...tools]
		.filter(([name, tool]) => {
			const oldTool = previous.tools.get(name);
			return oldTool === undefined || !isDeepStrictEqual(oldTool, tool);
		})
		.map(([, tool]) => tool);
	const toolsRemoved: ToolReference[] = [...previous.tools]
		.filter(([name, tool]) => {
			const newTool = tools.get(name);
			return newTool === undefined || !isDeepStrictEqual(tool, newTool);
		})
		.map(([name]) => ({ name }));
	const toolDefinitionsChanged = toolsAdded.some((tool) => previous.tools.has(tool.name));

	if (
		previous.modelKey === modelKey &&
		promptDiff.type === "unchanged" &&
		toolsAdded.length === 0 &&
		toolsRemoved.length === 0
	) {
		return { state };
	}

	const canUpdatePrompt = promptDiff.type === "unchanged" || capabilities.midConversationSystemMessages;
	const canAddTools = toolsAdded.length === 0 || capabilities.midConversationToolAdditions;
	const canRemoveTools = toolsRemoved.length === 0 || capabilities.midConversationToolRemovals;
	const requiresReplacement =
		previous.modelKey !== modelKey ||
		toolDefinitionsChanged ||
		promptDiff.type === "replace" ||
		!canUpdatePrompt ||
		!canAddTools ||
		!canRemoveTools;
	const content: string[] = [];
	if (requiresReplacement) {
		content.push(
			`The following is the complete current system prompt. It supersedes all earlier system prompt updates:\n\n${currentPrompt}`,
		);
	} else if (promptDiff.type === "update") {
		content.push(promptDiff.text);
	}
	if (toolsAdded.length > 0) {
		content.push(
			`The following tools are now available and may be used: ${toolsAdded.map((tool) => tool.name).join(", ")}.`,
		);
	}
	if (toolsRemoved.length > 0) {
		content.push(
			`The following tools are no longer available. Do not call them; such calls will be rejected: ${toolsRemoved.map((tool) => tool.name).join(", ")}.`,
		);
	}
	return {
		state,
		message: {
			role: "system",
			content: content.join("\n\n"),
			toolsAdded: toolsAdded.length > 0 ? toolsAdded : undefined,
			toolsRemoved: toolsRemoved.length > 0 ? toolsRemoved : undefined,
			timestamp: Date.now(),
		},
	};
}
