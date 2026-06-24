import { beforeEach, describe, expect, it, vi } from "vitest";

type MiddlewareHandler = (next: (args: unknown) => Promise<unknown>) => (args: unknown) => Promise<unknown>;

const bedrockMock = vi.hoisted(() => ({
	middlewareRegistrations: [] as Array<{
		handler: MiddlewareHandler;
		opts: { step?: string; name?: string; priority?: string };
	}>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = {
			add: (handler: MiddlewareHandler, opts: { step?: string; name?: string; priority?: string }) => {
				bedrockMock.middlewareRegistrations.push({ handler, opts });
			},
		};

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock, streamSimple as streamSimpleBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const MIDDLEWARE_NAME = "pi-ai-custom-headers";

function getModelFixture(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
}

/**
 * Drive a stream to completion so the middleware (registered before `client.send`)
 * is captured even though the mocked `send()` rejects. Errors are swallowed because
 * the rejecting mock is expected — we only care about the recorded registrations.
 */
async function driveBedrock(options: BedrockOptions): Promise<void> {
	await streamBedrock(getModelFixture(), context, options)
		.result()
		.catch(() => undefined);
}

function findCustomHeadersRegistration() {
	const matches = bedrockMock.middlewareRegistrations.filter((r) => r.opts.name === MIDDLEWARE_NAME);
	return matches;
}

beforeEach(() => {
	bedrockMock.middlewareRegistrations.length = 0;
});

describe("bedrock custom headers middleware", () => {
	it("VC1: registers a build-step middleware that injects the caller header (happy path)", async () => {
		await driveBedrock({ cacheRetention: "none", headers: { "x-custom": "v" } });

		const registrations = findCustomHeadersRegistration();
		expect(registrations).toHaveLength(1);

		const [reg] = registrations;
		expect(reg.opts.step).toBe("build");
		expect(reg.opts.priority).toBe("low");
		expect(reg.opts.name).toBe(MIDDLEWARE_NAME);

		const nextSpy = vi.fn(async (a: unknown) => a);
		const fakeArgs = { request: { headers: {} as Record<string, string> } };
		await reg.handler(nextSpy)(fakeArgs);

		expect(fakeArgs.request.headers["x-custom"]).toBe("v");
		expect(nextSpy).toHaveBeenCalledTimes(1);
		expect(nextSpy).toHaveBeenCalledWith(fakeArgs);
	});

	it("VC2: skips reserved headers case-insensitively while applying allowed ones", async () => {
		await driveBedrock({
			cacheRetention: "none",
			headers: {
				authorization: "evil",
				"x-amz-date": "evil",
				"x-allowed": "ok",
				Authorization: "evil2",
				"X-Amz-Date": "evil2",
				HOST: "evil3",
			},
		});

		const [reg] = findCustomHeadersRegistration();
		expect(reg).toBeDefined();

		const nextSpy = vi.fn(async (a: unknown) => a);
		const fakeArgs = {
			request: {
				headers: {
					authorization: "real-auth",
					"x-amz-date": "real-date",
					host: "real-host",
				} as Record<string, string>,
			},
		};
		await reg.handler(nextSpy)(fakeArgs);

		expect(fakeArgs.request.headers.authorization).toBe("real-auth");
		expect(fakeArgs.request.headers["x-amz-date"]).toBe("real-date");
		expect(fakeArgs.request.headers.host).toBe("real-host");
		expect(fakeArgs.request.headers["x-allowed"]).toBe("ok");
		// Mixed-case reserved keys must be skipped too: a case-sensitive guard would
		// add them back as distinct capitalised keys. Assert no such leak occurred and
		// that the only new key beyond the three pre-existing ones is `x-allowed`.
		expect(fakeArgs.request.headers.Authorization).toBeUndefined();
		expect(fakeArgs.request.headers["X-Amz-Date"]).toBeUndefined();
		expect(fakeArgs.request.headers.HOST).toBeUndefined();
		expect(Object.keys(fakeArgs.request.headers).sort()).toEqual(
			["authorization", "host", "x-allowed", "x-amz-date"].sort(),
		);
		expect(nextSpy).toHaveBeenCalledTimes(1);
	});

	it("VC3: registers no middleware when headers is undefined", async () => {
		await driveBedrock({ cacheRetention: "none" });

		expect(findCustomHeadersRegistration()).toHaveLength(0);
	});

	it("VC3: registers no middleware when headers is empty", async () => {
		await driveBedrock({ cacheRetention: "none", headers: {} });

		expect(findCustomHeadersRegistration()).toHaveLength(0);
	});

	it("VC3 (structural guard): passes through unchanged when the request has no headers", async () => {
		await driveBedrock({ cacheRetention: "none", headers: { "x-custom": "v" } });

		const [reg] = findCustomHeadersRegistration();
		expect(reg).toBeDefined();

		const nextSpy = vi.fn(async (a: unknown) => a);

		const argsNoHeaders = { request: {} };
		await expect(reg.handler(nextSpy)(argsNoHeaders)).resolves.toBeDefined();
		expect(nextSpy).toHaveBeenCalledWith(argsNoHeaders);

		const argsUndefinedRequest = { request: undefined };
		await expect(reg.handler(nextSpy)(argsUndefinedRequest)).resolves.toBeDefined();
		expect(nextSpy).toHaveBeenCalledWith(argsUndefinedRequest);

		expect(nextSpy).toHaveBeenCalledTimes(2);
	});

	it("VC4: streamSimpleBedrock forwards headers end-to-end (regression guard)", async () => {
		await streamSimpleBedrock(getModelFixture(), context, { headers: { "x-custom": "v" } })
			.result()
			.catch(() => undefined);

		const registrations = findCustomHeadersRegistration();
		expect(registrations).toHaveLength(1);

		const [reg] = registrations;
		expect(reg.opts.step).toBe("build");

		const nextSpy = vi.fn(async (a: unknown) => a);
		const fakeArgs = { request: { headers: {} as Record<string, string> } };
		await reg.handler(nextSpy)(fakeArgs);

		expect(fakeArgs.request.headers["x-custom"]).toBe("v");
	});
});
