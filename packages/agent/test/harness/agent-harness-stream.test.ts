import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessOptions } from "../../src/harness/types.ts";
import { calculateTool } from "../utils/calculate.ts";

/** Shared collection; each faux provider gets a unique id so coexisting fakes route correctly. */
const models = createModels();
let fauxCount = 0;

function newFaux(): FauxProviderHandle {
	const faux = fauxProvider({ provider: `faux-${++fauxCount}` });
	models.setProvider(faux.provider);
	return faux;
}

function createHarness(options: AgentHarnessOptions): AgentHarness {
	return new AgentHarness(options);
}

function captureOptions(options: StreamOptions | undefined): StreamOptions {
	return {
		...options,
		headers: options?.headers ? { ...options.headers } : undefined,
		metadata: options?.metadata ? { ...options.metadata } : undefined,
	};
}

describe("AgentHarness stream configuration", () => {
	it("snapshots stream options before provider request hooks", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const session = new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
		const harness = createHarness({
			models,
			session,
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				maxRetryDelayMs: 3000,
				headers: { "x-base": "base" },
				metadata: { base: true },
				cacheRetention: "none",
			},
		});

		harness.on("before_provider_request", (event) => {
			expect(event.sessionId).toBe("session-1");
			expect(event.streamOptions.headers).toEqual({ "x-base": "base" });
			return {
				streamOptions: {
					headers: { "x-hook": "hook" },
					metadata: { hook: true },
				},
			};
		});

		await harness.prompt("hello");

		expect(capturedOptions).toMatchObject({
			timeoutMs: 1000,
			maxRetries: 2,
			maxRetryDelayMs: 3000,
			sessionId: "session-1",
			cacheRetention: "none",
		});
		expect(capturedOptions?.headers).toEqual({ "x-base": "base", "x-hook": "hook" });
		expect(capturedOptions?.metadata).toEqual({ base: true, hook: true });
	});

	it("chains provider request patches and supports deletion semantics", async () => {
		let capturedOptions: StreamOptions | undefined;
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				headers: { keep: "base", remove: "base" },
				metadata: { keep: "base", remove: "base" },
			},
		});

		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", remove: "base" });
			return {
				streamOptions: {
					headers: { first: "1", remove: undefined },
					metadata: { first: 1, remove: undefined },
				},
			};
		});
		harness.on("before_provider_request", (event) => {
			expect(event.streamOptions.headers).toEqual({ keep: "base", first: "1" });
			expect(event.streamOptions.metadata).toEqual({ keep: "base", first: 1 });
			return {
				streamOptions: {
					timeoutMs: undefined,
					headers: { second: "2" },
					metadata: undefined,
				},
			};
		});

		await harness.prompt("hello");

		expect(capturedOptions?.timeoutMs).toBeUndefined();
		expect(capturedOptions?.maxRetries).toBe(2);
		expect(capturedOptions?.headers).toEqual({ keep: "base", first: "1", second: "2" });
		expect(capturedOptions?.metadata).toBeUndefined();
	});

	it("uses updated stream options for save-point snapshots without mutating the active request", async () => {
		const capturedOptions: StreamOptions[] = [];
		const registration = newFaux();
		registration.setResponses([
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) => {
				capturedOptions.push(captureOptions(options));
				return fauxAssistantMessage("done");
			},
		]);

		const harness = createHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
			streamOptions: { timeoutMs: 1000, headers: { turn: "first" } },
		});

		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				harness.setStreamOptions({ timeoutMs: 2000, headers: { turn: "second" } });
			}
		});

		await harness.prompt("hello");

		expect(capturedOptions).toHaveLength(2);
		expect(capturedOptions[0].timeoutMs).toBe(1000);
		expect(capturedOptions[0].headers).toEqual({ turn: "first" });
		expect(capturedOptions[1].timeoutMs).toBe(2000);
		expect(capturedOptions[1].headers).toEqual({ turn: "second" });
	});

	it("chains provider payload hooks", async () => {
		const seenPayloads: unknown[] = [];
		let finalPayload: unknown;
		const registration = newFaux();
		registration.setResponses([
			async (_context, options, _state, model) => {
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);

		const harness = createHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});

		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first"] } };
		});
		harness.on("before_provider_payload", (event) => {
			seenPayloads.push(event.payload);
			return { payload: { steps: ["provider", "first", "second"] } };
		});

		await harness.prompt("hello");

		expect(seenPayloads).toEqual([{ steps: ["provider"] }, { steps: ["provider", "first"] }]);
		expect(finalPayload).toEqual({ steps: ["provider", "first", "second"] });
	});
});
