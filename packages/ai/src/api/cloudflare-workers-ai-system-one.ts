import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { classifySystemOne, isRecord, type SystemOneTransport } from "./system-one-shared.ts";

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
 */
const transport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
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
