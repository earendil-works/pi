import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

describe("ModelRuntime classifiers", () => {
	it("lists Jev separately and classifies with runtime-resolved auth", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const jev = runtime.getModelOfType("classifier", "typesafe", "jev-latest")!;
		expect(jev.type).toBe("classifier");
		expect(runtime.getModel("typesafe", "jev-latest")).toBeUndefined();

		const unconfigured = await runtime.classify(jev, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");

		await runtime.setRuntimeApiKey("typesafe", "sk-typesafe");
		expect(await runtime.getAvailableOfType("classifier", "typesafe")).toEqual([jev]);
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-typesafe");
			return Response.json({ answers: { approved: { type: "noul", noul: 0.8 } } });
		});
		const result = await runtime.classify(jev, context, { fetch });
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});
});
