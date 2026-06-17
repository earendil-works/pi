import { describe, expect, it } from "vitest";
import { formatProviderError } from "../src/utils/provider-errors.ts";

describe("formatProviderError", () => {
	it("falls back to raw body for opaque no-body SDK messages", () => {
		const error = new Error("403 status code (no body)") as Error & { status?: number; body?: string };
		error.status = 403;
		error.body = '{"error":"gateway rejected request"}';

		expect(formatProviderError(error, { providerName: "OpenAI" })).toBe(
			'OpenAI API error (403): {"error":"gateway rejected request"}',
		);
	});

	it("keeps parsed SDK messages when they are useful", () => {
		const error = new Error("gateway rejected request") as Error & { status?: number; body?: string };
		error.status = 403;
		error.body = '{"error":"gateway rejected request"}';

		expect(formatProviderError(error, { providerName: "OpenAI" })).toBe(
			"OpenAI API error (403): gateway rejected request",
		);
	});

	it("uses statusCode and object bodies from non-OpenAI SDKs", () => {
		const error = new Error("Unknown: UnknownError") as Error & {
			statusCode?: number;
			body?: Record<string, string>;
		};
		error.statusCode = 403;
		error.body = { error: "bedrock gateway rejected request" };

		expect(formatProviderError(error, { providerName: "Bedrock" })).toBe(
			'Bedrock API error (403): {"error":"bedrock gateway rejected request"}',
		);
	});

	it("truncates long raw bodies", () => {
		const error = new Error("500 status code (no body)") as Error & { status?: number; body?: string };
		error.status = 500;
		error.body = "x".repeat(12);

		expect(formatProviderError(error, { providerName: "OpenAI", maxBodyChars: 5 })).toBe(
			"OpenAI API error (500): xxxxx... [truncated 7 chars]",
		);
	});
});
