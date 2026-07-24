import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentTurnResult,
	type ExtensionCapabilities,
	TURN_PREFLIGHT_CANCELLATION_ENTRY_TYPE,
} from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession turn preflight", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preflights idle custom-triggered turns without changing trigger provenance", async () => {
		let triggerMessage: AgentMessage | undefined;
		let triggerText = "";
		let providerCalls = 0;
		let providerTexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						triggerMessage = event.triggerMessage;
						triggerText = event.prompt;
						return {
							message: {
								customType: "identity",
								content: "injected identity",
								display: false,
								details: { source: "preflight" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerCalls += 1;
				providerTexts = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("done");
			},
		]);

		const result: AgentTurnResult = await harness.session.sendCustomMessage(
			{
				customType: "external-trigger",
				content: "wake up",
				display: true,
				details: { origin: "test", sequence: 7 },
			},
			{ triggerTurn: true },
		);

		expect(result).toEqual({ cancelled: false });
		expect(providerCalls).toBe(1);
		expect(triggerText).toBe("wake up");
		expect(providerTexts).toEqual(expect.arrayContaining(["wake up", "injected identity"]));
		expect(triggerMessage).toMatchObject({
			role: "custom",
			customType: "external-trigger",
			content: "wake up",
			display: true,
			details: { origin: "test", sequence: 7 },
		});
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([
			expect.objectContaining({
				role: "custom",
				customType: "external-trigger",
				content: "wake up",
				display: true,
				details: { origin: "test", sequence: 7 },
			}),
			expect.objectContaining({
				role: "custom",
				customType: "identity",
				content: "injected identity",
				display: false,
				details: { source: "preflight" },
			}),
		]);
	});

	it("persists custom-trigger cancellation provenance without invoking the provider", async () => {
		let preflightCalls = 0;
		let laterHandlerCalls = 0;
		let providerCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						preflightCalls += 1;
						return { cancel: true, cancelReason: "blocked by test policy" };
					});
					pi.on("before_agent_start", () => {
						laterHandlerCalls += 1;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("should not run");
			},
		]);

		const result: AgentTurnResult = await harness.session.sendCustomMessage(
			{ customType: "external-trigger", content: "blocked", display: true, details: { origin: "test" } },
			{ triggerTurn: true },
		);

		expect(result).toEqual({ cancelled: true, cancelReason: "blocked by test policy" });
		expect(preflightCalls).toBe(1);
		expect(laterHandlerCalls).toBe(0);
		expect(providerCalls).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({
				role: "custom",
				customType: "external-trigger",
				content: "blocked",
				details: { origin: "test" },
			}),
		]);
		expect(harness.eventsOfType("agent_start")).toEqual([]);

		const entries = harness.sessionManager.getEntries();
		const triggerEntry = entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "external-trigger",
		);
		const cancellationEntry = entries.find(
			(entry) => entry.type === "custom" && entry.customType === TURN_PREFLIGHT_CANCELLATION_ENTRY_TYPE,
		);
		expect(triggerEntry).toBeDefined();
		expect(cancellationEntry).toMatchObject({
			type: "custom",
			parentId: triggerEntry?.id,
			data: {
				source: expect.objectContaining({ path: expect.any(String) }),
				cancelReason: "blocked by test policy",
				triggerMessageEntryId: triggerEntry?.id,
			},
		});
	});

	it("allows before_agent_start to cancel an ordinary prompt before provider invocation", async () => {
		let triggerRole: AgentMessage["role"] | undefined;
		let providerCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						triggerRole = event.triggerMessage.role;
						return { cancel: true, cancelReason: "ordinary prompt blocked" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("should not run");
			},
		]);

		await harness.session.prompt("blocked prompt");

		expect(triggerRole).toBe("user");
		expect(providerCalls).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "blocked prompt" }] }),
		]);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		const entries = harness.sessionManager.getEntries();
		const triggerEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: TURN_PREFLIGHT_CANCELLATION_ENTRY_TYPE,
				parentId: triggerEntry?.id,
				data: expect.objectContaining({
					cancelReason: "ordinary prompt blocked",
					triggerMessageEntryId: triggerEntry?.id,
				}),
			}),
		);
	});

	it("advertises frozen turn-preflight capabilities to extensions", async () => {
		let capabilities: Readonly<ExtensionCapabilities> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					capabilities = pi.capabilities;
				},
			],
		});
		harnesses.push(harness);

		expect(capabilities).toEqual({ turnPreflight: true });
		expect(Object.isFrozen(capabilities)).toBe(true);
	});

	it("keeps pending next-turn messages queued when an ordinary prompt is cancelled", async () => {
		let cancelNextPrompt = true;
		let providerCalls = 0;
		let providerTexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => (cancelNextPrompt ? { cancel: true } : undefined));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerCalls += 1;
				providerTexts = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.sendCustomMessage(
			{ customType: "queued", content: "queued context", display: false },
			{ deliverAs: "nextTurn" },
		);

		await harness.session.prompt("blocked prompt");
		expect(providerCalls).toBe(0);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "blocked prompt" }] }),
		]);

		cancelNextPrompt = false;
		await harness.session.prompt("allowed prompt");

		expect(providerCalls).toBe(1);
		expect(providerTexts).toEqual(expect.arrayContaining(["blocked prompt", "allowed prompt", "queued context"]));
		expect(harness.session.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "custom", customType: "queued", content: "queued context" }),
			]),
		);
	});

	it("preserves the previous turn system prompt when preflight is cancelled", async () => {
		let providerCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.prompt === "blocked") {
							return { cancel: true };
						}
						return { systemPrompt: "previous turn prompt" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("allowed");
		expect(harness.session.systemPrompt).toBe("previous turn prompt");

		const result = await harness.session.sendCustomMessage(
			{ customType: "external-trigger", content: "blocked", display: false },
			{ triggerTurn: true },
		);

		expect(result).toEqual({
			cancelled: true,
			cancelReason: "Cancelled by before_agent_start handler",
		});
		expect(providerCalls).toBe(1);
		expect(harness.session.systemPrompt).toBe("previous turn prompt");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: TURN_PREFLIGHT_CANCELLATION_ENTRY_TYPE,
				data: expect.objectContaining({
					cancelReason: "Cancelled by before_agent_start handler",
				}),
			}),
		);
	});
});
