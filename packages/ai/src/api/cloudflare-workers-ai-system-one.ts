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

/** Unwraps Cloudflare's API envelope: `{ success, errors, result }`. */
function apiResult(body: unknown): Record<string, unknown> {
	if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
	if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
	if (!isRecord(body.result)) throw new Error(`${LABEL} returned an unexpected response`);
	return body.result;
}

/**
 * Third-party System One models on the Workers AI REST endpoint:
 * `POST /accounts/{account}/ai/run` with `{ model, input }`. The REST API
 * wraps the model output in Cloudflare's API envelope and a run record:
 * `{ success, result: { state: "Completed", result: { answers, usage } } }`.
 * https://developers.cloudflare.com/ai/models/typesafe/jev/
 */
const runTransport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, input: request }),
	output: (body) => {
		const run = apiResult(body);
		if (run.state !== "Completed") {
			throw new Error(`${LABEL} run did not complete (state: ${String(run.state)})`);
		}
		if (!isRecord(run.result)) throw new Error(`${LABEL} returned an unexpected response`);
		return run.result;
	},
};

/**
 * Cloudflare-hosted System One models (`@cf/cloudflare/clef`):
 * `POST /accounts/{account}/ai/run/{model}` with the System One request as the body plus a
 * `model` selector (`clef`), the last ID segment. The output is wrapped only in the API envelope:
 * `{ success, result: { answers, usage } }`.
 * https://developers.cloudflare.com/workers-ai/models/clef/
 */
const hostedTransport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	url: (model) => new URL(`run/${model.id}`, `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id.slice(model.id.lastIndexOf("/") + 1), ...request }),
	output: apiResult,
};

/** Cloudflare Workers AI System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(model.id.startsWith("@cf/") ? hostedTransport : runTransport, model, context, options);
