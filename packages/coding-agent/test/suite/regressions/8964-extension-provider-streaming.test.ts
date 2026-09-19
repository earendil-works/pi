import { type AssistantMessage, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// Regression for #8964: extensions can stream responses from providers registered with pi.registerProvider().
it.each(["stream", "streamSimple"] as const)(
	"allows an extension command to use ctx.modelRegistry.%s",
	async (method) => {
		const faux = fauxProvider({ provider: "extension-provider", api: "issue-8964-extension-api" });
		let receivedApiKey: string | undefined;
		faux.setResponses([
			(_context, options) => {
				receivedApiKey = options?.apiKey;
				return fauxAssistantMessage("custom provider response");
			},
		]);
		let streamedText = "";
		let result: AssistantMessage | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider.id, {
						api: faux.api,
						baseUrl: faux.getModel().baseUrl,
						apiKey: "extension-key",
						models: faux.models,
						streamSimple: faux.provider.streamSimple,
					});
				},
				(pi) => {
					pi.registerCommand("stream-custom", {
						description: "Stream a response from the custom provider",
						handler: async (_args, ctx) => {
							const model = ctx.modelRegistry.find(faux.provider.id, faux.getModel().id)!;
							const stream = ctx.modelRegistry[method](model, {
								messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
							});
							for await (const event of stream) {
								if (event.type === "text_delta") streamedText += event.delta;
							}
							result = await stream.result();
						},
					});
				},
			],
		});
		try {
			expect(getApiProvider(faux.api)).toBeUndefined();
			await harness.session.prompt("/stream-custom");

			expect(receivedApiKey).toBe("extension-key");
			expect(streamedText).toBe("custom provider response");
			expect(result).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "custom provider response" }],
			});
			expect(getApiProvider(faux.api)).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	},
);
