// `@earendil-works/pi-durable/images/fit`: images entering a conversation, fitted to its model's limits by any
// `ImageProcessor` before they are stored, so the transcript (and the provider's prompt cache) never changes later: a
// host's input before it is submitted (`fitImage`, `fitImages`), and the results of the model's tool calls
// (`createFitImagesExtension`). Photon is not loaded from here; pass a processor.
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { errorMessage } from "../errors.ts";
import { AgentDoc } from "../harness/agent.ts";
import { defineExtension, hook } from "../harness/define.ts";
import { ToolTask } from "../harness/tool.ts";
import type { Extension, HookApi, ToolExecutionResult, ToolHookCall } from "../harness/types.ts";
import { detectSupportedImageMimeType } from "../tools/image.ts";
import {
	fromBase64,
	type ImageLimits,
	type ImageProcessor,
	imageLimits,
	type PreparedImage,
	preparedNotes,
} from "../tools/image-processor.ts";

/** One image fitted by `fitImage`, with notes for the model saying what changed; or why it was left out. */
export type FittedImage =
	| { readonly kind: "fitted"; readonly image: ImageContent; readonly notes: readonly string[] }
	| { readonly kind: "omitted"; readonly note: string };

/** What `fitImages` did: nothing, or the content with its images fitted and notes for the model. */
export type FittedImages =
	| { readonly kind: "unchanged" }
	| { readonly kind: "fitted"; readonly content: (TextContent | ImageContent)[]; readonly notes: readonly string[] };

/**
 * The image in `bytes`, declared as `mimeType`, prepared by `processor` to fit `limits`. Every image is decoded, as the
 * coding agent's are: one the provider would reject (damaged, or too large) never reaches the transcript, where it would
 * fail every later request. Its type is read from its bytes, since providers reject a declared type that differs. An
 * image the processor cannot prepare, or fails on, is left out with a note.
 */
export async function fitImage(
	bytes: Uint8Array,
	mimeType: string,
	limits: ImageLimits,
	processor: ImageProcessor,
): Promise<FittedImage> {
	let prepared: PreparedImage | undefined;
	try {
		prepared = await processor.prepare(bytes, detectSupportedImageMimeType(bytes) ?? mimeType, limits);
	} catch (error) {
		// The image is known to need preparing: keeping it would commit what the provider rejects. The note carries the
		// failure into the transcript.
		return omitted(mimeType, `: ${errorMessage(error)}`);
	}
	if (prepared === undefined) return omitted(mimeType, "");
	const image: ImageContent = { type: "image", data: prepared.data, mimeType: prepared.mimeType };
	return { kind: "fitted", image, notes: preparedNotes(prepared) };
}

function omitted(mimeType: string, reason: string): FittedImage {
	return {
		kind: "omitted",
		note: `An image (${mimeType}) cannot be prepared for the model and was left out${reason}.`,
	};
}

/**
 * `content` with each image fitted by `fitImage` (malformed base64 is left out as an image that cannot be prepared);
 * text stays where it is. `unchanged` when every image came back as it was.
 */
export async function fitImages(
	content: readonly (TextContent | ImageContent)[],
	limits: ImageLimits,
	processor: ImageProcessor,
): Promise<FittedImages> {
	const fitted: (TextContent | ImageContent)[] = [];
	const notes: string[] = [];
	let changed = false;
	for (const item of content) {
		if (item.type !== "image") {
			fitted.push(item);
			continue;
		}
		const result = await fitBase64(item, limits, processor);
		if (result.kind === "omitted") {
			changed = true;
			notes.push(result.note);
		} else if (result.image.data === item.data && result.image.mimeType === item.mimeType) {
			fitted.push(item);
		} else {
			changed = true;
			fitted.push(result.image);
			notes.push(...result.notes);
		}
	}
	return changed ? { kind: "fitted", content: fitted, notes } : { kind: "unchanged" };
}

async function fitBase64(image: ImageContent, limits: ImageLimits, processor: ImageProcessor): Promise<FittedImage> {
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(image.data);
	} catch (error) {
		// Wire input: a tool's base64 may be malformed.
		return omitted(image.mimeType, `: ${errorMessage(error)}`);
	}
	return fitImage(bytes, image.mimeType, limits, processor);
}

/**
 * The `fit-images` extension: an `afterTool` hook that fits the images of every result the model gets to the
 * conversation model's current limits (`fitImages`) before it is committed, whichever tool made them (an MCP tool, code
 * mode's `image()`), and says what changed in an `info` diagnostic (code `image`). Hooks of extensions installed before
 * it see the images unfitted. Nested calls' results are left as they are: the program that made the call gets them, not
 * the model.
 */
export function createFitImagesExtension(processor: ImageProcessor): Extension {
	return defineExtension({
		name: "fit-images",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result, api, context) => fitResult(call, result, processor, api, context),
			}),
		],
	});
}

async function fitResult(
	call: ToolHookCall,
	result: ToolExecutionResult,
	processor: ImageProcessor,
	api: HookApi,
	context: Context,
): Promise<ToolExecutionResult | undefined> {
	if (call.parent !== undefined || !result.output?.some((item) => item.type === "image")) return undefined;
	const ref = (await api.snapshot(AgentDoc, api.conversationId, context))?.model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const fitted = await fitImages(result.output, imageLimits(model), processor);
	if (fitted.kind === "unchanged") return undefined;
	if (fitted.notes.length === 0) return { ...result, output: fitted.content };
	const note = { severity: "info", code: "image", message: fitted.notes.join(" ") } as const;
	return { ...result, output: fitted.content, diagnostics: [...(result.diagnostics ?? []), note] };
}
