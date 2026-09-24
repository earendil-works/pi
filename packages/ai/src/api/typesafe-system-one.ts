import type { ClassifierFunction, ClassifierOptions } from "../types.ts";
import { classifySystemOne, isRecord, type SystemOneTransport } from "./system-one-shared.ts";

/**
 * TypeSafe's native System One protocol. OpenRouter serves the same protocol,
 * so both providers use this API with different base URLs.
 */
const transport: SystemOneTransport = {
	api: "typesafe-system-one",
	label: "System One API",
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, ...request }),
	answers: (body) => {
		if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
		return body.answers;
	},
};

/** TypeSafe System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
