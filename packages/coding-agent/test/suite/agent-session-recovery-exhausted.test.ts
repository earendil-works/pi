import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentRecoveryExhaustedEvent,
	type ExtensionAPI,
	MAX_AGENT_RECOVERY_EXHAUSTED_CONTINUATIONS,
} from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function historyAssistants(harness: Harness): AssistantMessage[] {
	return harness.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			return [];
		}
		return [entry.message];
	});
}

function activeAssistants(harness: Harness): AssistantMessage[] {
	return harness.session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

describe("AgentSession agent_recovery_exhausted", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("advertises the hook on pi.features as an own enumerable true flag", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);

		expect(api?.features).toEqual({ agent_recovery_exhausted: true });
		expect(Object.isFrozen(api?.features)).toBe(true);
		const descriptor = Object.getOwnPropertyDescriptor(api?.features, "agent_recovery_exhausted");
		expect(descriptor).toMatchObject({ enumerable: true, value: true });
	});

	it("fires after native retry exhaustion and continues when a handler returns retry", async () => {
		const payloads: AgentRecoveryExhaustedEvent[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async (event) => {
						payloads.push(event);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered after hook"),
		]);

		await harness.session.prompt("test");

		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.nativeRetryAttempts).toBe(2);
		expect(payloads[0]?.overflowRecoveryAttempted).toBe(false);
		expect(payloads[0]?.message.stopReason).toBe("error");
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.getLastAssistantText()).toBe("recovered after hook");
		expect(activeAssistants(harness).map((message) => message.stopReason)).toEqual(["stop"]);
		expect(historyAssistants(harness).map((message) => message.stopReason)).toEqual([
			"error",
			"error",
			"error",
			"stop",
		]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("fires after failed overflow recovery for a truncated response", async () => {
		const payloads: AgentRecoveryExhaustedEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("agent_recovery_exhausted", async (event) => {
						payloads.push(event);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			fauxAssistantMessage("recovered on larger path"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.overflowRecoveryAttempted).toBe(true);
		expect(payloads[0]?.message.stopReason).toBe("length");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("recovered on larger path");
		expect(activeAssistants(harness).at(-1)?.stopReason).toBe("stop");
		expect(historyAssistants(harness).some((message) => message.stopReason === "length")).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not fire on success, abort, or mid-ladder retry", async () => {
		const successFires: number[] = [];
		const success = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						successFires.push(1);
					});
				},
			],
		});
		harnesses.push(success);
		success.setResponses([fauxAssistantMessage("ok")]);
		await success.session.prompt("hi");
		expect(successFires).toEqual([]);
		expect(success.eventsOfType("agent_settled")).toHaveLength(1);

		const midLadderFires: number[] = [];
		const midLadder = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						midLadderFires.push(1);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(midLadder);
		midLadder.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered natively"),
		]);
		await midLadder.session.prompt("hi");
		expect(midLadderFires).toEqual([]);
		expect(midLadder.faux.state.callCount).toBe(2);
		expect(midLadder.session.getLastAssistantText()).toBe("recovered natively");

		const abortFires: number[] = [];
		const aborted = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						abortFires.push(1);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(aborted);
		aborted.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = aborted.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = aborted.session.prompt("hi");
		await sawMessageUpdate;
		await aborted.session.abort();
		await promptPromise;
		expect(abortFires).toEqual([]);
		expect(aborted.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not fire after abortRetry cancels native retry sleep", async () => {
		const fires: number[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						fires.push(1);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("should not run"),
		]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("test");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(fires).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("ignores retry when the handler aborts the prompt signal", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async (event, ctx) => {
						ctx.abort();
						expect(event.signal.aborted).toBe(true);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("treats a thrown handler as no vote and still honors a later retry", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				{
					path: "<inline:throws>",
					factory: (pi) => {
						pi.on("agent_recovery_exhausted", async () => {
							order.push("throw");
							throw new Error("handler failed");
						});
					},
				},
				{
					path: "<inline:retry>",
					factory: (pi) => {
						pi.on("agent_recovery_exhausted", async () => {
							order.push("retry");
							return { retry: true };
						});
					},
				},
				{
					path: "<inline:decline>",
					factory: (pi) => {
						pi.on("agent_recovery_exhausted", async () => {
							order.push("decline");
							return { retry: false };
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("continued after throw"),
		]);

		await harness.session.prompt("test");

		expect(order).toEqual(["throw", "retry", "decline"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("continued after throw");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("caps hook-driven continuations at 8 and settles exactly once", async () => {
		const fires: number[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						fires.push(1);
						return { retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: MAX_AGENT_RECOVERY_EXHAUSTED_CONTINUATIONS + 2 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			),
		);

		await harness.session.prompt("test");

		expect(fires).toHaveLength(MAX_AGENT_RECOVERY_EXHAUSTED_CONTINUATIONS);
		expect(harness.faux.state.callCount).toBe(MAX_AGENT_RECOVERY_EXHAUSTED_CONTINUATIONS + 1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(activeAssistants(harness).at(-1)?.stopReason).toBe("error");
	});

	it("settles exactly once when the handler declines", async () => {
		const fires: number[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_recovery_exhausted", async () => {
						fires.push(1);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("test");

		expect(fires).toEqual([1]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
