import type { Api, Model } from "@kennyfrc/mu-ai";
import { isModelUsingOAuth } from "../model-config.js";
import { theme } from "../theme/theme.js";
import type { UsageFooterMode, UsageLimitsSnapshot } from "../usage-footer.js";

interface ComposerUsageLabelOptions {
	model: Model<Api> | null | undefined;
	totalCost: number;
	usageFooterMode: UsageFooterMode;
	usageLimits: UsageLimitsSnapshot | null;
	contextTokens: number;
	contextWindow: number;
}

export function isSubscriptionDisplayModel(model: Model<Api> | null | undefined): boolean {
	if (!model) return false;
	return model.provider === "synthetic" || isModelUsingOAuth(model);
}

export function formatComposerUsageLabel(options: ComposerUsageLabelOptions): string {
	const { model, totalCost, usageFooterMode, usageLimits, contextTokens, contextWindow } = options;
	const usingSubscription = isSubscriptionDisplayModel(model);
	const leadingParts: string[] = [];
	let contextPart: string | null = null;
	let primaryPart: string | null = null;
	let secondaryPart: string | null = null;

	if (model) {
		if (usingSubscription) {
			leadingParts.push("(sub)");
		} else {
			leadingParts.push(`$${totalCost.toFixed(3)} (api)`);
		}
	}

	if (contextWindow > 0) {
		const percent = Math.round((contextTokens / contextWindow) * 100);
		const windowK = Math.round(contextWindow / 1000);
		contextPart = `${percent}% of ${windowK}k`;
	}

	if (usageFooterMode === "visible" && usageLimits) {
		if (usageLimits.primary) {
			primaryPart = `${usageLimits.primary.label} ${Math.round(usageLimits.primary.percentRemaining)}%`;
		}
		if (usageLimits.secondary) {
			secondaryPart = `${usageLimits.secondary.label} ${Math.round(usageLimits.secondary.percentRemaining)}%`;
		}
	}

	let text = leadingParts.length > 0 ? theme.fg("muted", leadingParts.join(" ")) : "";

	if (contextPart) {
		text += (text ? " " : "") + theme.fg("muted", contextPart);
	}
	if (primaryPart) {
		text += `${theme.fg("muted", " • ")}${theme.fg("muted", primaryPart)}`;
	}
	if (secondaryPart) {
		text += `${theme.fg("muted", " • ")}${theme.fg("muted", secondaryPart)}`;
	}

	return text;
}
