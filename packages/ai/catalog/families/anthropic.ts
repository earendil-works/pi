// Anthropic Claude models: facts that hold on every host that serves them.
// Ids appear dashed (claude-opus-4-8), dotted (claude-opus-4.8), prefixed
// (anthropic/claude-opus-4.8), and dated (claude-opus-5-20260723).

import type { Model, ThinkingLevelMap } from "../../src/types.ts";
import { type ChatModel, mergeCompat, mergeThinking } from "../define.ts";

function stripPrefix(modelId: string): string {
	return modelId.toLowerCase().replace(/^~?anthropic\//, "");
}

/** Models that accept per-message `output_config` effort changes. */
export function supportsClaudeMidConvoEffort(modelId: string): boolean {
	const id = stripPrefix(modelId);
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)(?:-\d{8})?$/.test(id)
	);
}

// Claude models that accept `thinking: {type: "disabled"}` alongside per-message effort.
// Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject it.
// https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking
const DISABLED_THINKING_MODELS = new Set(["claude-opus-5", "claude-haiku-5-5", "claude-haiku-5.5"]);

/** Models that accept system messages and tool changes after the conversation starts. */
export function supportsClaudeMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)?(?:-\d{8})?$/.test(modelId)
	);
}

/** Enable per-message effort changes. Models that cannot disable thinking with it lose "off". */
export function enableClaudeMidConvoEffort(model: Model<"anthropic-messages">): void {
	mergeCompat(model, { supportsMidConvoEffort: true });
	if (!DISABLED_THINKING_MODELS.has(stripPrefix(model.id).replace(/-\d{8}$/, ""))) {
		mergeThinking(model, { off: null });
	}
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
	"sonnet-5-5",
	"sonnet-5.5",
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
export function applyClaudeFamilyRules(model: ChatModel): void {
	if (idIncludesAny(model.id, MAX_EFFORT_ONLY)) mergeThinking(model, { max: "max" });
	if (idIncludesAny(model.id, XHIGH_AND_MAX_EFFORT)) mergeThinking(model, { xhigh: "xhigh", max: "max" });
	if (model.id.includes("fable-5")) mergeThinking(model, { off: null, xhigh: "xhigh", max: "max" });
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
 * models.dev may list Opus 5.5, Sonnet 5.5, and Haiku 5.5 before their effort
 * metadata is complete. Haiku 5.5 accepts disabled thinking; Opus 5.5 and
 * Sonnet 5.5 reject it.
 */
export function claude55ThinkingLevels(modelId: string): ThinkingLevelMap {
	return {
		...(modelId.includes("haiku") ? {} : { off: null }),
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
}
