import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider, stream } from "../src/index.js";
import type { AssistantMessageEvent, Context, ImageContent } from "../src/types.js";

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("optimizeImage", () => {
	it("transforms images in user messages before sending to provider", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: (_img) => ({
				type: "image",
				data: "BBBB",
				mimeType: "image/jpeg",
			}),
		});

		expect(seenContexts).toHaveLength(1);
		const userMsg = seenContexts[0].messages[0];
		expect(userMsg.role).toBe("user");
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			const imageBlock = userMsg.content.find((c): c is ImageContent => c.type === "image");
			expect(imageBlock).toBeDefined();
			expect(imageBlock!.data).toBe("BBBB");
			expect(imageBlock!.mimeType).toBe("image/jpeg");
		}
	});

	it("transforms images in toolResult messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{ role: "user", content: "run tool", timestamp: Date.now() },
				{
					...fauxAssistantMessage("calling tool"),
					content: [{ type: "toolCall", id: "tc-1", name: "screenshot", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "screenshot",
					content: [
						{ type: "text", text: "screenshot taken" },
						{ type: "image", data: "ORIGINAL", mimeType: "image/png" },
					],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: (_img) => ({
				type: "image",
				data: "COMPRESSED",
				mimeType: "image/jpeg",
			}),
		});

		expect(seenContexts).toHaveLength(1);
		const toolResult = seenContexts[0].messages[2];
		expect(toolResult.role).toBe("toolResult");
		if (toolResult.role === "toolResult") {
			const imageBlock = toolResult.content.find((c): c is ImageContent => c.type === "image");
			expect(imageBlock).toBeDefined();
			expect(imageBlock!.data).toBe("COMPRESSED");
			expect(imageBlock!.mimeType).toBe("image/jpeg");
		}
	});

	it("does not modify context when no optimizeImage is provided", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "ORIGINAL", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context);

		expect(seenContexts).toHaveLength(1);
		const userMsg = seenContexts[0].messages[0];
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			const imageBlock = userMsg.content.find((c): c is ImageContent => c.type === "image");
			expect(imageBlock!.data).toBe("ORIGINAL");
		}
	});

	it("does not modify the original context object", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("ok")]);

		const originalImage: ImageContent = { type: "image", data: "ORIGINAL", mimeType: "image/png" };
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "look" }, originalImage],
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: () => ({ type: "image", data: "CHANGED", mimeType: "image/jpeg" }),
		});

		// Original context must be untouched
		expect(originalImage.data).toBe("ORIGINAL");
		expect(originalImage.mimeType).toBe("image/png");
		const userMsg = context.messages[0];
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			expect(userMsg.content[1]).toBe(originalImage);
		}
	});

	it("supports async optimizeImage callbacks", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "SYNC", mimeType: "image/png" }],
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: async (_img) => {
				await new Promise((r) => setTimeout(r, 10));
				return { type: "image", data: "ASYNC", mimeType: "image/jpeg" };
			},
		});

		const userMsg = seenContexts[0].messages[0];
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			expect((userMsg.content[0] as ImageContent).data).toBe("ASYNC");
		}
	});

	it("skips optimization when no images are present", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		let optimizerCalled = false;
		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [{ role: "user", content: "just text", timestamp: Date.now() }],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: (img) => {
				optimizerCalled = true;
				return img;
			},
		});

		expect(optimizerCalled).toBe(false);
		expect(seenContexts[0].messages[0]).toBe(context.messages[0]);
	});

	it("preserves text blocks alongside optimized images", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						{ type: "image", data: "IMG1", mimeType: "image/png" },
						{ type: "text", text: "second" },
						{ type: "image", data: "IMG2", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		};

		await complete(registration.getModel(), context, {
			optimizeImage: (img) => ({ ...img, data: `${img.data}_OPT`, mimeType: "image/jpeg" }),
		});

		const userMsg = seenContexts[0].messages[0];
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			expect(userMsg.content).toEqual([
				{ type: "text", text: "first" },
				{ type: "image", data: "IMG1_OPT", mimeType: "image/jpeg" },
				{ type: "text", text: "second" },
				{ type: "image", data: "IMG2_OPT", mimeType: "image/jpeg" },
			]);
		}
	});

	it("emits error event when optimizeImage throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("should not reach")]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "BAD", mimeType: "image/png" }],
					timestamp: Date.now(),
				},
			],
		};

		const events = await collectEvents(
			stream(registration.getModel(), context, {
				optimizeImage: () => {
					throw new Error("compression failed");
				},
			}),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].error.errorMessage).toContain("compression failed");
		}
	});

	it("works with streamSimple via completeSimple path", async () => {
		const { completeSimple } = await import("../src/stream.js");
		const registration = registerFauxProvider();
		registrations.push(registration);

		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("ok");
			},
		]);

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "RAW", mimeType: "image/png" }],
					timestamp: Date.now(),
				},
			],
		};

		await completeSimple(registration.getModel(), context, {
			optimizeImage: (_img) => ({ type: "image", data: "OPTIMIZED", mimeType: "image/jpeg" }),
		});

		const userMsg = seenContexts[0].messages[0];
		if (userMsg.role === "user" && Array.isArray(userMsg.content)) {
			expect((userMsg.content[0] as ImageContent).data).toBe("OPTIMIZED");
		}
	});
});
