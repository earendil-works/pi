import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { runCapture, usesV2Cli } from "./cli.ts";
import { objectRecord } from "./json.ts";
import type { ModelCost, OpenCodeModelInfo } from "./types/models.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

export const DEFAULT_FREE_MODELS = [
	"opencode/mimo-v2.5-free",
	"opencode/nemotron-3.5-lightning-free",
	"opencode/ling-3.0-flash-fin-free",
	"opencode/big-pickle",
];

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const satisfies readonly ModelThinkingLevel[];

export function configuredModels(): string[] | undefined {
	const raw = process.env.OPENCODE_PI_MODELS?.trim();
	if (!raw) return undefined;
	return raw
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
	const [, id = model] = model.split(/\/(.*)/s);
	return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
	if (model.includes("big-pickle")) return 200_000;
	return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
	if (model.includes("big-pickle")) return 32_000;
	return DEFAULT_MAX_TOKENS;
}

function looksFree(model: string): boolean {
	return /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(model);
}

/** Read a non-negative finite cost figure; anything else means "unknown". */
function costFigure(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read the real per-model cost from verbose discovery metadata (#78).
 * Missing or malformed figures fall back to zero so a model is never
 * reported with an invented non-zero cost.
 */
export function parseModelCost(metadata: unknown): ModelCost {
	const value = metadata as {
		cost?: {
			input?: unknown;
			output?: unknown;
			cache?: { read?: unknown; write?: unknown };
		};
	} | null;
	const cost = value?.cost;
	return {
		input: costFigure(cost?.input) ?? 0,
		output: costFigure(cost?.output) ?? 0,
		cacheRead: costFigure(cost?.cache?.read) ?? 0,
		cacheWrite: costFigure(cost?.cache?.write) ?? 0,
	};
}

/**
 * Free models are identified by zero input and output cost in the discovery
 * metadata (#77). When a record carries no usable cost figures (older CLI
 * output), fall back to the legacy `-free` name pattern so paid models are
 * never misregistered as free.
 */
export function isFreeModel(model: { id: string; cost: ModelCost; costFromMetadata?: boolean }): boolean {
	if (model.cost.input !== 0 || model.cost.output !== 0) return false;
	if (model.costFromMetadata === true) return true;
	return looksFree(model.id);
}

/**
 * Discovery metadata carries a per-model status field (#79). Only `active`
 * models are registered; a missing status is treated as active so older CLI
 * output without the field keeps working.
 */
export function isActiveModel(status: unknown): boolean {
	if (status === undefined || status === null) return true;
	return String(status).trim().toLowerCase() === "active";
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

function fallbackModel(id: string): OpenCodeModelInfo {
	return {
		id,
		name: modelDisplayName(id),
		reasoning: false,
		image: false,
		contextWindow: contextWindowFor(id),
		maxTokens: maxTokensFor(id),
		cost: ZERO_COST,
	};
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function thinkingLevelMap(variants: unknown): ThinkingLevelMap {
	const map: ThinkingLevelMap = {};
	const names =
		typeof variants === "object" && variants !== null && !Array.isArray(variants)
			? new Set(Object.keys(variants))
			: new Set<string>();

	for (const level of THINKING_LEVELS) {
		if (level === "off") {
			if (names.has("off")) map.off = "off";
			else if (names.has("none")) map.off = "none";
			continue;
		}
		map[level] = names.has(level) ? level : null;
	}
	if (!names.has("xhigh") && names.has("max")) map.xhigh = "max";
	if (map.max === null && map.xhigh !== null && map.xhigh !== undefined) {
		// No native max variant: max falls back to the highest available variant.
		// (getSupportedThinkingLevels requires an explicit entry for max/ultra.)
		map.max = map.xhigh;
	}
	if (map.ultra === null) {
		// Ultra aliases the highest available effort; higher token budgets apply
		// only where the provider honors thinkingBudgets (not via this CLI).
		const highest = names.has("max") ? "max" : names.has("xhigh") ? "xhigh" : names.has("high") ? "high" : null;
		if (highest) map.ultra = highest;
	}
	return map;
}

export function reasoningCliArgs(requestedReasoning: ModelThinkingLevel | undefined, map?: ThinkingLevelMap): string[] {
	// Capture blocks for recovery; --thinking controls CLI output, not model effort.
	const args = ["--thinking"];
	if (!requestedReasoning || requestedReasoning === "off") return args;
	const variant = map?.[requestedReasoning];
	if (typeof variant === "string" && variant.trim()) {
		args.push("--variant", variant);
	}
	return args;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return undefined;
}

/** Parse the `model-id` + pretty-printed JSON pairs from OpenCode verbose discovery. */
export function parseVerboseModels(output: string): OpenCodeModelInfo[] {
	const records = new Map<string, OpenCodeModelInfo>();
	const idPattern = /^opencode\/[^\s]+\s*$/gm;
	for (const match of output.matchAll(idPattern)) {
		const id = match[0].trim();
		const metadataStart = (match.index ?? 0) + match[0].length;
		const objectStart = output.indexOf("{", metadataStart);
		if (objectStart < 0) continue;

		const nextId = output.slice(metadataStart).search(/^opencode\/[^\s]+\s*$/m);
		if (nextId >= 0 && objectStart >= metadataStart + nextId) continue;
		const objectEnd = findJsonObjectEnd(output, objectStart);
		if (objectEnd === undefined) continue;

		let metadata: unknown;
		try {
			metadata = JSON.parse(output.slice(objectStart, objectEnd));
		} catch {
			continue;
		}
		if (typeof metadata !== "object" || metadata === null) continue;

		records.set(id, modelInfo(id, metadata));
	}
	return [...records.values()];
}

function modelInfo(id: string, metadata: unknown): OpenCodeModelInfo {
	const value = metadata as {
		name?: unknown;
		status?: unknown;
		cost?: {
			input?: unknown;
			output?: unknown;
			cache?: { read?: unknown; write?: unknown };
		};
		limit?: { context?: unknown; output?: unknown };
		capabilities?: { reasoning?: unknown; input?: { image?: unknown } };
		variants?: unknown;
	};
	const reasoning = value.capabilities?.reasoning === true;
	const cost = parseModelCost(value);
	const costFromMetadata = costFigure(value.cost?.input) !== undefined && costFigure(value.cost?.output) !== undefined;
	const status = typeof value.status === "string" && value.status.trim() ? value.status.trim() : undefined;
	return {
		id,
		name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : modelDisplayName(id),
		reasoning,
		image: value.capabilities?.input?.image === true,
		contextWindow: positiveNumber(value.limit?.context, contextWindowFor(id)),
		maxTokens: positiveNumber(value.limit?.output, maxTokensFor(id)),
		cost,
		...(costFromMetadata ? { costFromMetadata: true as const } : {}),
		...(status !== undefined ? { status } : {}),
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(value.variants) } : {}),
	};
}

/** V2 exposes model metadata through its local API, not `models --verbose`. */
function parseV2Models(output: string): OpenCodeModelInfo[] {
	const data = objectRecord(JSON.parse(output))?.data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((entry) => {
		const value = objectRecord(entry);
		if (
			value?.providerID !== "opencode" ||
			typeof value.id !== "string" ||
			!value.id.trim() ||
			/[\s/#]/.test(value.id) ||
			value.enabled === false
		)
			return [];
		const capabilities = objectRecord(value.capabilities);
		const variants = Array.isArray(value.variants)
			? value.variants.flatMap((v) => (typeof objectRecord(v)?.id === "string" ? [String(v.id)] : []))
			: [];
		const costs = Array.isArray(value.cost) ? value.cost : [];
		// Any paid tier makes automatic selection unsafe, even when the base tier is free.
		if (
			costs.some(
				(c) =>
					costFigure(objectRecord(c)?.input) === undefined || costFigure(objectRecord(c)?.output) === undefined,
			)
		)
			return [];
		const cost = costs.length
			? {
					input: Math.max(...costs.map((c) => c.input)),
					output: Math.max(...costs.map((c) => c.output)),
					cache: {
						read: Math.max(...costs.map((c) => costFigure(objectRecord(c.cache)?.read) ?? 0)),
						write: Math.max(...costs.map((c) => costFigure(objectRecord(c.cache)?.write) ?? 0)),
					},
				}
			: undefined;
		return [
			modelInfo(`opencode/${value.id}`, {
				...value,
				cost,
				capabilities: {
					reasoning: variants.length > 0 || typeof objectRecord(value.compatibility)?.reasoningField === "string",
					input: { image: Array.isArray(capabilities?.input) && capabilities.input.includes("image") },
				},
				variants: Object.fromEntries(variants.map((id) => [id, {}])),
			}),
		];
	});
}

export async function discoverModels(opts?: { forceDiscovery?: boolean }): Promise<{
	models: OpenCodeModelInfo[];
	time: number;
	error: string | undefined;
}> {
	const configured = configuredModels();
	// An explicit OPENCODE_PI_MODELS list already tells us exactly which
	// models to register, so the fast (non-forced) path skips spawning
	// opencode entirely rather than making explicitly configured users pay a
	// discovery timeout on every startup when the binary is missing or slow.
	// `forceDiscovery` (used by the user-initiated /pi-opencode-cli-bridge update
	// command) still runs discovery so configured models can be enriched with
	// real capability metadata (reasoning/image/limits) on request.
	if (configured?.length && !opts?.forceDiscovery) {
		return {
			models: dedupe(configured).map(fallbackModel),
			time: Date.now(),
			error: undefined,
		};
	}

	try {
		const v2 = await usesV2Cli();
		const result = await runCapture(
			v2 ? ["api", "--standalone", "get", "/api/model"] : ["models", "opencode", "--verbose"],
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `opencode models exited with code ${result.code}`);
		}

		const metadata = v2 ? parseV2Models(result.stdout) : parseVerboseModels(result.stdout);
		if (metadata.length === 0) {
			throw new Error("opencode model discovery returned no metadata");
		}
		const byId = new Map(metadata.map((model) => [model.id, model]));
		const selected = configured?.length
			? dedupe(configured).map((id) => byId.get(id) ?? fallbackModel(id))
			: metadata.filter((model) => isActiveModel(model.status) && isFreeModel(model));
		if (selected.length === 0) {
			throw new Error("opencode model discovery returned no free models");
		}

		return { models: selected, time: Date.now(), error: undefined };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const fallbackIds = configured?.length ? dedupe(configured) : DEFAULT_FREE_MODELS;
		return {
			models: fallbackIds.map(fallbackModel),
			time: Date.now(),
			error: message,
		};
	}
}
