import type { Model } from "@earendil-works/pi-ai";

/**
 * Controls how a model is labeled in the footer status and `/model` selector.
 * - "id": always show the model's `id` (the value passed to the provider API).
 * - "name": always show the model's human-readable `name`.
 * - "auto" (default): show `name` when the `id` is opaque (e.g. a Bedrock
 *   application inference profile ARN), otherwise show `id`.
 */
export type ModelDisplayMode = "id" | "name" | "auto";

export const DEFAULT_MODEL_DISPLAY_MODE: ModelDisplayMode = "auto";

/**
 * Matches Amazon Bedrock inference profile ARNs, e.g.
 * `arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123`
 * or `arn:aws:bedrock:us-east-1:123456789012:inference-profile/xyz`.
 * These IDs carry no human-readable model information, so we prefer `name`.
 */
const BEDROCK_INFERENCE_PROFILE_ARN =
	/^arn:aws[a-z-]*:bedrock:[^:]*:[0-9]*:(?:application-)?inference-profile\//i;

/**
 * Returns true when the model's `id` is an opaque identifier that does not tell
 * the user which model it actually is (currently: Bedrock inference profile ARNs).
 */
export function isOpaqueModelId(id: string): boolean {
	return BEDROCK_INFERENCE_PROFILE_ARN.test(id);
}

/**
 * Picks the label to display for a model given the configured display mode.
 * Falls back to `id` when a `name` is unavailable.
 */
export function getModelDisplayLabel(
	model: Pick<Model<any>, "id" | "name">,
	mode: ModelDisplayMode = DEFAULT_MODEL_DISPLAY_MODE,
): string {
	const name = model.name?.trim();
	switch (mode) {
		case "name":
			return name || model.id;
		case "id":
			return model.id;
		default:
			// "auto": prefer name only when the id is opaque.
			return name && isOpaqueModelId(model.id) ? name : model.id;
	}
}
