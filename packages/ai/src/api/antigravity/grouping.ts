// Adapted from pi-antigravity 0.9.0 (MIT, Rahul Arya). See LICENSE.
import type { Model } from "../../types.ts";

type ProviderModelConfig = Omit<Model<"antigravity-api">, "api" | "provider" | "baseUrl">;

import { ThinkingEffort } from "./enums.ts";
import type { AntigravityRouting, ModelInfoRaw } from "./types.ts";

export type AntigravityCatalog = {
	models: ProviderModelConfig[];
	routing: Record<string, AntigravityRouting>;
	/** Public ids hidden with their static baseline: tagged "Leaving Soon" on every variant, or no longer listed. */
	retired?: string[];
};

type ThinkingLevel = ThinkingEffort;

type RuntimeGroup = {
	publicId: string;
	variants: Partial<Record<ThinkingLevel, string>>;
	unsuffixed?: string;
	displayNames: string[];
	/** Catalog capability: true/false when advertised, undefined when omitted. */
	supportsThinking?: boolean;
	supportsImages?: boolean;
	contextWindow?: number;
	maxTokens?: number;
};

const THINKING_SUFFIXES: Array<{ suffix: string; level: ThinkingLevel }> = [
	{ suffix: "extra-low", level: ThinkingEffort.Low },
	{ suffix: "extra-high", level: ThinkingEffort.Xhigh },
	{ suffix: "thinking", level: ThinkingEffort.High },
	{ suffix: "minimal", level: ThinkingEffort.Minimal },
	{ suffix: "medium", level: ThinkingEffort.Medium },
	{ suffix: "high", level: ThinkingEffort.High },
	{ suffix: "low", level: ThinkingEffort.Low },
];

const DISPLAY_LEVELS: Array<{ pattern: RegExp; level: ThinkingLevel }> = [
	{ pattern: /\(\s*extra\s*low\s*\)/i, level: ThinkingEffort.Low },
	{ pattern: /\(\s*extra\s*high\s*\)/i, level: ThinkingEffort.Xhigh },
	{ pattern: /\(\s*thinking\s*\)/i, level: ThinkingEffort.High },
	{ pattern: /\(\s*minimal\s*\)/i, level: ThinkingEffort.Minimal },
	{ pattern: /\(\s*medium\s*\)/i, level: ThinkingEffort.Medium },
	{ pattern: /\(\s*high\s*\)/i, level: ThinkingEffort.High },
	{ pattern: /\(\s*low\s*\)/i, level: ThinkingEffort.Low },
];

/** Known backend aliases whose runtime IDs do not share a thinking suffix with the public family. */
const RUNTIME_ALIASES: Record<string, { publicId: string; level: ThinkingLevel }> = {
	"gemini-3-flash-agent": { publicId: "gemini-3.5-flash", level: ThinkingEffort.High },
	"gemini-pro-agent": { publicId: "gemini-3.1-pro", level: ThinkingEffort.High },
};

const PI_LEVELS = [
	ThinkingEffort.Off,
	ThinkingEffort.Minimal,
	ThinkingEffort.Low,
	ThinkingEffort.Medium,
	ThinkingEffort.High,
	ThinkingEffort.Xhigh,
	"max",
] as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function isSelectableRuntimeModelId(id: string): boolean {
	if (!/^(gemini-|claude-|gpt-oss-|gemma-)/i.test(id) || /\s/.test(id) || /^MODEL_/i.test(id)) {
		return false;
	}
	if (/^(chat_|tab_)/i.test(id)) return false;
	if (/image/i.test(id)) return false;
	return true;
}

export function resolvedCatalog(
	discovered: AntigravityCatalog | undefined,
	current: AntigravityCatalog,
): AntigravityCatalog {
	if (discovered && discovered.models.length > 0) return discovered;
	return current;
}

export function buildAntigravityCatalog(
	rawModels: Record<string, ModelInfoRaw>,
	fallback: AntigravityCatalog,
): AntigravityCatalog {
	const groups = new Map<string, RuntimeGroup>();
	// Google tags models "Leaving Soon" before removal, and in practice they already 404 while
	// still listed (3.7/3.6 Flash and 3.1 Pro on 2026-10-17). A family is retired only when
	// every one of its runtime variants carries the tag.
	const leaving = new Set<string>();
	const staying = new Set<string>();
	const noteTag = (publicId: string, info: ModelInfoRaw | undefined) =>
		(typeof info?.tagTitle === "string" && /leaving\s*soon/i.test(info.tagTitle) ? leaving : staying).add(publicId);

	for (const [runtimeId, info] of Object.entries(rawModels)) {
		if (!isSelectableRuntimeModelId(runtimeId)) continue;
		if (info?.isInternal) continue;

		const displayName = modelDisplayName(info);
		if (runtimeId.endsWith("-tiered")) {
			const baseId = runtimeId.slice(0, -"-tiered".length);
			const group = ensureGroup(groups, baseId);
			absorbMetadata(group, info, displayName);
			noteTag(baseId, info);
			if (!group.unsuffixed) group.unsuffixed = runtimeId;
			continue;
		}

		const alias = RUNTIME_ALIASES[runtimeId];
		const suffix = alias ? undefined : parseThinkingSuffix(runtimeId);
		const publicId = alias?.publicId ?? suffix?.baseId ?? runtimeId;
		const group = ensureGroup(groups, publicId);
		absorbMetadata(group, info, displayName);
		noteTag(publicId, info);

		const level = alias?.level ?? levelFromDisplayName(displayName) ?? suffix?.level;
		if (level) group.variants[level] = runtimeId;
		else group.unsuffixed = runtimeId;
	}

	mergeAgentSingletons(groups);

	if (groups.size === 0) return fallback;

	// A static baseline family the live catalog no longer lists has been removed (3.7/3.6 Flash and
	// 3.1 Pro on 2026-10-25, after a week tagged Leaving Soon) and 404s, so it is retired too instead
	// of being re-added from the baseline. Aliases count as listed through their public family.
	const listed = new Set([...groups.keys()].filter((id) => staying.has(id)));
	const removed = fallback.models.map((model) => model.id).filter((id) => !listed.has(id) && !leaving.has(id));
	const retired = [...new Set([...[...leaving].filter((id) => !staying.has(id)), ...removed])].sort();
	for (const id of retired) groups.delete(id);
	if (groups.size === 0) return fallback;

	const models: ProviderModelConfig[] = [];
	const routing: Record<string, AntigravityRouting> = {};

	for (const group of groups.values()) {
		const fallbackModel = fallback.models.find((model) => model.id === group.publicId);
		const fallbackRouting = fallback.routing[group.publicId];
		if (fallbackModel && fallbackRouting) {
			models.push(fallbackModel);
			routing[group.publicId] = fallbackRouting;
			continue;
		}

		const synthesized = synthesizeModel(group, fallback.models);
		models.push(synthesized.model);
		routing[group.publicId] = synthesized.routing;
	}

	for (const fallbackModel of fallback.models) {
		if (routing[fallbackModel.id] || retired.includes(fallbackModel.id)) continue;
		const fallbackRouting = fallback.routing[fallbackModel.id] ?? {
			defaultRequestId: fallbackModel.id,
			off: fallbackModel.id,
			routing: { low: fallbackModel.id, high: fallbackModel.id },
		};
		models.push(fallbackModel);
		routing[fallbackModel.id] = fallbackRouting;
	}

	models.sort(comparePublicModels);
	return { models, routing, retired };
}

function ensureGroup(groups: Map<string, RuntimeGroup>, publicId: string): RuntimeGroup {
	const existing = groups.get(publicId);
	if (existing) return existing;
	const created: RuntimeGroup = {
		publicId,
		variants: {},
		displayNames: [],
	};
	groups.set(publicId, created);
	return created;
}

function absorbMetadata(group: RuntimeGroup, info: ModelInfoRaw | undefined, displayName: string | undefined): void {
	if (displayName) group.displayNames.push(displayName);
	if (info?.supportsThinking === true) group.supportsThinking = true;
	else if (info?.supportsThinking === false && group.supportsThinking !== true) {
		group.supportsThinking = false;
	}
	if (info?.supportsImages === true) group.supportsImages = true;
	if (info?.supportsImages === false && group.supportsImages === undefined) {
		group.supportsImages = false;
	}
	if (typeof info?.maxTokens === "number" && info.maxTokens > 0) {
		group.contextWindow = Math.max(group.contextWindow ?? 0, info.maxTokens);
	}
	if (typeof info?.maxOutputTokens === "number" && info.maxOutputTokens > 0) {
		group.maxTokens = Math.max(group.maxTokens ?? 0, info.maxOutputTokens);
	}
}

function mergeAgentSingletons(groups: Map<string, RuntimeGroup>): void {
	for (const [publicId, group] of [...groups.entries()]) {
		if (!publicId.endsWith("-agent")) continue;
		if (Object.keys(group.variants).length > 0) continue;
		const family = displayFamily(group.displayNames[0]);
		if (!family) continue;
		const target = [...groups.values()].find(
			(candidate) =>
				candidate.publicId !== publicId && candidate.displayNames.some((name) => displayFamily(name) === family),
		);
		if (!target || !group.unsuffixed) continue;
		const level = levelFromDisplayName(group.displayNames[0]) ?? ThinkingEffort.High;
		target.variants[level] = group.unsuffixed;
		absorbMetadata(target, { supportsThinking: group.supportsThinking }, group.displayNames[0]);
		groups.delete(publicId);
	}
}

function parseThinkingSuffix(runtimeId: string): { baseId: string; level: ThinkingLevel } | undefined {
	const lower = runtimeId.toLowerCase();
	for (const { suffix, level } of THINKING_SUFFIXES) {
		if (lower.endsWith(`-${suffix}`)) {
			return { baseId: runtimeId.slice(0, -(suffix.length + 1)), level };
		}
	}
	return undefined;
}

function levelFromDisplayName(displayName: string | undefined): ThinkingLevel | undefined {
	if (!displayName) return undefined;
	for (const { pattern, level } of DISPLAY_LEVELS) {
		if (pattern.test(displayName)) return level;
	}
	return undefined;
}

function modelDisplayName(info: ModelInfoRaw | undefined): string | undefined {
	if (!info) return undefined;
	if (typeof info.displayName === "string" && info.displayName) return info.displayName;
	if (typeof info.label === "string" && info.label) return info.label;
	if (typeof info.modelName === "string" && info.modelName) return info.modelName;
	return undefined;
}

function displayFamily(displayName: string | undefined): string | undefined {
	if (!displayName) return undefined;
	return displayName
		.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
		.trim()
		.toLowerCase();
}

function synthesizeModel(
	group: RuntimeGroup,
	fallbackModels: ProviderModelConfig[],
): { model: ProviderModelConfig; routing: AntigravityRouting } {
	const template = familyTemplate(group.publicId, fallbackModels);
	const advertisedLevels = advertisedThinkingLevels(group);
	const routing = routingFromVariants(group.publicId, group.variants, group.unsuffixed);
	const supportsImages = group.supportsImages ?? template?.input.includes("image") ?? true;
	const reasoning =
		advertisedLevels.size > 0 ||
		group.supportsThinking === true ||
		(group.supportsThinking === undefined && Boolean(template?.reasoning));
	return {
		model: {
			id: group.publicId,
			name: publicModelName(group),
			reasoning,
			thinkingLevelMap: reasoning ? thinkingLevelMapFromLevels(advertisedLevels) : undefined,
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: template?.cost ?? ZERO_COST,
			contextWindow: group.contextWindow ?? template?.contextWindow ?? 128000,
			maxTokens: group.maxTokens ?? template?.maxTokens ?? 8192,
		},
		routing,
	};
}

function advertisedThinkingLevels(group: RuntimeGroup): Set<string> {
	const levels = new Set(Object.keys(group.variants));
	if (levels.size > 0) return levels;
	// Explicit false from the catalog must not grow a fake High control.
	if (group.supportsThinking === false) return levels;
	if (group.supportsThinking === true || group.unsuffixed) {
		levels.add(ThinkingEffort.High);
	}
	return levels;
}

function routingFromVariants(
	publicId: string,
	variants: Partial<Record<ThinkingLevel, string>>,
	unsuffixed?: string,
): AntigravityRouting {
	const defaultRequestId =
		variants[ThinkingEffort.Low] ??
		variants[ThinkingEffort.Minimal] ??
		variants[ThinkingEffort.Medium] ??
		variants[ThinkingEffort.High] ??
		unsuffixed ??
		publicId;

	const pick = (...keys: ThinkingLevel[]): string => {
		for (const key of keys) {
			const id = variants[key];
			if (id) return id;
		}
		return unsuffixed ?? defaultRequestId;
	};

	return {
		off: pick(ThinkingEffort.Low, ThinkingEffort.Minimal, ThinkingEffort.Medium, ThinkingEffort.High),
		routing: {
			minimal: pick(ThinkingEffort.Minimal, ThinkingEffort.Low, ThinkingEffort.Medium, ThinkingEffort.High),
			low: pick(ThinkingEffort.Low, ThinkingEffort.Minimal, ThinkingEffort.Medium, ThinkingEffort.High),
			medium: pick(ThinkingEffort.Medium, ThinkingEffort.Low, ThinkingEffort.High, ThinkingEffort.Minimal),
			high: pick(ThinkingEffort.High, ThinkingEffort.Medium, ThinkingEffort.Low, ThinkingEffort.Minimal),
			xhigh: pick(ThinkingEffort.Xhigh, ThinkingEffort.High, ThinkingEffort.Medium, ThinkingEffort.Low),
		},
		defaultRequestId,
	};
}

function thinkingLevelMapFromLevels(levels: Set<string>): ProviderModelConfig["thinkingLevelMap"] {
	const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {};
	for (const level of PI_LEVELS) {
		map[level] = levels.has(level) ? level : null;
	}
	if (levels.size === 0) map.high = "high";
	return map;
}

function familyTemplate(publicId: string, fallbackModels: ProviderModelConfig[]): ProviderModelConfig | undefined {
	if (/^gemini-.*-flash/i.test(publicId)) {
		return fallbackModels.find((model) => /^gemini-.*-flash/i.test(model.id));
	}
	if (/^gemini-.*-(?:pro|argon)/i.test(publicId)) {
		return (
			fallbackModels.find((model) => model.id === publicId) ??
			fallbackModels.find((model) => /^gemini-.*-(?:pro|argon)/i.test(model.id))
		);
	}
	if (publicId.startsWith("claude-opus")) {
		return (
			fallbackModels.find((model) => model.id === publicId) ??
			fallbackModels.find((model) => model.id.startsWith("claude-opus"))
		);
	}
	if (publicId.startsWith("claude-")) {
		return (
			fallbackModels.find((model) => model.id === publicId) ??
			fallbackModels.find((model) => model.id.startsWith("claude-sonnet")) ??
			fallbackModels.find((model) => model.id.startsWith("claude-"))
		);
	}
	if (publicId.startsWith("gpt-oss")) {
		return fallbackModels.find((model) => model.id.startsWith("gpt-oss"));
	}
	if (publicId.startsWith("gemini-")) {
		return fallbackModels.find((model) => model.id.startsWith("gemini-"));
	}
	return undefined;
}

function publicModelName(group: RuntimeGroup): string {
	for (const name of group.displayNames) {
		const family = displayFamily(name);
		if (family && !isFamilyVersionMismatch(group.publicId, family)) {
			return `${titleCase(family)} (Antigravity)`;
		}
	}
	return `${humanizePublicId(group.publicId)} (Antigravity)`;
}

function extractBrand(s: string): string {
	if (s.startsWith("gpt-oss") || s.startsWith("gpt oss") || s.startsWith("gpt-") || s.startsWith("gpt ")) {
		return "gpt-oss";
	}
	const match = s.match(/^([a-z0-9]+)/);
	return match ? match[1] : "";
}

function extractGeminiTier(s: string): "flash-lite" | "flash" | "pro" | "ultra" | "argon" | undefined {
	if (/\bflash[- ]?lite\b/i.test(s)) return "flash-lite";
	if (/\bflash\b/i.test(s)) return "flash";
	if (/\bpro\b/i.test(s)) return "pro";
	if (/\bultra\b/i.test(s)) return "ultra";
	if (/\bargon\b/i.test(s)) return "argon";
	return undefined;
}

function extractClaudeTier(s: string): "opus" | "sonnet" | "haiku" | undefined {
	if (/\bopus\b/i.test(s)) return "opus";
	if (/\bsonnet\b/i.test(s)) return "sonnet";
	if (/\bhaiku\b/i.test(s)) return "haiku";
	return undefined;
}

export function isFamilyVersionMismatch(id: string, nameOrFamily: string): boolean {
	const cleanId = id.toLowerCase().trim();
	const cleanFamily = nameOrFamily.toLowerCase().trim();

	const brandId = extractBrand(cleanId);
	const brandFam = extractBrand(cleanFamily);
	if (brandId && brandFam && brandId !== brandFam) {
		return true;
	}

	if (brandId === "gemini" || brandFam === "gemini") {
		if (brandId !== brandFam) return true;
		const vId = parseGeminiVersion(cleanId);
		const vFam = parseGeminiVersion(cleanFamily);
		if (vId > 0 && vFam > 0 && vId !== vFam) return true;
		const tId = extractGeminiTier(cleanId);
		const tFam = extractGeminiTier(cleanFamily);
		if ((tId || tFam) && tId !== tFam) return true;
	}

	if (brandId === "claude" || brandFam === "claude") {
		if (brandId !== brandFam) return true;
		const vId = parseClaudeVersion(cleanId);
		const vFam = parseClaudeVersion(cleanFamily);
		if (vId > 0 && vFam > 0 && vId !== vFam) return true;
		const tId = extractClaudeTier(cleanId);
		const tFam = extractClaudeTier(cleanFamily);
		if ((tId || tFam) && tId !== tFam) return true;
	}

	if (brandId === "gpt-oss" || brandFam === "gpt-oss") {
		if (brandId !== brandFam) return true;
		const sId = cleanId.match(/(\d+)b/)?.[1];
		const sFam = cleanFamily.match(/(\d+)b/)?.[1];
		if (sId && sFam && sId !== sFam) return true;
	}

	if (brandId === "gemma" || brandFam === "gemma") {
		if (brandId !== brandFam) return true;
		const vId = cleanId.match(/gemma[- ]?(\d+)/)?.[1];
		const vFam = cleanFamily.match(/gemma[- ]?(\d+)/)?.[1];
		if (vId && vFam && vId !== vFam) return true;
	}

	return false;
}

function titleCase(value: string): string {
	let res = value.replace(/\b([a-z])/g, (char) => char.toUpperCase());
	res = res.replace(/\bgpt[- ]oss\b/gi, "GPT-OSS");
	res = res.replace(/(\d+)\s*b\b/gi, "$1B");
	return res;
}

export function humanizePublicId(id: string): string {
	const tokens = id.split("-");
	const words: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		const next = tokens[i + 1];
		if (token === "gpt" && next === "oss") {
			words.push("GPT-OSS");
			i++;
			continue;
		}
		if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
			words.push(`${token}.${next}`);
			i++;
			continue;
		}
		if (/^\d/.test(token)) {
			words.push(token.toUpperCase());
			continue;
		}
		words.push(token.charAt(0).toUpperCase() + token.slice(1));
	}
	return words.join(" ");
}

export function parseGeminiVersion(id: string): number {
	const match = id.match(/^gemini[- ](\d+)(?:[.-](\d+))?/i);
	if (!match) return 0;
	return Number(match[1]) * 1000 + Number(match[2] || 0);
}

export function comparePublicModels(a: ProviderModelConfig, b: ProviderModelConfig): number {
	const rankA = modelRank(a.id);
	const rankB = modelRank(b.id);
	if (rankA[0] !== rankB[0]) return rankA[0] - rankB[0];
	if (rankA[1] !== rankB[1]) return rankA[1] - rankB[1];
	return a.id.localeCompare(b.id);
}

export function parseClaudeVersion(id: string): number {
	const match = id.match(/^claude[- ](?:[a-z]+[- ])?(\d+)(?:[.-](\d+))?/i);
	if (!match) return 0;
	return Number(match[1]) * 1000 + Number(match[2] || 0);
}

function modelRank(id: string): [number, number] {
	const version = parseGeminiVersion(id);
	const claudeVer = parseClaudeVersion(id);
	if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, -version];
	if (id.startsWith("claude-opus")) return [1, -claudeVer];
	if (id.startsWith("claude-sonnet")) return [2, -claudeVer];
	if (id.startsWith("claude-")) return [3, -claudeVer];
	if (/^gemini-.*(?:pro|argon)/i.test(id)) return [4, -version];
	if (id.startsWith("gemini-")) return [5, -version];
	if (id.startsWith("gpt-oss")) return [6, 0];
	return [7, 0];
}
