import { describe, expect, it } from "vitest";
import {
	answerFromProbabilities,
	classify,
	labelProbabilities,
	llamaServerRoot,
	peakConfidence,
	renderQuestion,
} from "../src/api/llama-cpp-classify.ts";
import type { ClassifierContext, ClassifierModel, ClassifierOptions } from "../src/types.ts";

let serverCount = 0;

/** A fresh server URL per test: label tokens are cached per server and model. */
function model(): ClassifierModel<"llama-cpp-classify"> {
	serverCount++;
	return {
		type: "classifier",
		id: "qwen",
		name: "qwen",
		api: "llama-cpp-classify",
		provider: "llama.cpp",
		baseUrl: `http://llama-${serverCount}.test:8080/v1`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
	};
}

interface RecordedRequest {
	url: string;
	body: Record<string, unknown>;
	headers: Headers;
}

interface FakeServerOptions {
	/** Log-probabilities of the next token by token text, in rank order. */
	next?: (prompt: string, depth: number) => Record<string, number>;
	template?: (messages: Array<{ role: string; content: string }>) => string;
	tokenize?: (content: string) => number[];
}

/** Token IDs: one per character, the character code. */
function charTokens(content: string): number[] {
	return [...content].map((char) => char.codePointAt(0)!);
}

function fakeServer(options: FakeServerOptions = {}) {
	const requests: RecordedRequest[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push({ url, body, headers: new Headers(init?.headers) });
		const path = new URL(url).pathname;
		if (path === "/tokenize") {
			const content = String(body.content);
			return Response.json({ tokens: (options.tokenize ?? charTokens)(content) });
		}
		if (path === "/apply-template") {
			const messages = body.messages as Array<{ role: string; content: string }>;
			const prompt =
				options.template?.(messages) ??
				`${messages.map((message) => `<|${message.role}|>\n${message.content}\n`).join("")}<|assistant|>\n`;
			return Response.json({ prompt });
		}
		if (path === "/completion") {
			const next = options.next?.(String(body.prompt), Number(body.n_probs)) ?? { A: -0.1, B: -2.5 };
			const top_logprobs = Object.entries(next).map(([token, logprob]) => ({
				id: token.codePointAt(0),
				token,
				bytes: [],
				logprob,
			}));
			return Response.json({ content: "A", completion_probabilities: [{ id: 65, token: "A", top_logprobs }] });
		}
		return new Response("not found", { status: 404 });
	};
	return { fetch, requests };
}

/** Completion log-probabilities for bool (Yes/No) and letter labels; the fake tokenizer maps a label to its first character. */
function answerByPrompt(prompt: string): Record<string, number> {
	if (prompt.includes("Answer Yes or No.")) return { Y: -0.05, N: -3 };
	if (prompt.includes("Answer with one level number.")) return { "2": -0.2, "1": -1.8, "0": -4 };
	return { B: -0.3, A: -1.5, C: -3 };
}

const context: ClassifierContext = {
	state: { message: "Help! My payouts have been failing for 3 days." },
	questions: {
		team: {
			type: "choice",
			instructions: "Which team should handle this?",
			criteria: { billing: "Payments and refunds", technical: "Bugs and outages", sales: "" },
		},
		urgent: {
			type: "bool",
			instructions: "Does this convey urgency?",
			criteria: { true: "The user needs help soon", false: "No time pressure" },
		},
		severity: { type: "score", instructions: "How severe is this?", criteria: ["low", "medium", "high"] },
	},
};

/** Maps multi-character labels to single tokens, as a real vocabulary would. */
function wordTokens(content: string): number[] {
	const words: Record<string, number> = { Yes: 89, No: 78 };
	const tokens: number[] = [];
	for (const part of content.split(/(\n)/u)) {
		if (part === "") continue;
		tokens.push(...(words[part] !== undefined ? [words[part]] : charTokens(part)));
	}
	return tokens;
}

describe("llama.cpp classifier", () => {
	it("answers choice, bool and score questions from label log-probabilities", async () => {
		const server = fakeServer({ next: answerByPrompt, tokenize: wordTokens });
		const classifierModel = model();

		const result = await classify(classifierModel, context, { apiKey: "local", fetch: server.fetch });

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		const choice = labelProbabilities([-1.5, -0.3, -3], 1);
		expect(result.answers.team).toEqual({
			type: "choice",
			choice: "technical",
			probabilities: { billing: choice[0], technical: choice[1], sales: choice[2] },
			confidence: peakConfidence(choice),
		});
		expect(result.answers.urgent).toEqual({ type: "bool", probability: labelProbabilities([-0.05, -3], 1)[0] });
		const levels = labelProbabilities([-4, -1.8, -0.2], 1);
		expect(result.answers.severity).toEqual({
			type: "score",
			score: levels[1]! + 2 * levels[2]!,
			confidence: peakConfidence(levels),
		});

		const root = classifierModel.baseUrl.replace(/\/v1$/u, "");
		for (const request of server.requests) {
			expect(request.url.startsWith(`${root}/`)).toBe(true);
			expect(request.body.model).toBe("qwen");
			expect(request.headers.get("authorization")).toBe("Bearer local");
		}
		const completion = server.requests.find((request) => request.url.endsWith("/completion"));
		expect(completion?.body).toMatchObject({
			n_predict: 1,
			n_probs: 256,
			post_sampling_probs: false,
			cache_prompt: true,
		});
		const template = server.requests.find((request) => request.url.endsWith("/apply-template"));
		expect(template?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("puts the state first and lists options under letters", () => {
		const rendered = renderQuestion(context.state, context.questions.team!);
		expect(rendered.labels).toEqual(["A", "B", "C"]);
		expect(rendered.keys).toEqual(["billing", "technical", "sales"]);
		expect(rendered.content).toBe(
			[
				"State:",
				'{\n "message": "Help! My payouts have been failing for 3 days."\n}',
				"",
				"Question: Which team should handle this?",
				"",
				"Options:",
				"A. billing: Payments and refunds",
				"B. technical: Bugs and outages",
				"C. sales",
				"",
				"Answer with one letter.",
			].join("\n"),
		);
	});

	it("divides label log-probabilities by the temperature", async () => {
		const server = fakeServer({ next: () => ({ A: -0.1, B: -2.5 }) });
		const questions: ClassifierContext["questions"] = {
			pick: { type: "choice", instructions: "Pick one", criteria: { a: "", b: "" } },
		};

		const result = await classify(model(), { state: {}, questions }, { fetch: server.fetch, temperature: 2 });

		const expected = labelProbabilities([-0.1 / 2, -2.5 / 2], 1);
		expect(result.answers.pick).toMatchObject({ probabilities: { a: expected[0], b: expected[1] } });
		expect(labelProbabilities([-0.1, -2.5], 2)).toEqual(expected);
	});

	it("rejects non-positive temperatures before sending requests", async () => {
		const server = fakeServer();
		const result = await classify(model(), context, { fetch: server.fetch, temperature: 0 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Temperature must be a positive number, got 0");
		expect(server.requests).toEqual([]);
	});

	it("retries deeper readouts when a label is missing and fails without inventing zeros", async () => {
		const questions: ClassifierContext["questions"] = {
			pick: { type: "choice", instructions: "Pick one", criteria: { a: "", b: "" } },
		};
		const deep = fakeServer({
			next: (_prompt, depth): Record<string, number> => (depth < 4096 ? { A: -0.1 } : { A: -0.1, B: -9 }),
		});
		const recovered = await classify(model(), { state: {}, questions }, { fetch: deep.fetch });
		expect(recovered.stopReason).toBe("stop");
		expect(completionDepths(deep.requests)).toEqual([256, 4096]);

		const never = fakeServer({ next: () => ({ A: -0.1 }) });
		const failed = await classify(model(), { state: {}, questions }, { fetch: never.fetch });
		expect(failed.stopReason).toBe("error");
		expect(failed.answers).toEqual({});
		expect(failed.errorMessage).toContain("did not rank labels B for pick within the top 32768 tokens");
		expect(completionDepths(never.requests)).toEqual([256, 4096, 32768]);
	});

	it("closes a reasoning block the template leaves open", async () => {
		const server = fakeServer({ template: () => "<|assistant|>\n<think>" });
		await classify(
			model(),
			{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
			{ fetch: server.fetch },
		);

		const completion = server.requests.find((request) => request.url.endsWith("/completion"));
		expect(completion?.body.prompt).toBe("<|assistant|>\n<think></think>");
	});

	it("reads labels in reply position and rejects labels that are not one token", async () => {
		// A tokenizer that merges a newline with a following letter falls back to the label alone.
		const merging = fakeServer({
			tokenize: (content) => (content.startsWith("\n") && content.length > 1 ? [1000] : charTokens(content)),
		});
		const merged = await classify(
			model(),
			{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
			{ fetch: merging.fetch },
		);
		expect(merged.stopReason).toBe("stop");

		// The default fake tokenizer splits "Yes" into three tokens.
		const split = fakeServer();
		const result = await classify(
			model(),
			{ state: {}, questions: { ok: { type: "bool", instructions: "OK?", criteria: { true: "", false: "" } } } },
			{ fetch: split.fetch },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Label "Yes" is not a single token for qwen');
	});

	it("caches label tokens per server and model", async () => {
		const classifierModel = model();
		const server = fakeServer();
		const questions: ClassifierContext["questions"] = {
			pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } },
		};
		await classify(classifierModel, { state: {}, questions }, { fetch: server.fetch });
		const firstTokenizations = server.requests.filter((request) => request.url.endsWith("/tokenize")).length;
		await classify(classifierModel, { state: {}, questions }, { fetch: server.fetch });

		expect(firstTokenizations).toBeGreaterThan(0);
		expect(server.requests.filter((request) => request.url.endsWith("/tokenize"))).toHaveLength(firstTokenizations);
	});

	it("validates option counts before sending requests", async () => {
		const server = fakeServer();
		const criteria = Object.fromEntries(Array.from({ length: 63 }, (_value, index) => [`option${index}`, ""]));
		const tooMany = await classify(
			model(),
			{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria } } },
			{ fetch: server.fetch },
		);
		const tooFew = await classify(
			model(),
			{ state: {}, questions: { rate: { type: "score", instructions: "Rate", criteria: ["only"] } } },
			{ fetch: server.fetch },
		);

		expect(tooMany.errorMessage).toContain("A choice question needs 2 to 62 options, got 63");
		expect(tooFew.errorMessage).toContain("A score question needs 2 to 10 levels, got 1");
		expect(server.requests).toEqual([]);
	});

	it("passes completion payloads and responses through the request hooks", async () => {
		const server = fakeServer();
		const payloads: unknown[] = [];
		const statuses: number[] = [];
		const options: ClassifierOptions = {
			fetch: server.fetch,
			onPayload: (payload) => {
				payloads.push(payload);
				return { ...(payload as object), id_slot: 1 };
			},
			onResponse: (response) => {
				statuses.push(response.status);
			},
		};

		await classify(
			model(),
			{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
			options,
		);

		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toMatchObject({ n_predict: 1 });
		expect(statuses).toEqual([200]);
		expect(server.requests.find((request) => request.url.endsWith("/completion"))?.body.id_slot).toBe(1);
	});

	it("reports server errors and cancellation", async () => {
		const failing = await classify(model(), context, {
			maxRetries: 0,
			fetch: async () => new Response('{"error":{"message":"context overflow"}}', { status: 400 }),
		});
		expect(failing.stopReason).toBe("error");
		expect(failing.errorMessage).toContain("llama.cpp error (400)");
		expect(failing.errorMessage).toContain("context overflow");

		const controller = new AbortController();
		controller.abort();
		const aborted = await classify(model(), context, {
			signal: controller.signal,
			fetch: async (_input, init) => {
				init?.signal?.throwIfAborted();
				return Response.json({});
			},
		});
		expect(aborted.stopReason).toBe("aborted");
	});

	it("rejects models for other classifier APIs", async () => {
		const server = fakeServer();
		const result = await classify({ ...model(), api: "typesafe-system-one" }, context, { fetch: server.fetch });

		expect(result.errorMessage).toContain("Unsupported classifier API: typesafe-system-one");
		expect(server.requests).toEqual([]);
	});

	it("derives the server root from OpenAI-compatible base URLs", () => {
		expect(llamaServerRoot("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(llamaServerRoot("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(llamaServerRoot("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
	});

	it("computes TypeSafe's confidence and expected scores", () => {
		expect(peakConfidence([0.89, 0.06, 0.05])).toBeCloseTo(0.835);
		expect(peakConfidence([0.5, 0.5])).toBe(0);
		expect(peakConfidence([1, 0, 0])).toBe(1);
		expect(
			answerFromProbabilities(
				{ type: "score", instructions: "", criteria: ["a", "b", "c"] },
				["0", "1", "2"],
				[0.2, 0.3, 0.5],
			),
		).toEqual({ type: "score", score: 1.3, confidence: peakConfidence([0.2, 0.3, 0.5]) });
	});
});

function completionDepths(requests: RecordedRequest[]): number[] {
	return requests
		.filter((request) => request.url.endsWith("/completion"))
		.map((request) => Number(request.body.n_probs));
}
