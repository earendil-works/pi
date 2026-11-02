import type { ClassifierModel } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

export default defineProvider({
	id: "typesafe",
	classifiers: (ctx): ClassifierModel<"typesafe-system-one">[] => {
		const metadata = ctx.sources.modelsDevDecisions["typesafe/jev-latest"];
		if (!metadata || metadata.type !== "decision") {
			if (ctx.strict) throw new Error("models.dev did not return decision model typesafe/jev-latest");
			return [];
		}
		return [
			{
				type: "classifier",
				id: "jev-latest",
				name: metadata.name,
				api: "typesafe-system-one",
				provider: "typesafe",
				baseUrl: "https://api.typesafe.ai/v1/",
				// models.dev lists text input only, but the API accepts image assets as an experimental
				// feature behind an opt-in header, which the typesafe-system-one API sends.
				// https://github.com/typesafe-ai/typesafe-sdk-js (v0.7.0 changelog)
				input: ["text", "image"],
				// The canonical models.dev entry has no direct-provider pricing. System One reports token usage,
				// so classify() results carry token counts but price them at zero.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.limit?.context || 64000,
				compat: { imageInput: "assets", sendImageOptInHeader: true },
			},
		];
	},
});
