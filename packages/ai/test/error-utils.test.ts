import { describe, expect, it } from "vitest";
import { formatProviderError } from "../src/providers/error-utils.ts";

describe("formatProviderError", () => {
	it("handles Mistral-style error structures", () => {
		const err = new Error("Mistral failed");
		(err as any).statusCode = 403;
		(err as any).body = '{"error":"Forbidden access"}';

		const result = formatProviderError(err, "Mistral");
		console.log("Mistral Error Output:", result);
		expect(result).toBe('Mistral API error (403): {"error":"Forbidden access"}');
	});

	it("handles Bedrock-style exception structures with $response", () => {
		const err = new Error("Bedrock request failed");
		(err as any).$metadata = { httpStatusCode: 400 };
		(err as any).$response = {
			statusCode: 400,
			body: new TextEncoder().encode('{"message":"Invalid prompt"}'),
		};

		const result = formatProviderError(err, "Bedrock");
		console.log("Bedrock Error Output:", result);
		expect(result).toBe('Bedrock API error (400): {"message":"Invalid prompt"}');
	});

	it("handles OpenAI-style APIError structures where error is a string", () => {
		const err = new Error("403 Forbidden");
		(err as any).status = 403;
		(err as any).error = "Invalid API key";

		const result = formatProviderError(err, "OpenAI");
		console.log("OpenAI Error (String) Output:", result);
		expect(result).toBe("OpenAI API error (403): Invalid API key");
	});

	it("handles OpenAI-style APIError structures where error is an object", () => {
		const err = new Error("400 Bad Request");
		(err as any).status = 400;
		(err as any).error = { message: "Invalid model selection" };

		const result = formatProviderError(err, "OpenAI");
		console.log("OpenAI Error (Object) Output:", result);
		expect(result).toBe("OpenAI API error (400): Invalid model selection");
	});

	it("handles Google SDK errors with stringified JSON message", () => {
		const jsonMsg = JSON.stringify({
			error: {
				message: "API key expired",
				code: 403,
				status: "PERMISSION_DENIED",
			},
		});
		const err = new Error(jsonMsg);
		(err as any).status = 403;

		const result = formatProviderError(err, "Google");
		console.log("Google Error Output:", result);
		expect(result).toBe("Google API error (403): API key expired");
	});

	it("falls back to message when no body/error object is found", () => {
		const err = new Error("Generic failure message");
		(err as any).status = 502;

		const result = formatProviderError(err, "Azure OpenAI");
		console.log("Azure OpenAI Error Output:", result);
		expect(result).toBe("Azure OpenAI API error (502): Generic failure message");
	});
});
