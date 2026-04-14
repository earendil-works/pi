/**
 * Model Fallback Extension
 *
 * When the primary model fails (rate limit, 429, 503, API error),
 * automatically switches to a fallback model and retries.
 * Switches back to the primary model on next user message.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const FALLBACK_MARKER = "[model-fallback]";
const DEFAULT_FALLBACK_TARGETS = [
	{ provider: "factory-openai", modelId: "gpt-5.4" },
] as const;

// Error patterns that indicate the model is temporarily unavailable
const RETRYABLE_PATTERNS = [
	/rate.?limit/i,
	/429/,
	/503/,
	/overloaded/i,
	/capacity/i,
	/too many requests/i,
	/quota/i,
	/temporarily unavailable/i,
	/server error/i,
	/timeout/i,
	/ECONNREFUSED/,
	/ECONNRESET/,
	/ETIMEDOUT/,
];

function isRetryableError(errorMessage: string): boolean {
	return RETRYABLE_PATTERNS.some((p) => p.test(errorMessage));
}

function parseModelRef(ref: string): { provider: string; modelId: string } | null {
	const trimmed = ref.trim();
	const match = trimmed.match(
		/^(?<provider>[^/]+)\/(?<modelId>.+?)(?::(?:off|minimal|low|medium|high|xhigh))?$/,
	);
	if (!match?.groups?.provider || !match.groups.modelId) {
		return null;
	}
	return {
		provider: match.groups.provider,
		modelId: match.groups.modelId,
	};
}

function loadFallbackTargets(): Array<{ provider: string; modelId: string }> {
	const profilesPath = join(getAgentDir(), "profiles.json");
	if (!existsSync(profilesPath)) {
		return [...DEFAULT_FALLBACK_TARGETS];
	}

	try {
		const parsed = JSON.parse(readFileSync(profilesPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return [...DEFAULT_FALLBACK_TARGETS];
		}
		const activeProfile =
			typeof parsed.activeProfile === "string" && parsed.activeProfile.trim() ? parsed.activeProfile.trim() : null;
		const profiles =
			typeof parsed.profiles === "object" && parsed.profiles !== null && !Array.isArray(parsed.profiles)
				? parsed.profiles
				: null;
		if (!activeProfile || !profiles) {
			return [...DEFAULT_FALLBACK_TARGETS];
		}
		const profile = profiles[activeProfile];
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
			return [...DEFAULT_FALLBACK_TARGETS];
		}
		const fallbackTargets = Array.isArray(profile.fallbackTargets) ? profile.fallbackTargets : [];
		const parsedTargets = fallbackTargets
			.map((value) => (typeof value === "string" ? parseModelRef(value) : null))
			.filter((value): value is { provider: string; modelId: string } => value !== null);
		return parsedTargets.length > 0 ? parsedTargets : [...DEFAULT_FALLBACK_TARGETS];
	} catch {
		return [...DEFAULT_FALLBACK_TARGETS];
	}
}

export default function (pi: ExtensionAPI) {
	let primaryProvider: string | null = null;
	let primaryModelId: string | null = null;
	let isOnFallback = false;
	let activeFallback: { provider: string; modelId: string } | null = null;

	pi.registerCommand("fallback", {
		description: "Show model fallback status",
		handler: async (_args, ctx) => {
			const current = ctx.model;
			const fallbackTargets = loadFallbackTargets();
			const configured = fallbackTargets.map((target) => `${target.provider}/${target.modelId}`).join(" -> ");
			const active = activeFallback ? `${activeFallback.provider}/${activeFallback.modelId}` : "none";
			const status = isOnFallback ? `ON FALLBACK → ${active}` : "on primary";
			const primary = primaryProvider ? `${primaryProvider}/${primaryModelId}` : "not set yet";
			ctx.ui.notify(`${status} | Primary: ${primary} | Current: ${current?.provider}/${current?.id} | Config: ${configured}`, "info");
		},
	});

	// Track the primary model (ignore our own fallback switches)
	pi.on("model_select", (event) => {
		if (isOnFallback) return;
		primaryProvider = event.model.provider;
		primaryModelId = event.model.id;
	});

	// On new user input, try to switch back to primary
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isOnFallback || !primaryProvider || !primaryModelId) return;

		const fallbackModel = ctx.modelRegistry.find(primaryProvider, primaryModelId);
		if (fallbackModel) {
			const success = await pi.setModel(fallbackModel);
			if (success) {
				ctx.ui.notify(`Restored primary model: ${primaryProvider}/${primaryModelId}`, "info");
			}
		}

		isOnFallback = false;
		activeFallback = null;
	});

	// Detect provider errors and switch to fallback
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if (msg.stopReason !== "error") return;
		if (isOnFallback) return; // don't cascade fallbacks

		const errorText = msg.errorMessage || "";
		if (!isRetryableError(errorText)) return;

		// Save primary model
		if (ctx.model && !isOnFallback) {
			primaryProvider = ctx.model.provider;
			primaryModelId = ctx.model.id;
		}

		// Find and switch to the first available fallback that isn't the current model.
		const fallbackTargets = loadFallbackTargets();
		let selectedFallback: { provider: string; modelId: string } | null = null;
		let fallbackModel: ReturnType<typeof ctx.modelRegistry.find> | null = null;
		for (const target of fallbackTargets) {
			if (ctx.model?.provider === target.provider && ctx.model?.id === target.modelId) continue;
			const model = ctx.modelRegistry.find(target.provider, target.modelId);
			if (!model) continue;
			selectedFallback = { provider: target.provider, modelId: target.modelId };
			fallbackModel = model;
			break;
		}

		if (!selectedFallback || !fallbackModel) {
			const fallbackList = fallbackTargets.map((target) => `${target.provider}/${target.modelId}`).join(", ");
			ctx.ui.notify(`Fallback models not found (${fallbackList}). Cannot auto-switch.`, "warning");
			return;
		}

		const success = await pi.setModel(fallbackModel);
		if (!success) {
			ctx.ui.notify(`Failed to switch to fallback model (no API key?).`, "warning");
			return;
		}

		isOnFallback = true;
		activeFallback = selectedFallback;
		ctx.ui.notify(
			`${primaryProvider}/${primaryModelId} error: ${errorText}. Switched to ${selectedFallback.provider}/${selectedFallback.modelId}. Will restore on next message.`,
			"warning",
		);

		// Retry the failed message
		pi.sendUserMessage(`${FALLBACK_MARKER} The previous model failed. Continue with the task using the fallback model.`, { deliverAs: "followUp" });
	});
}
