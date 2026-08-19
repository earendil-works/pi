// Regression test for issues/provider-error-body-passthrough
//
// When an endpoint behind a proxy / gateway returns a non-2xx response with a
// body the SDK cannot fold into its message, the provider catch block drops the
// body. The openai SDK's APIError keeps the parsed body on `error.error` and
// produces `"<status> status code (no body)"` as the message, so a body-blind
// catch (`error.message` only) surfaces the opaque message and hides the real
// reason the gateway returned.
//
// This test routes a 403-with-body APIError through the OpenRouter image
// provider (one of the body-blind providers) and asserts the resulting
// errorMessage contains both the status and the body reason. It is EXPECTED TO
// FAIL until the provider catch blocks read the SDK error body.

import { describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

// Reproduce the openai SDK APIError shape: makeMessage(status, error, message)
// returns `"403 status code (no body)"` when status is set but the parsed body
// (`error`) is empty/unparsed, while the parsed body itself is kept on `.error`.
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "PermissionDeniedError";
		this.status = status;
		this.error = parsedBody;
	}
}

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const promise = Promise.resolve(undefined) as unknown as {
						withResponse: () => Promise<never>;
					};
					promise.withResponse = async () => {
						// 403 from a gateway/proxy carrying the real reason in the body.
						throw new FakeAPIError(403, { error: "blocked by gateway WAF" });
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

describe("provider error body passthrough", () => {
	it("surfaces the HTTP body reason instead of the opaque SDK message (openrouter images)", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });

		expect(output.stopReason).toBe("error");
		// The status should be surfaced.
		expect(output.errorMessage).toContain("403");
		// The body reason must not be swallowed by the opaque SDK message.
		expect(output.errorMessage).toContain("blocked by gateway WAF");
		expect(output.errorMessage).not.toBe("403 status code (no body)");
	});
});
