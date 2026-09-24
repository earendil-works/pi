import { describe, expect, it, vi } from "vitest";
import { createModels } from "../src/models.ts";
import { getBuiltinClassifierModel } from "../src/providers/all.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import type { ClassifierContext } from "../src/types.ts";

const context: ClassifierContext = {
	state: { message: "Help! My payouts have been failing for 3 days." },
	questions: {
		is_urgent: {
			type: "bool",
			instructions: "Does this convey urgency?",
			criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
		},
		department: {
			type: "choice",
			instructions: "Which team should handle this?",
			criteria: { billing: "Payments", technical: "Bugs" },
		},
	},
};

// Model output from https://developers.cloudflare.com/ai/models/typesafe/jev/
const jevOutput = {
	model: "jev-1.13.0",
	answers: {
		is_urgent: { type: "noul", noul: 0.95 },
		department: {
			type: "choice",
			choice: "billing",
			confidence: 0.8,
			probabilities: { billing: 0.87, technical: 0.13 },
		},
	},
	usage: { input_tokens: 426, output_tokens: 73 },
};

// REST envelope observed from the live /ai/run endpoint.
function restResponse(state: string, result: unknown = jevOutput) {
	return {
		result: { state, result, gatewayMetadata: { keySource: "Unified" } },
		success: true,
		errors: [],
		messages: [],
	};
}

function setup() {
	const models = createModels();
	models.setProvider(cloudflareWorkersAIProvider());
	const jev = models.getModelOfType("classifier", "cloudflare-workers-ai", "typesafe/jev");
	if (!jev) throw new Error("missing Cloudflare Jev model");
	return { models, jev };
}

const auth = { apiKey: "cf-key", env: { CLOUDFLARE_ACCOUNT_ID: "account-id" } };

describe("Cloudflare Workers AI System One", () => {
	it("exposes Jev only through classifier catalog accessors", () => {
		const { models, jev } = setup();
		expect(jev).toEqual(getBuiltinClassifierModel("cloudflare-workers-ai", "typesafe/jev"));
		expect(jev).toMatchObject({ type: "classifier", api: "cloudflare-workers-ai-system-one" });
		expect(models.getModel("cloudflare-workers-ai", "typesafe/jev")).toBeUndefined();
	});

	it("runs Jev through the account-scoped /ai/run endpoint", async () => {
		const { models, jev } = setup();
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body)) as {
				model: string;
				input: { state: unknown; questions: Record<string, { type: string }> };
			};
			expect(payload.model).toBe("typesafe/jev");
			expect(payload.input.state).toEqual(context.state);
			expect(payload.input.questions.is_urgent?.type).toBe("noul");
			expect(payload.input.questions.department?.type).toBe("choice");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cf-key");
			return Response.json(restResponse("Completed"));
		});

		const result = await models.classify(jev, context, { ...auth, fetch });

		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/ai/run");
		expect(result.stopReason).toBe("stop");
		expect(result.answers.is_urgent).toEqual({ type: "bool", probability: 0.95 });
		expect(result.answers.department).toMatchObject({ type: "choice", choice: "billing", confidence: 0.8 });
	});

	it("reports runs that did not complete", async () => {
		const { models, jev } = setup();
		const result = await models.classify(jev, context, {
			...auth,
			fetch: async () => Response.json(restResponse("Queued", null)),
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("run did not complete (state: Queued)");
	});

	it("reports Cloudflare envelope errors", async () => {
		const { models, jev } = setup();
		const result = await models.classify(jev, context, {
			...auth,
			fetch: async () =>
				Response.json({ success: false, errors: [{ code: 5007, message: "No such model" }], result: null }),
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cloudflare Workers AI error: No such model");
	});
});
