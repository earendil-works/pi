import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogle } from "../src/api/google-generative-ai.ts";
import { resolveGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { streamSimple as streamSimpleVertex } from "../src/api/google-vertex.ts";
import type {
	Context,
	Model,
	ModelThinkingLevel,
	ThinkingBudgets,
	ThinkingLevel,
	ThinkingLevelMap,
} from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function googleModel(id: string, thinkingLevelMap: ThinkingLevelMap): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "test-google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function vertexModel(id: string, thinkingLevelMap: ThinkingLevelMap): Model<"google-vertex"> {
	return {
		id,
		name: id,
		api: "google-vertex",
		provider: "test-vertex",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function captureGooglePayload(
	model: Model<"google-generative-ai">,
	reasoning: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const result = await streamSimpleGoogle(model, context, {
		apiKey: "test",
		reasoning,
		thinkingBudgets,
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();

	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("Google payload was not captured");
	return payload;
}

async function captureVertexPayload(
	model: Model<"google-vertex">,
	reasoning: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const result = await streamSimpleVertex(model, context, {
		apiKey: "test",
		reasoning,
		thinkingBudgets,
		onPayload: (request) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	}).result();

	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("Vertex payload was not captured");
	return payload;
}

describe("Google thinking level maps", () => {
	it("exhaustively resolves supported logical levels and mapping values", () => {
		const defaultExpectations = {
			off: "high",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
		} as const satisfies Partial<Record<ModelThinkingLevel, ThinkingLevel>>;
		for (const [level, expected] of Object.entries(defaultExpectations)) {
			expect(resolveGoogleThinkingLevel(googleModel("gemini-3.7-flash", {}), level as ModelThinkingLevel)).toBe(
				expected,
			);
		}

		const mappedExpectations = {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			MINIMAL: "minimal",
			LOW: "low",
			MEDIUM: "medium",
			HIGH: "high",
		} as const;
		for (const [mapped, expected] of Object.entries(mappedExpectations)) {
			const model = googleModel("gemini-3.7-flash", { high: mapped, xhigh: mapped, max: mapped });
			expect(resolveGoogleThinkingLevel(model, "high")).toBe(expected);
			expect(resolveGoogleThinkingLevel(model, "xhigh")).toBe(expected);
			expect(resolveGoogleThinkingLevel(model, "max")).toBe(expected);
		}

		const invalidModel = googleModel("gemini-3.7-flash", { xhigh: "extreme" });
		expect(() => resolveGoogleThinkingLevel(invalidModel, "xhigh")).toThrow(
			"Unsupported Google thinking level mapping for test-google/gemini-3.7-flash: xhigh -> extreme",
		);
		expect(() => resolveGoogleThinkingLevel(googleModel("gemini-3.7-flash", {}), "max")).toThrow(
			"Unsupported Google thinking level mapping for test-google/gemini-3.7-flash: max -> undefined",
		);
	});

	it.each(["xhigh", "max"] as const)("maps Google Generative AI %s to a supported level", async (reasoning) => {
		const payload = await captureGooglePayload(
			googleModel("gemini-3.7-flash", { xhigh: "high", max: "high" }),
			reasoning,
		);

		expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } });
	});

	it("honors uppercase provider values for standard Google Generative AI levels", async () => {
		const payload = await captureGooglePayload(googleModel("gemini-3.7-flash", { high: "LOW" }), "high");

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingLevel: "LOW" } } });
	});

	it("uses mapped Google Generative AI levels for token budgets", async () => {
		const payload = await captureGooglePayload(googleModel("gemini-2.5-flash", { xhigh: "high" }), "xhigh", {
			high: 1234,
		});

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingBudget: 1234 } } });
	});

	it("maps Google Vertex extended levels", async () => {
		const payload = await captureVertexPayload(vertexModel("gemini-3.7-flash", { xhigh: "high" }), "xhigh");

		expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } });
	});

	it("uses mapped Google Vertex levels for token budgets", async () => {
		const payload = await captureVertexPayload(vertexModel("gemini-2.5-flash", { max: "high" }), "max", {
			high: 4321,
		});

		expect(payload).toMatchObject({ config: { thinkingConfig: { thinkingBudget: 4321 } } });
	});
});
