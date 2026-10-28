import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { isRecord } from "./classifier-shared.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

/**
 * TypeSafe's native System One protocol. OpenRouter serves the same protocol,
 * so both providers use this API with different base URLs.
 *
 * TypeSafe takes images as `assets`. They are experimental and need the
 * `TypeSafe-Danger-Zone-Images` opt-in header; without it the API answers 400.
 * OpenRouter drops `assets` silently and takes images as `image_url` parts in the state instead.
 * Models behind a proxy that hides both the provider ID and the OpenRouter host must set
 * `compat.imageInput`.
 */
const transport: SystemOneTransport = {
	api: "typesafe-system-one",
	label: "System One API",
	// OpenRouter by provider ID, which survives baseUrl overrides, or by host, which covers regional endpoints.
	detectCompat: (model) =>
		model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")
			? { imageInput: "state-image-urls", sendImageOptInHeader: false }
			: { imageInput: "assets", sendImageOptInHeader: true },
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, ...request }),
	output: (body) => {
		if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
		return body;
	},
};

/** TypeSafe System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
