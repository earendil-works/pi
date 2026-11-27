import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-interactions.ts";
import { classifyGoogleInteractionsError } from "../src/api/google-interactions-errors.ts";
import { GOOGLE_AI_PLAN_MODELS } from "../src/providers/google-ai-plan.models.ts";
import type { FetchFunction } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const DAILY_LIMIT_BODY = JSON.stringify({
	error: {
		code: "too_many_requests",
		message:
			"You've reached today's AI Ultra limit for gemini-4-hydrogen in third-party apps. Your daily limit refreshes in 5 hours, 18 minutes. Until then, you can switch to other models.",
	},
});

function classify(status: number, body: string, headers: Record<string, string> = {}) {
	return classifyGoogleInteractionsError({
		status,
		headers: new Headers(headers),
		body,
		modelId: "gemini-4-hydrogen",
	});
}

const PER_DAY_QUOTA_BODY = (quotaValue: string) =>
	JSON.stringify({
		error: {
			message: "Resource exhausted.",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.QuotaFailure",
					violations: [{ quotaId: "GenerateRequestsPerDayPerUserPerModel", quotaValue }],
				},
			],
		},
	});

const ZERO_LIMIT_BODY = JSON.stringify({
	error: { message: "Rate limit exceeded for model gemini-4-argon (limit: 0 tokens per day)" },
});

describe("classifyGoogleInteractionsError", () => {
	it("does not retry a daily-limit 429 and keeps Google's text, which already says when it resets", () => {
		expect(classify(429, DAILY_LIMIT_BODY, { "retry-after": "19104" })).toEqual({
			message:
				"429 You've reached today's AI Ultra limit for gemini-4-hydrogen in third-party apps. Your daily limit refreshes in 5 hours, 18 minutes. Until then, you can switch to other models. Daily limit reached for gemini-4-hydrogen: switch to another model, or use a Gemini API key.",
			final: true,
		});
	});

	it("adds the reset time from Retry-After to a per-day quota violation", () => {
		expect(classify(429, PER_DAY_QUOTA_BODY("1000000"), { "retry-after": "19104" })).toEqual({
			message:
				"429 Resource exhausted. Daily limit reached for gemini-4-hydrogen (resets in 5h 19m): switch to another model, or use a Gemini API key.",
			final: true,
		});
		expect(classify(429, PER_DAY_QUOTA_BODY("1000000"), { "retry-after": "7199" }).message).toContain(
			"(resets in 2h 0m)",
		);
	});

	it("reports a daily limit of zero as a model the plan does not include", () => {
		const hint = "gemini-4-hydrogen is not available on the Google AI Ultra plan. Choose another model.";
		expect(classify(429, PER_DAY_QUOTA_BODY("0"))).toEqual({
			message: `429 Resource exhausted. ${hint}`,
			final: true,
		});
		expect(classify(429, ZERO_LIMIT_BODY)).toEqual({
			message: `429 Rate limit exceeded for model gemini-4-argon (limit: 0 tokens per day) ${hint}`,
			final: true,
		});
	});

	it("leaves a per-minute 429 to the shared retry rules", () => {
		const error = classify(429, JSON.stringify({ error: { message: "Too many requests." } }));
		expect(error).toEqual({ message: "429 Too many requests.", final: false });
	});

	it("reports models outside the plan", () => {
		const body = JSON.stringify({
			error: {
				message: "Model gemini-4-argon is not supported for per-user quota requests.",
				code: "invalid_request",
			},
		});
		expect(classify(400, body).message).toBe(
			"400 Model gemini-4-argon is not supported for per-user quota requests. gemini-4-hydrogen is not available on the Google AI Ultra plan. Choose another model.",
		);
	});

	it("asks to sign in again on 401 bodies sent as JSON arrays", () => {
		const body = JSON.stringify([
			{
				error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
			},
		]);
		expect(classify(401, body).message).toBe(
			"401 Request had invalid authentication credentials. Run /login to sign in again.",
		);
	});

	it("tells scope, disabled-service and plan errors apart", () => {
		const errorInfo = (reason: string) =>
			JSON.stringify([
				{
					error: {
						code: 403,
						message: "Permission denied.",
						details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }],
					},
				},
			]);
		expect(classify(403, errorInfo("ACCESS_TOKEN_SCOPE_INSUFFICIENT")).message).toBe(
			"403 Permission denied. Run /login to sign in again.",
		);
		expect(
			classify(403, JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }))
				.message,
		).toBe("403 Request had insufficient authentication scopes. Run /login to sign in again.");
		expect(classify(403, errorInfo("SERVICE_DISABLED")).message).toBe(
			"403 Permission denied. The Google AI Ultra plan is currently unavailable in pi.",
		);
		expect(classify(403, JSON.stringify({ error: { message: "Permission denied." } })).message).toBe(
			"403 Permission denied. Your Google account does not have an eligible Google AI Ultra plan. Upgrade at https://one.google.com/ai, or use a Gemini API key.",
		);
	});

	it("reads the message from an SSE error frame", () => {
		const body =
			'event: error\ndata: {"error":{"message":"Function call is missing a thought_signature.","code":"invalid_request"},"event_type":"error"}\n\n';
		expect(classify(400, body)).toEqual({
			message: "400 Function call is missing a thought_signature.",
			final: false,
		});
	});
});

describe("google-interactions stream errors", () => {
	const model = GOOGLE_AI_PLAN_MODELS["gemini-4-hydrogen"];
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

	async function run(responses: Response[]) {
		let calls = 0;
		const fetch: FetchFunction = async () => responses[calls++]!;
		const result = await stream(model, context, {
			headers: { Authorization: "Bearer token" },
			fetch,
			maxRetries: 2,
		}).result();
		return { result, calls };
	}

	it("does not retry a daily limit, at request or agent level", async () => {
		const { result, calls } = await run([
			new Response(DAILY_LIMIT_BODY, { status: 429 }),
			new Response(DAILY_LIMIT_BODY, { status: 429 }),
		]);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Daily limit reached for gemini-4-hydrogen");
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("does not retry a model the plan does not include, at request or agent level", async () => {
		const { result, calls } = await run([
			new Response(ZERO_LIMIT_BODY, { status: 429 }),
			new Response(ZERO_LIMIT_BODY, { status: 429 }),
		]);
		expect(calls).toBe(1);
		expect(result.errorMessage).toContain("is not available on the Google AI Ultra plan");
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("retries a per-minute 429 and then streams the answer", async () => {
		const events = [
			{ event_type: "step.start", index: 0, step: { type: "model_output" } },
			{ event_type: "step.delta", index: 0, delta: { type: "text", text: "hello" } },
			{ event_type: "step.stop", index: 0 },
			{ event_type: "interaction.completed", interaction: { id: "i1", status: "completed" } },
		];
		const sse = events.map((event) => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		const { result, calls } = await run([
			new Response(JSON.stringify({ error: { message: "Too many requests." } }), {
				status: 429,
				headers: { "retry-after": "0" },
			}),
			new Response(sse, { status: 200 }),
		]);
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});
});
