import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const normalizeToolResultImages = vi.hoisted(() => vi.fn(async (content: unknown[]) => content));
vi.mock("../../src/utils/tool-result-images.ts", () => ({ normalizeToolResultImages }));

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const screenshotTool: AgentTool = {
	name: "screenshot",
	label: "Screenshot",
	description: "Return a screenshot",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [
			{ type: "text", text: "captured" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		],
		details: {},
	}),
};

describe("AgentSession tool result images", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		normalizeToolResultImages.mockClear();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("passes images.autoResize to tool result normalization", async () => {
		const harness = await createHarness({
			tools: [screenshotTool],
			settings: { images: { autoResize: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("screenshot", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("take a screenshot");

		expect(normalizeToolResultImages).toHaveBeenCalledWith(expect.any(Array), { autoResizeImages: false });
	});
});
