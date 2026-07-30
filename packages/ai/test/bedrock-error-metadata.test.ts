import { beforeEach, describe, expect, it, vi } from "vitest";

type SendResult = { kind: "reject"; error: unknown } | { kind: "resolve"; response: unknown };

const bedrockMock = vi.hoisted(() => ({
	send: undefined as SendResult | undefined,
	// Exposed so tests can build errors that are real instances of the mocked base class.
	ServiceException: undefined as unknown as new (message?: string) => Error,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	bedrockMock.ServiceException = BedrockRuntimeServiceException;

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<unknown> {
			const outcome = bedrockMock.send;
			if (!outcome) return Promise.reject(new Error("test did not configure a send outcome"));
			return outcome.kind === "reject" ? Promise.reject(outcome.error) : Promise.resolve(outcome.response);
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

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import type { AssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";

const DIAGNOSTIC_TYPE = "bedrock_response_failure";
const VALIDATION_MESSAGE = "The provided model identifier is invalid.";
const REQUEST_ID = "11111111-2222-3333-4444-555555555555";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getModelFixture(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
}

/** What the SDK's `handleError` path throws for a non-2xx response; `name` is the modeled AWS error code. */
function makeServiceException(name: string, extra: Record<string, unknown> = {}): Error {
	const error = new bedrockMock.ServiceException(VALIDATION_MESSAGE) as Error & Record<string, unknown>;
	error.name = name;
	Object.assign(error, extra);
	return error;
}

/** Fails after `messageStart`, throwing from inside the iterator like `getMessageUnmarshaller` does. */
function respondWithFailingStream(thrown: unknown): SendResult {
	return {
		kind: "resolve",
		response: {
			$metadata: { httpStatusCode: 200, requestId: REQUEST_ID },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				throw thrown;
			})(),
		},
	};
}

async function runBedrock(signal?: AbortSignal): Promise<AssistantMessage> {
	return streamBedrock(getModelFixture(), context, { cacheRetention: "none", signal }).result();
}

function findDiagnostic(message: AssistantMessage): AssistantMessageDiagnostic | undefined {
	return message.diagnostics?.find((d) => d.type === DIAGNOSTIC_TYPE);
}

beforeEach(() => {
	bedrockMock.send = undefined;
});

describe("bedrock failure diagnostics", () => {
	it("records status, error code and request id for a non-2xx from client.send()", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", {
				$metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
			}),
		};

		const message = await runBedrock();
		const diagnostic = findDiagnostic(message);

		expect(message.stopReason).toBe("error");
		expect(diagnostic?.details).toEqual({ status: 400, errorCode: "ValidationException", requestId: REQUEST_ID });
		expect(diagnostic?.error).toBeUndefined();
		expect(Object.keys(diagnostic ?? {}).sort()).toEqual(["details", "timestamp", "type"]);
	});

	it("leaves errorMessage untouched so retry classification is unaffected", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", {
				$metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
				$response: { body: { pipe: () => {} } },
			}),
		};

		expect((await runBedrock()).errorMessage).toBe(`Validation error: ${VALIDATION_MESSAGE}`);
	});

	it("reports only the request id for a modeled mid-stream exception", async () => {
		// The SDK throws a bare object literal here, so the code is genuinely unavailable.
		bedrockMock.send = respondWithFailingStream({ message: "Too many requests, please wait." });

		const message = await runBedrock();

		expect(message.stopReason).toBe("error");
		expect(findDiagnostic(message)?.details).toEqual({ requestId: REQUEST_ID });
	});

	it("captures the error code for an unmodeled mid-stream error", async () => {
		// This branch throws a real `Error` named after the frame's `:error-code`.
		const unmodeled = new Error("Model stream terminated unexpectedly.");
		unmodeled.name = "ModelStreamErrorException";
		bedrockMock.send = respondWithFailingStream(unmodeled);

		expect(findDiagnostic(await runBedrock())?.details).toEqual({
			errorCode: "ModelStreamErrorException",
			requestId: REQUEST_ID,
		});
	});

	it("does not report a transport failure name as a provider error code", async () => {
		// Real `Error`s with informative names, but not AWS codes; modeled ones end in "Exception".
		const timeout = new Error("Connection timed out after 1000 ms");
		timeout.name = "TimeoutError";
		bedrockMock.send = respondWithFailingStream(timeout);

		expect(findDiagnostic(await runBedrock())?.details).toEqual({ requestId: REQUEST_ID });
	});

	it("emits no diagnostic when the failure carries no provider metadata", async () => {
		bedrockMock.send = { kind: "reject", error: new Error("socket hang up") };

		const message = await runBedrock();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("socket hang up");
		expect(findDiagnostic(message)).toBeUndefined();
	});

	it("emits no diagnostic for an aborted turn", async () => {
		const controller = new AbortController();
		controller.abort();
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", {
				$metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
			}),
		};

		const message = await runBedrock(controller.signal);

		expect(message.stopReason).toBe("aborted");
		expect(findDiagnostic(message)).toBeUndefined();
	});

	it("drops header-derived values that exceed the length bound", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException(`${"E".repeat(5000)}Exception`, {
				$metadata: { httpStatusCode: 400, requestId: "R".repeat(5000) },
			}),
		};

		expect(findDiagnostic(await runBedrock())?.details).toEqual({ status: 400 });
	});

	it("omits the SDK's Unknown placeholder instead of reporting it as a code", async () => {
		// The SDK's fallback when the response carried no `x-amzn-errortype`.
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("Unknown", { $metadata: { httpStatusCode: 403, requestId: REQUEST_ID } }),
		};

		expect(findDiagnostic(await runBedrock())?.details).toEqual({
			status: 403,
			requestId: REQUEST_ID,
		});
	});
});
