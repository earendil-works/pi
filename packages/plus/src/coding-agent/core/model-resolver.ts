/**
 * Wrapper for packages/coding-agent/src/core/model-resolver.ts.
 *
 * Pass-through except: after any model resolution, apply the plus policy —
 * PI_MAX_CONTEXT_TOKENS overrides model.contextWindow, and the resolved model is
 * published to the context-detection module (its window math needs maxTokens).
 */
export * from "../../../../coding-agent/src/core/model-resolver.ts";

import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type InitialModelResult,
	type ResolveCliModelResult,
	findInitialModel as upstreamFindInitialModel,
	resolveCliModel as upstreamResolveCliModel,
	restoreModelFromSession as upstreamRestoreModelFromSession,
} from "../../../../coding-agent/src/core/model-resolver.ts";
import { setCurrentModel } from "../../context/detection.ts";

function applyPlusModelPolicy(model: Model<any>): void {
	const override = process.env.PI_MAX_CONTEXT_TOKENS;
	if (override) {
		const parsed = Number.parseInt(override, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			model.contextWindow = parsed;
		}
	}
	setCurrentModel(model);
}

export function resolveCliModel(options: Parameters<typeof upstreamResolveCliModel>[0]): ResolveCliModelResult {
	const result = upstreamResolveCliModel(options);
	if (result.model) {
		applyPlusModelPolicy(result.model);
	}
	return result;
}

export async function findInitialModel(
	options: Parameters<typeof upstreamFindInitialModel>[0],
): Promise<InitialModelResult> {
	const result = await upstreamFindInitialModel(options);
	if (result.model) {
		applyPlusModelPolicy(result.model);
	}
	return result;
}

export async function restoreModelFromSession(
	...args: Parameters<typeof upstreamRestoreModelFromSession>
): Promise<{ model: Model<any> | undefined; fallbackMessage: string | undefined }> {
	const result = await upstreamRestoreModelFromSession(...args);
	if (result.model) {
		applyPlusModelPolicy(result.model);
	}
	return result;
}
