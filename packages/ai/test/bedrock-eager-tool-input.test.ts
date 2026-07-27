import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, Tool } from "../src/types.ts";

// Anthropic buffers the entire toolUse input block server-side by default:
// a large tool call produces minutes of zero stream events, then one burst.
// The fine-grained tool streaming beta streams input as generated. These pin
// that the Bedrock provider requests it for Anthropic models with tools —
// mirroring the eager input streaming the Anthropic Messages provider sends.
const FINE_GRAINED_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_BETA = "interleaved-thinking-2025-05-14";

interface CapturedPayload {
	toolConfig?: unknown;
	additionalModelRequestFields?: {
		thinking?: { type: string };
		anthropic_beta?: string[];
	};
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

function makeContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: BedrockOptions,
): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const s = streamBedrock(model, context, {
		...options,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

function opus48(): Model<"bedrock-converse-stream"> {
	const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
	return {
		...baseModel,
		id: "global.anthropic.claude-opus-4-8-v1",
		name: "Claude Opus 4.8 (Global)",
	};
}

describe("Bedrock eager tool input streaming", () => {
	it("requests the fine-grained tool streaming beta for an Anthropic model with tools", async () => {
		const payload = await capturePayload(opus48(), makeContext());

		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([FINE_GRAINED_BETA]);
	});

	it("does not request the beta without tools", async () => {
		const payload = await capturePayload(opus48(), makeContext([]));

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("does not request the beta when toolChoice is none (tools are dropped)", async () => {
		const payload = await capturePayload(opus48(), makeContext(), { toolChoice: "none" });

		expect(payload.toolConfig).toBeUndefined();
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("honors compat.supportsEagerToolInputStreaming: false", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...opus48(),
			compat: { supportsEagerToolInputStreaming: false },
		};
		const payload = await capturePayload(model, makeContext());

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("appends to the interleaved-thinking beta on non-adaptive models instead of replacing it", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
			name: "Claude Sonnet 4",
		};
		const payload = await capturePayload(model, makeContext(), { reasoning: "high" });

		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([INTERLEAVED_BETA, FINE_GRAINED_BETA]);
	});

	it("keeps reasoning-only payloads unchanged on non-adaptive models (interleaved beta only)", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
			name: "Claude Sonnet 4",
		};
		const payload = await capturePayload(model, makeContext([]), { reasoning: "high" });

		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([INTERLEAVED_BETA]);
		expect(payload.additionalModelRequestFields?.thinking).toBeDefined();
	});

	it("sends no additionalModelRequestFields for non-Anthropic models even with tools", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us.meta.llama3-3-70b-instruct-v1:0",
			name: "Llama 3.3 70B",
			reasoning: false,
		};
		const payload = await capturePayload(model, makeContext());

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});
});
