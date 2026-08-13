// Unit tests for the shared provider error-body normalizer.
//
// See issues/provider-error-body-passthrough. These cover one synthesized error
// object per SDK shape (Mistral, openai APIError, @google/genai ApiError, AWS
// Bedrock ServiceException), plus the non-Error fallback, truncation, the empty
// parsed-body edge case, and the formatProviderError compose helper.

import { describe, expect, it } from "vitest";
import { formatProviderError, MAX_PROVIDER_ERROR_BODY_CHARS, normalizeProviderError } from "../src/utils/error-body.ts";

describe("normalizeProviderError", () => {
	it("extracts status and body from a Mistral-shaped error", () => {
		const error = Object.assign(new Error("Mistral request failed"), {
			statusCode: 403,
			body: '{"error":"blocked by gateway WAF"}',
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("reads the parsed body off an openai APIError when the message is opaque", () => {
		// makeMessage(status, error, message) yields "<status> status code (no body)"
		// when the parsed body is unparsed, while the body stays on error.error.
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: { error: "blocked by gateway WAF" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("preserves the message when @google/genai already folds the body into it", () => {
		const body = { error: { code: 403, message: "Permission denied" } };
		const error = Object.assign(new Error(JSON.stringify(body)), {
			status: 403,
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.messageCarriesBody).toBe(true);
		expect(norm.message).toBe(JSON.stringify(body));
	});

	it("extracts status and body from a Bedrock-shaped ServiceException", () => {
		const error = Object.assign(new Error("UnknownError"), {
			name: "UnknownError",
			$metadata: { httpStatusCode: 403 },
			$response: { statusCode: 403, body: '{"message":"blocked by gateway WAF"}' },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"message":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("ignores a Bedrock response stream instead of serializing its internals", () => {
		const error = Object.assign(
			new Error("Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported."),
			{
				name: "ValidationException",
				$metadata: { httpStatusCode: 400 },
				$response: {
					statusCode: 400,
					body: { pipe: () => undefined, _events: { close: [null, null] } },
				},
			},
		);

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("on-demand throughput isn't supported");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance response body without a pipe method instead of serializing it", () => {
		// Not every SDK response wrapper is a node stream: web ReadableStreams
		// and SDK-specific wrapper classes have no `pipe`, but serializing them
		// still yields internals-noise that would replace the real message.
		class SdkHttpResponseBody {
			locked = false;
			state = { storedError: undefined };
		}
		const error = Object.assign(new Error("Input is too long for requested model."), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
			$response: { statusCode: 400, body: new SdkHttpResponseBody() },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("Input is too long");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance `error` field instead of serializing it", () => {
		class SdkInnerError {
			code = "EPROTO";
			internalState = {};
		}
		const error = Object.assign(new Error("TLS handshake failed"), {
			status: 502,
			error: new SdkInnerError(),
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe("TLS handshake failed");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("still surfaces a plain parsed JSON body object", () => {
		const error = Object.assign(new Error("400 status code (no body)"), {
			status: 400,
			error: { message: "schema validation failed", field: "tools[0]" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBe('{"message":"schema validation failed","field":"tools[0]"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("JSON-stringifies a non-Error thrown value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(norm.status).toBeUndefined();
		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe('{"reason":"boom"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("treats an empty parsed body object as no body", () => {
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: {},
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("truncates the body at the cap", () => {
		const longBody = "x".repeat(MAX_PROVIDER_ERROR_BODY_CHARS + 50);
		const error = Object.assign(new Error("failed"), {
			statusCode: 500,
			body: longBody,
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toContain("... [truncated 50 chars]");
		expect(norm.body?.length).toBeLessThan(longBody.length);
	});

	it("sets messageCarriesBody when the message already contains the extracted body", () => {
		const error = Object.assign(new Error("500: upstream exploded"), {
			statusCode: 500,
			body: "upstream exploded",
		});

		const norm = normalizeProviderError(error);

		expect(norm.messageCarriesBody).toBe(true);
	});
});

describe("formatProviderError", () => {
	it("surfaces status and body without a prefix", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		const formatted = formatProviderError(norm);

		expect(formatted).toContain("403");
		expect(formatted).toContain("blocked by gateway WAF");
		expect(formatted).not.toBe("403 status code (no body)");
	});

	it("applies a provider prefix with status and body", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		expect(formatProviderError(norm, "OpenAI API error")).toBe(
			'OpenAI API error (403): {"error":"blocked by gateway WAF"}',
		);
	});

	it("preserves the message (with prefix + status) when it already carries the body", () => {
		const body = JSON.stringify({ error: { message: "Permission denied" } });
		const norm = normalizeProviderError(Object.assign(new Error(body), { status: 403 }));

		expect(formatProviderError(norm, "OpenAI API error")).toBe(`OpenAI API error (403): ${body}`);
	});

	it("returns the bare message for a non-Error value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(formatProviderError(norm)).toBe('{"reason":"boom"}');
	});
});
