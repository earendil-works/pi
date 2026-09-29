import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/api/typesafe-system-one.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "https://api.typesafe.ai/v1/",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64000,
};

const context: ClassifierContext = {
	state: { text: "The deployment succeeded, thank you." },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the message",
			criteria: { success: "Successful", failure: "Failed" },
		},
		satisfaction: {
			type: "score",
			instructions: "Score satisfaction",
			criteria: ["low", "neutral", "high"],
		},
		approved: {
			type: "bool",
			instructions: "Does the user approve?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const wireAnswers = {
	category: {
		type: "choice",
		choice: "success",
		probabilities: { success: 0.9, failure: 0.1 },
		confidence: 0.8,
	},
	satisfaction: { type: "score", score: 2, confidence: 0.7 },
	approved: { type: "noul", noul: 0.95 },
};

describe("TypeSafe System One", () => {
	it("maps public bool questions and answers to TypeSafe noul values", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body)) as {
				model: string;
				questions: Record<string, { type: string }>;
			};
			expect(payload.model).toBe("jev-latest");
			expect(payload.questions.category?.type).toBe("choice");
			expect(payload.questions.satisfaction?.type).toBe("score");
			expect(payload.questions.approved?.type).toBe("noul");
			// System One has no temperature field; the option is ignored.
			expect(payload).not.toHaveProperty("temperature");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
			return Response.json({ answers: wireAnswers });
		});

		const result = await classify(model, context, { apiKey: "secret", fetch, temperature: 1.5 });
		const pricedResult = await classify({ ...model, cost: { ...model.cost, input: 0.042 } }, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: wireAnswers, usage: { input_tokens: 308, output_tokens: 23 } }),
		});

		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.typesafe.ai/v1/systemone");
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.95 });
		expect(result.answers.category).toMatchObject({ type: "choice", choice: "success" });
		expect(result.answers.satisfaction).toEqual({ type: "score", score: 2, confidence: 0.7 });
		expect(result.usage).toBeUndefined();
		expect(pricedResult.usage).toMatchObject({ input: 308, output: 23, totalTokens: 331 });
		expect(pricedResult.usage?.cost.total).toBeCloseTo(0.000012936, 12);
	});

	it("posts OpenRouter System One requests to its TypeSafe-compatible endpoint", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "typesafe/jev-1.13", state: context.state });
			// Response shape observed from the live OpenRouter endpoint.
			return Response.json({
				id: "gen-dec-1",
				provider: "TypeSafe",
				answers: wireAnswers,
				usage: { input_tokens: 308, output_tokens: 23, cost: 0.000012936 },
			});
		});
		const openRouterModel = {
			...model,
			id: "typesafe/jev-1.13",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			cost: { ...model.cost, input: 0.042 },
		};

		const result = await classify(openRouterModel, context, { apiKey: "secret", fetch });

		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/systemone");
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.95 });
		// Priced from the catalog like chat usage; matches OpenRouter's reported cost.
		expect(result.usage?.cost.total).toBeCloseTo(0.000012936, 12);
	});

	it("rejects models for other classifier APIs", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));
		const result = await classify({ ...model, api: "cloudflare-workers-ai-system-one" }, context, {
			apiKey: "secret",
			fetch,
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unsupported classifier API: cloudflare-workers-ai-system-one");
	});

	it("merges headers case-insensitively and supports null suppression", async () => {
		const requests: Array<Record<string, string>> = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push(Object.fromEntries(new Headers(init?.headers)));
			return Response.json({ answers: wireAnswers });
		});
		const modelWithHeaders = {
			...model,
			headers: { authorization: "Bearer model", "X-Source": "model" },
		};

		await classify(modelWithHeaders, context, {
			apiKey: "secret",
			fetch,
			headers: { Authorization: "Bearer request", "x-source": "request" },
		});
		await classify(modelWithHeaders, context, {
			apiKey: "secret",
			fetch,
			headers: { Authorization: null },
		});

		expect(requests[0]).toMatchObject({ authorization: "Bearer request", "x-source": "request" });
		expect(Object.keys(requests[0]).filter((name) => name.toLowerCase() === "authorization")).toHaveLength(1);
		expect(requests[1]).not.toHaveProperty("authorization");
	});

	it("preserves prototype-sensitive question IDs in answers", async () => {
		const prototypeContext: ClassifierContext = {
			state: {},
			questions: JSON.parse(
				'{"__proto__":{"type":"bool","instructions":"Is this true?","criteria":{"true":"Yes","false":"No"}}}',
			),
		};
		const result = await classify(model, prototypeContext, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: JSON.parse('{"__proto__":{"type":"noul","noul":0.75}}') }),
		});

		const serializedAnswers = JSON.parse(JSON.stringify(result.answers)) as Record<string, unknown>;
		expect(result.stopReason).toBe("stop");
		expect(Object.keys(result.answers)).toEqual(["__proto__"]);
		expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
		expect(result.answers.__proto__).toEqual({ type: "bool", probability: 0.75 });
		expect(serializedAnswers.__proto__).toEqual({ type: "bool", probability: 0.75 });
	});

	it("reports request timeouts separately from caller cancellation", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			timeoutMs: 5,
			maxRetries: 0,
			fetch: async (_input, init) => {
				const signal = init?.signal;
				if (!signal) throw new Error("missing request signal");
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request timed out after 5ms");
	});

	it("creates a fresh timeout for every retry attempt", async () => {
		const signals: AbortSignal[] = [];
		let attempt = 0;
		const result = await classify(model, context, {
			apiKey: "secret",
			timeoutMs: 1000,
			maxRetries: 1,
			fetch: async (_input, init) => {
				if (!(init?.signal instanceof AbortSignal)) throw new Error("missing request signal");
				signals.push(init.signal);
				attempt++;
				return attempt === 1
					? new Response("retry", { status: 500, headers: { "retry-after-ms": "0" } })
					: Response.json({ answers: wireAnswers });
			},
		});

		expect(result.stopReason).toBe("stop");
		expect(signals).toHaveLength(2);
		expect(signals[0]).not.toBe(signals[1]);
	});

	it("returns malformed responses as classifier errors", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: {}, usage: { input_tokens: 10, output_tokens: 2 } }),
		});

		expect(result.stopReason).toBe("error");
		expect(result.answers).toEqual({});
		expect(result.errorMessage).toContain("did not return an answer for category");
		// The request was billed, so its usage is kept.
		expect(result.usage).toMatchObject({ input: 10, output: 2 });
	});

	it("ignores malformed usage", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: wireAnswers, usage: { input_tokens: "many", output_tokens: 3 } }),
		});
		const withoutTokens = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: wireAnswers, usage: { cost: 0.1 } }),
		});

		expect(result.stopReason).toBe("stop");
		expect(result.usage).toMatchObject({ input: 0, output: 3, totalTokens: 3 });
		expect(withoutTokens.stopReason).toBe("stop");
		expect(withoutTokens.usage).toBeUndefined();
	});
});
