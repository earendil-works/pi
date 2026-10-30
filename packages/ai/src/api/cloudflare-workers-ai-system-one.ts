import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { isRecord } from "./classifier-shared.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

const LABEL = "Cloudflare Workers AI";

function cloudflareErrorMessage(errors: unknown): string {
	if (Array.isArray(errors)) {
		const messages = errors
			.map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : undefined))
			.filter((message): message is string => message !== undefined);
		if (messages.length > 0) return `${LABEL} error: ${messages.join("; ")}`;
	}
	return `${LABEL} request failed`;
}

/**
 * System One models on the Workers AI REST endpoint:
 * `POST /accounts/{account}/ai/run` with `{ model, input }`. The REST API wraps the model
 * output in Cloudflare's API envelope. Third-party models such as `typesafe/jev` add a run record:
 * `{ success, result: { state: "Completed", result: { answers, usage } } }`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 * Cloudflare-hosted models such as `@cf/cloudflare/clef` return the output directly:
 * `{ success, result: { model, answers, usage } }`.
 * https://developers.cloudflare.com/workers-ai/models/clef/
 *
 * Clef models take images as an `images` list of data URLs. TypeSafe's models take them as
 * System One `assets`, without TypeSafe's opt-in header. The catalog sets `compat.imageInput`;
 * the model ID check only covers models without it.
 */
const transport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	detectCompat: (model) => ({
		imageInput: model.id.startsWith("@cf/cloudflare/clef") ? "images" : "assets",
		sendImageOptInHeader: false,
	}),
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, input: request }),
	output: (body) => {
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
		const result = body.result;
		if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);
		if ("answers" in result) return result;
		if (result.state !== "Completed") {
			throw new Error(`${LABEL} run did not complete (state: ${String(result.state)})`);
		}
		if (!isRecord(result.result)) throw new Error(`${LABEL} returned an unexpected response`);
		return result.result;
	},
};

/** Cloudflare Workers AI System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
