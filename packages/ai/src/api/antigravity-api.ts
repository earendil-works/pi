import type { AntigravityModel } from "../providers/antigravity.ts";
import type { Api, Model, ProviderStreams, TranscriptContext } from "../types.ts";
import { streamAntigravity } from "./antigravity/stream.ts";
import type { AntigravityStreamOptions } from "./antigravity/types.ts";
import { antigravityEnv } from "./antigravity/util.ts";

export type AntigravityOptions = AntigravityStreamOptions;
export function stream(model: Model<Api>, context: TranscriptContext, options?: AntigravityOptions) {
	const nativeModel = model as AntigravityModel;
	const route = nativeModel.antigravityRouting;
	const effort = options?.reasoning === "max" ? "xhigh" : options?.reasoning;
	const runtimeModel = route
		? !effort
			? (route.off ?? route.routing?.minimal ?? route.routing?.low ?? route.defaultRequestId)
			: (route.routing?.[effort] ??
				(effort === "xhigh" ? route.routing?.high : undefined) ??
				route.routing?.low ??
				route.routing?.minimal ??
				route.off ??
				route.defaultRequestId)
		: undefined;
	return streamAntigravity(model, context, {
		modelEnum: nativeModel.antigravityModelEnum,
		...options,
		runtimeModel: options?.runtimeModel || antigravityEnv("RUNTIME_MODEL", options?.env)?.trim() || runtimeModel,
	});
}
export const streamSimple = stream;

export function antigravityApi(): ProviderStreams {
	return { stream, streamSimple };
}
