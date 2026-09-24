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
 * `POST /accounts/{account}/ai/run` with `{ model, input }`. The REST API
 * wraps the model output in Cloudflare's API envelope and a run record:
 * `{ success, result: { state: "Completed", result: { answers, usage } } }`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 */
const transport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, input: request }),
	answers: (body) => {
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
		const run = body.result;
		if (!isRecord(run)) throw new Error(`${LABEL} returned an unexpected response`);
		if (run.state !== "Completed") {
			throw new Error(`${LABEL} run did not complete (state: ${String(run.state)})`);
		}
		if (!isRecord(run.result)) throw new Error(`${LABEL} returned an unexpected response`);
		return run.result.answers;
	},
};

/** Cloudflare Workers AI System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
