// `fitImage`, `fitImages` and the `fit-images` extension (src/images/fit.ts): images fitted to the model's limits as
// they enter a conversation, before they are stored.
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	defineTool,
	type HookApi,
	MemoryStorage,
	type TaskId,
	type ToolExecutionResult,
	type ToolHookCall,
	type ToolHooks,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createFitImagesExtension, fitImage, fitImages } from "@earendil-works/pi-durable/images/fit";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { obj } from "@earendil-works/pi-schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
	toBase64,
} from "../src/tools/image-processor.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { bmp, decodedImage, encode, initPhoton, noisyPng, withOrientation } from "./image-fixtures.ts";
import { context } from "./session-support.ts";

let photon: ImageProcessor;

beforeAll(async () => {
	initPhoton();
	photon = await createNodePhotonImages();
});

/** `photon`, with the type of every `prepare` call recorded. */
function recorded(): { readonly processor: ImageProcessor; readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		processor: {
			prepare: (bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined> => {
				calls.push(mimeType);
				return photon.prepare(bytes, mimeType, limits);
			},
		},
	};
}

function image(bytes: Uint8Array, mimeType: string): ImageContent {
	return { type: "image", data: toBase64(bytes), mimeType };
}

/** The single image `fitImages` made of `content`, with its notes. */
async function fitOne(item: ImageContent, limits: ImageLimits = DEFAULT_IMAGE_LIMITS) {
	const fitted = await fitImages([item], limits, photon);
	if (fitted.kind !== "fitted") throw new Error("the image was not changed");
	return { image: fitted.content[0] as ImageContent | undefined, notes: fitted.notes };
}

describe("fitImage", () => {
	it("prepares an image from its bytes, as base64 for the model", async () => {
		const png = encode(8, 6, "png");
		expect(await fitImage(png, "image/png", DEFAULT_IMAGE_LIMITS, photon)).toEqual({
			kind: "fitted",
			image: image(png, "image/png"),
			notes: [],
		});
	});

	it("leaves out an image the processor fails on, with the failure in its note", async () => {
		const failing: ImageProcessor = {
			prepare: async () => {
				throw new Error("worker exited");
			},
		};
		expect(await fitImage(encode(8, 6, "png"), "image/png", DEFAULT_IMAGE_LIMITS, failing)).toEqual({
			kind: "omitted",
			note: "An image (image/png) cannot be prepared for the model and was left out: worker exited.",
		});
	});
});

describe("fitImages", () => {
	it("is unchanged when every image comes back as it was, and asks the processor only about images", async () => {
		const { processor, calls } = recorded();
		const content = [{ type: "text", text: "a" } as const, image(encode(8, 6, "png"), "image/png")];
		expect(await fitImages(content, DEFAULT_IMAGE_LIMITS, processor)).toEqual({ kind: "unchanged" });
		expect(calls).toEqual(["image/png"]);
		expect(await fitImages([{ type: "text", text: "only text" }], DEFAULT_IMAGE_LIMITS, processor)).toEqual({
			kind: "unchanged",
		});
		expect(calls).toEqual(["image/png"]);
	});

	it("scales an image beyond the limits down, keeps the text in place, and says how to map coordinates back", async () => {
		const text: TextContent = { type: "text", text: "before" };
		const fitted = await fitImages(
			[text, image(encode(400, 100, "png"), "image/png"), { type: "text", text: "after" }],
			{ ...DEFAULT_IMAGE_LIMITS, maxWidth: 200 },
			photon,
		);
		expect(fitted.kind).toBe("fitted");
		if (fitted.kind !== "fitted") return;
		expect(fitted.content.map((item) => item.type)).toEqual(["text", "image", "text"]);
		expect(fitted.content[0]).toBe(text);
		expect(decodedImage((fitted.content[1] as ImageContent).data)).toMatchObject({ width: 200, height: 50 });
		expect(fitted.notes).toEqual([
			"Resized from 400x100 to 200x50. Multiply coordinates by 2.00 to map them to the original.",
		]);
	});

	it("re-encodes an image within the dimensions but over the byte limit", async () => {
		const limits = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 8_000 };
		const { image: fitted, notes } = await fitOne(image(noisyPng(64, 64), "image/png"), limits);
		expect(fitted!.data.length).toBeLessThanOrEqual(limits.maxBytes);
		expect(notes.length).toBeGreaterThan(0);
	});

	it("turns an image upright that fits but carries an EXIF orientation", async () => {
		const { image: fitted } = await fitOne(image(withOrientation(encode(40, 30, "jpeg"), 6), "image/jpeg"));
		expect(decodedImage(fitted!.data)).toMatchObject({ width: 30, height: 40 });
	});

	it("converts a format providers do not take inline to PNG", async () => {
		const { image: fitted, notes } = await fitOne(image(bmp(4, 4), "image/bmp"));
		expect(fitted?.mimeType).toBe("image/png");
		expect(notes).toEqual(["Converted from image/bmp to image/png."]);
	});

	it("corrects a declared type the bytes contradict, without a note", async () => {
		const jpeg = encode(8, 6, "jpeg");
		expect(await fitOne(image(jpeg, "image/png"))).toEqual({ image: image(jpeg, "image/jpeg"), notes: [] });
	});

	it("leaves out what cannot be prepared, with a note: damaged images, other bytes, malformed base64", async () => {
		const note = "An image (image/png) cannot be prepared for the model and was left out.";
		const damaged = encode(4, 4, "png").subarray(0, 40);
		expect(
			await fitImages([{ type: "text", text: "a" }, image(damaged, "image/png")], DEFAULT_IMAGE_LIMITS, photon),
		).toEqual({ kind: "fitted", content: [{ type: "text", text: "a" }], notes: [note] });
		const text = new TextEncoder().encode("not an image at all, though it says so");
		expect(await fitOne(image(text, "image/png"))).toEqual({ image: undefined, notes: [note] });
		const malformed = await fitOne({ type: "image", data: "%%%", mimeType: "image/png" });
		expect(malformed.image).toBeUndefined();
		expect(malformed.notes[0]).toMatch(
			/^An image \(image\/png\) cannot be prepared for the model and was left out: /,
		);
	});
});

describe("the fit-images extension", () => {
	it("fits a tool result's images to the conversation model's limits before it is committed", async () => {
		const setup = chatSetup({
			models: [{ id: "faux-1", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 100 } } } }],
		});
		setup.registry.install(createFitImagesExtension(photon));
		const small = image(encode(8, 6, "png"), "image/png");
		addTool(
			setup.registry,
			defineTool({
				name: "picture",
				description: "A picture",
				parameters: obj({}),
				execute: async (_args, api) => {
					if (api.callId === "small") return { output: [small] };
					return {
						output: [{ type: "text", text: "here" }, image(encode(400, 100, "png"), "image/png")],
						diagnostics: [{ severity: "info", message: "the tool's own" }],
					};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("picture", {}, { id: "wide" }), fauxToolCall("picture", {}, { id: "small" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		await (await root.submit({ type: "input", content: "show" }, context)).wait(context);
		const stored = new Map(
			(await allEntries(root))
				.filter((each) => ToolResultEntry.is(each))
				.map((each) => each.model![0] as ToolResultMessage)
				.map((message) => [message.toolCallId, message.content]),
		);
		const wide = stored.get("wide")!;
		expect(wide[0]).toEqual({ type: "text", text: "here" });
		expect(decodedImage((wide[1] as ImageContent).data)).toMatchObject({ width: 100, height: 25 });
		expect(wide[2]).toEqual({
			type: "text",
			text: "<harness>\n[info] the tool's own\n[info] Resized from 400x100 to 100x25. Multiply coordinates by 4.00 to map them to the original.\n</harness>",
		});
		// An image that fits is stored as the tool made it, without a note.
		expect(stored.get("small")).toEqual([small]);
		await harness.close(context);
	});

	it("leaves nested calls' results to the program that made them", async () => {
		const [registration] = createFitImagesExtension(photon).hooks!;
		expect(registration!.task).toBe(ToolTask.definition.name);
		// The handlers of a `ToolTask` hook registration.
		const { afterTool } = registration!.handlers as Pick<ToolHooks, "afterTool">;
		const result: ToolExecutionResult = { output: [image(encode(4000, 10, "png"), "image/png")] };
		const call: ToolHookCall = {
			type: "toolCall",
			id: "n",
			name: "picture",
			arguments: {},
			parent: { taskId: 1 as TaskId, callId: "c" },
		};
		// A nested result is not looked at: the hook API, empty here, is never touched.
		expect(await afterTool(call, result, {} as HookApi, context)).toBeUndefined();
	});
});
