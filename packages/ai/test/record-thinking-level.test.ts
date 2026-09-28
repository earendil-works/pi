import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "../src/compat.ts";
import { createModels } from "../src/models.ts";
import { fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEventStream, Context } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

/** Thinking levels on every emitted message and on the result. */
async function recordedLevels(stream: AssistantMessageEventStream) {
	const messages: AssistantMessage[] = [];
	for await (const event of stream) {
		messages.push(event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial);
	}
	return {
		events: new Set(messages.map((message) => message.thinkingLevel)),
		result: (await stream.result()).thinkingLevel,
	};
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

describe("thinkingLevel on assistant messages", () => {
	it("records the clamped requested level for Models.streamSimple and only for simple requests", async () => {
		const faux = fauxProvider({ models: [{ id: "reasoner", reasoning: true }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel()!;
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);

		// The faux model supports up to "high", so "max" clamps down.
		expect(await recordedLevels(models.streamSimple(model, context, { reasoning: "max" }))).toEqual({
			events: new Set(["high"]),
			result: "high",
		});
		// Unset reasoning requests "off".
		expect(await recordedLevels(models.streamSimple(model, context))).toEqual({
			events: new Set(["off"]),
			result: "off",
		});
		// stream() takes provider-native options, so no Pi level exists.
		expect((await models.stream(model, context).result()).thinkingLevel).toBeUndefined();
	});

	it("records the level for the compat streamSimple", async () => {
		const registration = registerFauxProvider({ models: [{ id: "reasoner", reasoning: true }] });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("a")]);

		expect(await recordedLevels(streamSimple(registration.getModel(), context, { reasoning: "low" }))).toEqual({
			events: new Set(["low"]),
			result: "low",
		});
	});
});
