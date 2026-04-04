import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type ProfileThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ParsedModelRef {
	provider: string;
	modelId: string;
	thinkingLevel: ProfileThinkingLevel | null;
	fullId: string;
	normalizedRef: string;
}

export interface AgentProfileModel {
	model: string;
	fallbackModel?: string;
}

export interface ProfileDefinition {
	main: {
		model: string;
	};
	enabledModels?: string[];
	fallbackTargets?: string[];
	agents: Record<string, AgentProfileModel>;
}

export interface ProfilesConfig {
	activeProfile?: string;
	profiles: Record<string, ProfileDefinition>;
}

interface SettingsSnapshot {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ProfileThinkingLevel;
	enabledModels?: string[];
}

const MODEL_REF_PATTERN = /^(?<provider>[^/]+)\/(?<modelId>.+?)(?::(?<thinking>off|minimal|low|medium|high|xhigh))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

function buildModelRef(provider: string, modelId: string, thinkingLevel?: ProfileThinkingLevel): string {
	return thinkingLevel ? `${provider}/${modelId}:${thinkingLevel}` : `${provider}/${modelId}`;
}

function selectAnthropicAgentModel(availableModelIds: Set<string>): string {
	if (availableModelIds.has("factory-openai/claude-sonnet-4-6")) {
		return "factory-openai/claude-sonnet-4-6:xhigh";
	}
	if (availableModelIds.has("factory-openai/claude-opus-4-6")) {
		return "factory-openai/claude-opus-4-6:xhigh";
	}
	return "factory-openai/gpt-5.4:xhigh";
}

function selectAnthropicMainModel(availableModelIds: Set<string>): string {
	if (availableModelIds.has("factory-openai/claude-opus-4-6")) {
		return "factory-openai/claude-opus-4-6:xhigh";
	}
	return selectAnthropicAgentModel(availableModelIds);
}

function readSettingsSnapshot(settingsPath: string): SettingsSnapshot {
	if (!existsSync(settingsPath)) {
		return {};
	}
	const parsed = readJsonFile(settingsPath);
	if (!isRecord(parsed)) {
		return {};
	}
	const snapshot: SettingsSnapshot = {};
	const defaultProvider = pickString(parsed.defaultProvider);
	const defaultModel = pickString(parsed.defaultModel);
	const defaultThinkingLevel = pickString(parsed.defaultThinkingLevel);
	if (defaultProvider) {
		snapshot.defaultProvider = defaultProvider;
	}
	if (defaultModel) {
		snapshot.defaultModel = defaultModel;
	}
	if (
		defaultThinkingLevel === "off" ||
		defaultThinkingLevel === "minimal" ||
		defaultThinkingLevel === "low" ||
		defaultThinkingLevel === "medium" ||
		defaultThinkingLevel === "high" ||
		defaultThinkingLevel === "xhigh"
	) {
		snapshot.defaultThinkingLevel = defaultThinkingLevel;
	}
	if (isStringArray(parsed.enabledModels)) {
		snapshot.enabledModels = [...parsed.enabledModels];
	}
	return snapshot;
}

export function parseModelRef(ref: string): ParsedModelRef {
	const trimmed = ref.trim();
	const match = trimmed.match(MODEL_REF_PATTERN);
	if (!match?.groups?.provider || !match.groups.modelId) {
		throw new Error(`Invalid model reference "${ref}". Expected provider/model or provider/model:thinking.`);
	}
	const provider = match.groups.provider;
	const modelId = match.groups.modelId;
	const thinking = match.groups.thinking;
	const thinkingLevel =
		thinking === "off" ||
		thinking === "minimal" ||
		thinking === "low" ||
		thinking === "medium" ||
		thinking === "high" ||
		thinking === "xhigh"
			? thinking
			: null;
	return {
		provider,
		modelId,
		thinkingLevel,
		fullId: `${provider}/${modelId}`,
		normalizedRef: thinkingLevel ? `${provider}/${modelId}:${thinkingLevel}` : `${provider}/${modelId}`,
	};
}

function replaceFrontmatterLine(lines: string[], key: string, value: string, insertAfter?: string): string[] {
	const nextLine = `${key}: ${value}`;
	const linePrefix = `${key}:`;
	const existingIndex = lines.findIndex((line) => line.startsWith(linePrefix));
	if (existingIndex >= 0) {
		const updated = [...lines];
		updated[existingIndex] = nextLine;
		return updated;
	}
	if (insertAfter) {
		const insertIndex = lines.findIndex((line) => line.startsWith(`${insertAfter}:`));
		if (insertIndex >= 0) {
			return [...lines.slice(0, insertIndex + 1), nextLine, ...lines.slice(insertIndex + 1)];
		}
	}
	return [...lines, nextLine];
}

export function updateAgentProfileContent(content: string, config: AgentProfileModel): string {
	const normalized = normalizeNewlines(content);
	if (!normalized.startsWith("---\n")) {
		throw new Error("Agent file is missing frontmatter.");
	}
	const endIndex = normalized.indexOf("\n---", 4);
	if (endIndex === -1) {
		throw new Error("Agent file has invalid frontmatter.");
	}
	const frontmatter = normalized.slice(4, endIndex);
	const rest = normalized.slice(endIndex + 4);
	let lines = frontmatter.split("\n");
	lines = replaceFrontmatterLine(lines, "model", config.model);
	lines = replaceFrontmatterLine(lines, "fallback-model", config.fallbackModel ?? config.model, "model");
	return `---\n${lines.join("\n")}\n---${rest}`;
}

export function readCurrentAgentModels(agentsDir: string): Record<string, AgentProfileModel> {
	const entries = readdirSync(agentsDir, { withFileTypes: true });
	const result: Record<string, AgentProfileModel> = {};

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}

		const filePath = join(agentsDir, entry.name);
		const content = readFileSync(filePath, "utf-8");
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		const frontmatter = parsed.frontmatter;
		const name = pickString(frontmatter.name) ?? entry.name.replace(/\.md$/, "");
		const model = pickString(frontmatter.model);
		const fallbackModel = pickString(frontmatter["fallback-model"]);

		if (!model) {
			continue;
		}

		result[name] = {
			model,
			fallbackModel: fallbackModel ?? model,
		};
	}

	return result;
}

export function buildCurrentProfile(agentDir: string): ProfileDefinition {
	const settings = readSettingsSnapshot(join(agentDir, "settings.json"));
	const mainModel =
		settings.defaultProvider && settings.defaultModel
			? buildModelRef(settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel)
			: "factory-openai/gpt-5.4:xhigh";
	const availableModelIds = new Set(settings.enabledModels ?? []);
	const fallbackTargets = dedupe(
		[
			parseModelRef(mainModel).fullId,
			availableModelIds.has("factory-openai/gpt-5.4-mini") ? "factory-openai/gpt-5.4-mini" : "",
			availableModelIds.has("factory-openai/gpt-5.3-codex-spark") ? "factory-openai/gpt-5.3-codex-spark" : "",
			availableModelIds.has("factory-openai/claude-opus-4-6") ? "factory-openai/claude-opus-4-6" : "",
		].filter(Boolean),
	);

	return {
		main: {
			model: mainModel,
		},
		enabledModels: settings.enabledModels ? [...settings.enabledModels] : undefined,
		fallbackTargets: fallbackTargets.length > 0 ? fallbackTargets : [parseModelRef(mainModel).fullId],
		agents: readCurrentAgentModels(join(agentDir, "agents")),
	};
}

export function buildDefaultProfilesConfig(
	agentDir: string,
	availableModelIds: Set<string>,
	currentProfileName: string = "openai",
): ProfilesConfig {
	const currentProfile = buildCurrentProfile(agentDir);
	const anthropicAgentModel = selectAnthropicAgentModel(availableModelIds);
	const anthropicMainModel = selectAnthropicMainModel(availableModelIds);
	const anthropicAgentNames = Object.keys(currentProfile.agents);
	const anthropicAgents: Record<string, AgentProfileModel> = {};

	for (const agentName of anthropicAgentNames) {
		anthropicAgents[agentName] = {
			model: anthropicAgentModel,
			fallbackModel: anthropicAgentModel,
		};
	}

	const anthropicEnabledModels = dedupe(
		[parseModelRef(anthropicMainModel).fullId, parseModelRef(anthropicAgentModel).fullId].filter(Boolean),
	);
	const anthropicFallbackTargets = dedupe(
		[
			parseModelRef(anthropicMainModel).fullId,
			availableModelIds.has("factory-openai/gpt-5.4") ? "factory-openai/gpt-5.4" : "",
			availableModelIds.has("factory-openai/gpt-5.4-mini") ? "factory-openai/gpt-5.4-mini" : "",
		].filter(Boolean),
	);

	return {
		activeProfile: currentProfileName,
		profiles: {
			[currentProfileName]: currentProfile,
			anthropic: {
				main: {
					model: anthropicMainModel,
				},
				enabledModels: anthropicEnabledModels,
				fallbackTargets: anthropicFallbackTargets,
				agents: anthropicAgents,
			},
		},
	};
}

function parseAgentProfileModel(value: unknown): AgentProfileModel | null {
	if (!isRecord(value)) {
		return null;
	}
	const model = pickString(value.model);
	if (!model) {
		return null;
	}
	const fallbackModel = pickString(value.fallbackModel);
	return {
		model,
		fallbackModel: fallbackModel ?? model,
	};
}

function parseProfileDefinition(value: unknown): ProfileDefinition | null {
	if (!isRecord(value) || !isRecord(value.main)) {
		return null;
	}
	const mainModel = pickString(value.main.model);
	if (!mainModel || !isRecord(value.agents)) {
		return null;
	}

	const agents: Record<string, AgentProfileModel> = {};
	for (const [agentName, agentValue] of Object.entries(value.agents)) {
		const parsedAgent = parseAgentProfileModel(agentValue);
		if (!parsedAgent) {
			return null;
		}
		agents[agentName] = parsedAgent;
	}

	const enabledModels = isStringArray(value.enabledModels) ? [...value.enabledModels] : undefined;
	const fallbackTargets = isStringArray(value.fallbackTargets) ? [...value.fallbackTargets] : undefined;

	return {
		main: {
			model: mainModel,
		},
		enabledModels,
		fallbackTargets,
		agents,
	};
}

export function loadProfilesConfig(path: string): ProfilesConfig {
	if (!existsSync(path)) {
		throw new Error(`Profiles file not found: ${path}`);
	}

	const parsed = readJsonFile(path);
	if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
		throw new Error(`Profiles file ${path} is missing a valid "profiles" object.`);
	}

	const profiles: Record<string, ProfileDefinition> = {};
	for (const [profileName, profileValue] of Object.entries(parsed.profiles)) {
		const profile = parseProfileDefinition(profileValue);
		if (!profile) {
			throw new Error(`Profile "${profileName}" in ${path} is invalid.`);
		}
		profiles[profileName] = profile;
	}

	const activeProfile = pickString(parsed.activeProfile);
	return {
		activeProfile,
		profiles,
	};
}

export function saveProfilesConfig(path: string, config: ProfilesConfig): void {
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function ensureProfilesConfig(path: string, availableModelIds: Set<string>): ProfilesConfig {
	if (existsSync(path)) {
		return loadProfilesConfig(path);
	}

	const config = buildDefaultProfilesConfig(getAgentDir(), availableModelIds);
	saveProfilesConfig(path, config);
	return config;
}
