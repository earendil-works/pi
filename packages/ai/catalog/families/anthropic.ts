// Anthropic Claude models: facts that hold on every host that serves them.
// Ids appear dashed (claude-opus-4-8), dotted (claude-opus-4.8), prefixed
// (anthropic/claude-opus-4.8), and dated (claude-opus-5-20260723).

import type { Model, ThinkingLevelMap } from "../../src/types.ts";
import { type ChatModel, mergeCompat, mergeThinking, type ProviderContext } from "../define.ts";

function stripPrefix(modelId: string): string {
	return modelId.toLowerCase().replace(/^~?anthropic\//, "");
}

/** Models that accept per-message `output_config` effort changes. */
export function supportsClaudeMidConvoEffort(modelId: string): boolean {
	const id = stripPrefix(modelId);
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5[.-][12](?:-\d{8})?$/.test(id)
	);
}

/** Models that accept system messages and tool changes after the conversation starts. */
export function supportsClaudeMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-][12])?(?:-\d{8})?$/.test(modelId)
	);
}

/** Enable per-message effort changes. */
export function enableClaudeMidConvoEffort(model: Model<"anthropic-messages">): void {
	mergeCompat(model, { supportsMidConvoEffort: true });
}

function idIncludesAny(modelId: string, fragments: readonly string[]): boolean {
	return fragments.some((fragment) => modelId.includes(fragment));
}

const ADAPTIVE_THINKING = [
	"opus-4-6",
	"opus-4.6",
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"opus.5",
	"sonnet-4-6",
	"sonnet-4.6",
	"sonnet-5",
	"sonnet.5",
	"haiku-5",
	"haiku.5",
	"fable-5",
	"mythos-5",
];
/**
 * OpenRouter's `~anthropic/claude-*-latest` aliases follow the newest model of each family,
 * all of which use adaptive thinking.
 */
function isClaudeLatestAlias(modelId: string): boolean {
	return /^~anthropic\/claude-[a-z]+-latest$/.test(modelId);
}

const TEMPERATURE_UNSUPPORTED = [
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"opus.5",
	"sonnet-5",
	"sonnet.5",
	"haiku-5-5",
	"haiku-5.5",
];
const MAX_EFFORT_ONLY = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"];
const XHIGH_AND_MAX_EFFORT = [
	"opus-4-7",
	"opus-4.7",
	"opus-4-8",
	"opus-4.8",
	"opus-5",
	"opus.5",
	"sonnet-5",
	"sonnet.5",
	"haiku-5",
	"haiku.5",
];

/**
 * Adaptive thinking effort levels (per Anthropic adaptive thinking docs):
 * "max" is available on all adaptive-thinking Claude models; "xhigh" only on
 * Opus 4.7/4.8/5, Sonnet 5, Haiku 5.5, and Fable 5.
 */
export function applyClaudeFamilyRules(model: ChatModel, ctx: ProviderContext): void {
	if (idIncludesAny(model.id, MAX_EFFORT_ONLY)) mergeThinking(model, { max: "max" });
	if (idIncludesAny(model.id, XHIGH_AND_MAX_EFFORT)) mergeThinking(model, { xhigh: "xhigh", max: "max" });
	if (model.id.includes("fable-5")) mergeThinking(model, { xhigh: "xhigh", max: "max" });
	if (cannotTurnThinkingOff(model, ctx)) mergeThinking(model, { off: null });
	if (model.api !== "anthropic-messages") return;
	const messagesModel = model as Model<"anthropic-messages">;
	if (isClaudeLatestAlias(model.id) || idIncludesAny(model.id, ADAPTIVE_THINKING)) {
		mergeCompat(messagesModel, { forceAdaptiveThinking: true });
	}
	if (idIncludesAny(model.id.toLowerCase(), TEMPERATURE_UNSUPPORTED)) {
		mergeCompat(messagesModel, { supportsTemperature: false });
	}
}

/**
 * Whether Anthropic's own models.dev entry for this Claude model lacks a thinking toggle. Such
 * models reject `thinking: {type: "disabled"}` on every host (Opus 5.5, Sonnet 5.5, Fable 5.x),
 * while hosts other than Anthropic and Bedrock often omit the toggle (#12429). Other hosts' ids
 * are matched through models.dev's `canonical_id`, or for hosts not built from models.dev, through
 * their spelling of Anthropic's id: dotted, `anthropic/`-prefixed, with `-batch`/`-fast` variants.
 */
function cannotTurnThinkingOff(model: ChatModel, ctx: ProviderContext): boolean {
	const canonicalId = ctx.modelsDevSource(model)?.canonicalId ?? `anthropic/${anthropicModelId(model.id)}`;
	if (!canonicalId.startsWith("anthropic/")) return false;
	const reasoning =
		ctx.sources.modelsDev.anthropic?.models?.[canonicalId.slice("anthropic/".length)]?.capabilities.reasoning;
	return reasoning?.supported === true && reasoning.toggle !== true;
}

function anthropicModelId(modelId: string): string {
	return stripPrefix(modelId)
		.replace(/[-:](?:batch|fast)$/, "")
		.replace(/(\d)\.(\d)/g, "$1-$2");
}

/** models.dev may list Opus 5.5, Sonnet 5.5, and Haiku 5.5 before their effort metadata is complete. */
export const CLAUDE_55_THINKING_LEVELS: ThinkingLevelMap = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
