import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type { Api, Model } from "@kennyfrc/mu-ai";
import { supportsXhigh } from "@kennyfrc/mu-ai";
import { parse as parseYaml } from "yaml";
import { findModel } from "./model-config.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

export interface SlashCommandModelOverride {
	provider: string;
	modelId: string;
	reasoningLevel?: ThinkingLevel;
}

export interface FileSlashCommand {
	name: string;
	description: string;
	content: string;
	source: string;
	modelOverride?: SlashCommandModelOverride;
}

interface SlashCommandFrontmatter {
	description?: string;
	provider?: string;
	model?: string;
	reasoning_level?: ThinkingLevel;
}

interface ParsedFrontmatterResult {
	frontmatter: SlashCommandFrontmatter;
	content: string;
}

export interface LoadSlashCommandsOptions {
	cwd?: string;
	configDir?: string;
}

export interface ResolvedSlashCommandInput {
	command: FileSlashCommand;
	expandedText: string;
}

const VALID_REASONING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function getConfigDir(baseDir?: string): string {
	return resolve(baseDir ?? process.env.MU_CODING_AGENT_DIR ?? join(homedir(), ".mu", "agent"));
}

function parseFrontmatter(markdown: string): ParsedFrontmatterResult {
	if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
		return { frontmatter: {}, content: markdown };
	}

	const yamlStart = markdown.match(/^---\r?\n/)?.[0].length ?? 4;
	const closeMatch = /\r?\n---\r?\n/.exec(markdown.slice(yamlStart));
	if (!closeMatch) {
		return { frontmatter: {}, content: markdown };
	}

	const closingIndex = yamlStart + closeMatch.index;
	const yamlText = markdown.slice(yamlStart, closingIndex + 1);
	const body = markdown.slice(closingIndex + closeMatch[0].length).trim();
	const parsed = parseYaml(yamlText);

	if (typeof parsed !== "object" || parsed === null) {
		return { frontmatter: {}, content: body };
	}

	const candidate = parsed as Record<string, unknown>;
	const reasoning = candidate.reasoning_level;
	return {
		frontmatter: {
			description: typeof candidate.description === "string" ? candidate.description.trim() : undefined,
			provider: typeof candidate.provider === "string" ? candidate.provider.trim() : undefined,
			model: typeof candidate.model === "string" ? candidate.model.trim() : undefined,
			reasoning_level:
				typeof reasoning === "string" && VALID_REASONING_LEVELS.has(reasoning as ThinkingLevel)
					? (reasoning as ThinkingLevel)
					: undefined,
		},
		content: body,
	};
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i += 1) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

function loadCommandsFromDir(dir: string, source: "user" | "project", subdir = ""): FileSlashCommand[] {
	const commands: FileSlashCommand[] = [];
	if (!existsSync(dir)) return commands;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				commands.push(...loadCommandsFromDir(fullPath, source, nextSubdir));
				continue;
			}

			if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".md")) {
				continue;
			}

			try {
				const raw = readFileSync(fullPath, "utf8");
				const { frontmatter, content } = parseFrontmatter(raw);
				const sourceLabel =
					source === "user"
						? subdir
							? `(user:${subdir})`
							: "(user)"
						: subdir
							? `(project:${subdir})`
							: "(project)";
				let description = frontmatter.description ?? "";
				if (!description) {
					const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0);
					if (firstLine) {
						description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
					}
				}

				const provider = frontmatter.provider?.trim();
				const model = frontmatter.model?.trim();
				const modelOverride =
					provider && model
						? { provider, modelId: model, reasoningLevel: frontmatter.reasoning_level }
						: undefined;

				commands.push({
					name: entry.name.slice(0, -3),
					description: description ? `${description} ${sourceLabel}` : sourceLabel,
					content,
					source: sourceLabel,
					modelOverride,
				});
			} catch {
				// Ignore malformed command files
			}
		}
	} catch {
		// Ignore unreadable command directories
	}

	return commands;
}

export function loadSlashCommands(options: LoadSlashCommandsOptions = {}): FileSlashCommand[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const configDir = getConfigDir(options.configDir);
	return [
		...loadCommandsFromDir(join(configDir, "commands"), "user"),
		...loadCommandsFromDir(resolve(cwd, ".mu", "commands"), "project"),
	];
}

export function resolveSlashCommandInput(text: string, commands: FileSlashCommand[]): ResolvedSlashCommandInput | null {
	if (!text.startsWith("/")) return null;
	const withoutSlash = text.slice(1);
	const spaceIndex = withoutSlash.indexOf(" ");
	const commandName = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1);
	const command = commands.find((candidate) => candidate.name === commandName);
	if (!command) return null;
	return {
		command,
		expandedText: substituteArgs(command.content, parseCommandArgs(argsString)),
	};
}

export function resolveSlashCommandModelSelection(
	command: FileSlashCommand,
): { model: Model<Api>; thinkingLevel: ThinkingLevel } | { error: string } | null {
	if (!command.modelOverride) return null;
	const { provider, modelId, reasoningLevel } = command.modelOverride;
	const { model, error } = findModel(provider, modelId);
	if (error) {
		return { error };
	}
	if (!model) {
		return { error: `Slash command /${command.name} configured unknown model ${provider}/${modelId}` };
	}

	const requestedThinking = reasoningLevel ?? "medium";
	let thinkingLevel: ThinkingLevel = requestedThinking;
	if (!model.reasoning) {
		thinkingLevel = "off";
	} else if (thinkingLevel === "xhigh" && !supportsXhigh(model)) {
		thinkingLevel = "high";
	}

	return { model, thinkingLevel };
}

export async function applySlashCommandModelSelection(args: {
	command: FileSlashCommand;
	agent: Agent;
	sessionManager?: SessionManager;
	settingsManager?: SettingsManager;
	onModelChanged?: (model: Model<Api>) => Promise<void> | void;
	onThinkingLevelChanged?: (thinkingLevel: ThinkingLevel) => void;
}): Promise<{ applied: boolean; message?: string }> {
	const selection = resolveSlashCommandModelSelection(args.command);
	if (!selection) {
		return { applied: false };
	}
	if ("error" in selection) {
		throw new Error(selection.error);
	}

	args.agent.setModel(selection.model);
	args.sessionManager?.saveModelChange(selection.model.provider, selection.model.id);
	args.settingsManager?.setDefaultModelAndProvider(selection.model.provider, selection.model.id);
	await args.onModelChanged?.(selection.model);

	args.agent.setThinkingLevel(selection.thinkingLevel);
	args.sessionManager?.saveThinkingLevelChange(selection.thinkingLevel);
	args.settingsManager?.setDefaultThinkingLevel(selection.thinkingLevel);
	args.onThinkingLevelChanged?.(selection.thinkingLevel);

	const thinkingSuffix =
		selection.model.reasoning && selection.thinkingLevel !== "off" ? ` (thinking: ${selection.thinkingLevel})` : "";
	return {
		applied: true,
		message: `Slash command model: ${selection.model.provider}/${selection.model.id}${thinkingSuffix}`,
	};
}
