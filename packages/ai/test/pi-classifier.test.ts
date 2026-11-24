import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/api/pi-classifier.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"pi-classifier"> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev Latest",
	api: "pi-classifier",
	provider: "radius",
	baseUrl: "https://radius.example/v1",
	input: ["text"],
	cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
};

const context: ClassifierContext = {
	state: { message: "Looks good, ship it." },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does the user approve?",
			criteria: { true: "Approved", false: "Not approved" },
		},
		sentiment: {
			type: "choice",
			instructions: "What is the sentiment?",
			criteria: { positive: "Positive", negative: "Negative" },
		},
		urgency: {
			type: "score",
			instructions: "How urgent?",
			criteria: ["low", "medium", "high"],
		},
	},
};

describe("Pi Classifier", () => {
	it("posts canonical context and options to /classify and returns typed answers with authoritative cost", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 0.96 },
						sentiment: {
							type: "choice",
							choice: "positive",
							probabilities: { positive: 0.95, negative: 0.05 },
							confidence: 0.9,
						},
						urgency: { type: "score", score: 0.4, confidence: 0.8 },
					},
					usage: {
						input: 120,
						output: 3,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 123,
						cost: { input: 0.0001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00011 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await classify(model, context, {
			apiKey: "radius-key",
			sessionId: "sess-1",
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://radius.example/v1/classify");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "jev-latest",
			context: {
				state: context.state,
				questions: context.questions,
			},
			options: {
				sessionId: "sess-1",
			},
		});

		expect(result).toMatchObject({
			api: "pi-classifier",
			provider: "radius",
			model: "jev-latest",
			stopReason: "stop",
			answers: {
				approved: { type: "bool", probability: 0.96 },
				sentiment: {
					type: "choice",
					choice: "positive",
					probabilities: { positive: 0.95, negative: 0.05 },
					confidence: 0.9,
				},
				urgency: { type: "score", score: 0.4, confidence: 0.8 },
			},
			usage: {
				input: 120,
				output: 3,
				totalTokens: 123,
				cost: { total: 0.00011 },
			},
		});
	});

	it("returns an error result when the backend responds with an error envelope", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { message: "Insufficient credits", code: "insufficient_credits" },
				}),
				{ status: 402, headers: { "content-type": "application/json" } },
			),
		);

		const result = await classify(model, context, { apiKey: "radius-key", maxRetries: 0, fetch: fetchMock });

		expect(result.stopReason).toBe("error");
		expect(result.answers).toEqual({});
		expect(result.errorMessage).toContain("Insufficient credits");
	});

	it("rejects out-of-range probabilities and unknown choices", async () => {
		const badChoiceFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 0.9 },
						sentiment: {
							type: "choice",
							choice: "invented",
							probabilities: { positive: 0.9, negative: 0.1 },
							confidence: 0.8,
						},
						urgency: { type: "score", score: 1, confidence: 0.5 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const badChoice = await classify(model, context, { apiKey: "radius-key", fetch: badChoiceFetch });
		expect(badChoice.stopReason).toBe("error");
		expect(badChoice.errorMessage).toContain('unknown choice "invented"');

		const badProbFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 1.5 },
						sentiment: {
							type: "choice",
							choice: "positive",
							probabilities: { positive: 0.9, negative: 0.1 },
							confidence: 0.8,
						},
						urgency: { type: "score", score: 1, confidence: 0.5 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const badProb = await classify(model, context, { apiKey: "radius-key", fetch: badProbFetch });
		expect(badProb.stopReason).toBe("error");
		expect(badProb.errorMessage).toContain("out-of-range probability");

		const protoChoiceFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 0.9 },
						sentiment: {
							type: "choice",
							choice: "toString",
							probabilities: { positive: 0.9, negative: 0.1 },
							confidence: 0.8,
						},
						urgency: { type: "score", score: 1, confidence: 0.5 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const protoChoice = await classify(model, context, { apiKey: "radius-key", fetch: protoChoiceFetch });
		expect(protoChoice.stopReason).toBe("error");
		expect(protoChoice.errorMessage).toContain('unknown choice "toString"');

		const unknownProbKeyFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 0.9 },
						sentiment: {
							type: "choice",
							choice: "positive",
							probabilities: { positive: 0.9, bogus: 0.1 },
							confidence: 0.8,
						},
						urgency: { type: "score", score: 1, confidence: 0.5 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const unknownProbKey = await classify(model, context, { apiKey: "radius-key", fetch: unknownProbKeyFetch });
		expect(unknownProbKey.stopReason).toBe("error");
		expect(unknownProbKey.errorMessage).toContain('unknown choice "bogus"');
	});

	it("forwards images when the model supports image input and rejects them on text-only models", async () => {
		const imageModel: ClassifierModel<"pi-classifier"> = { ...model, input: ["text", "image"] };
		const images = [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					answers: {
						approved: { type: "bool", probability: 0.9 },
						sentiment: {
							type: "choice",
							choice: "positive",
							probabilities: { positive: 0.9, negative: 0.1 },
							confidence: 0.8,
						},
						urgency: { type: "score", score: 1, confidence: 0.5 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const okResult = await classify(imageModel, { ...context, images }, { apiKey: "radius-key", fetch: fetchMock });
		expect(okResult.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
			model: "jev-latest",
			context: {
				state: context.state,
				images,
				questions: context.questions,
			},
		});

		const rejected = await classify(model, { ...context, images }, { apiKey: "radius-key", fetch: fetchMock });
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toContain("does not support image input");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
