// Images fitted to the model's limits before they are stored, so the transcript (and the provider's prompt cache) never
// changes later: a host fits the photo a person attaches with `fitImage` before it submits the message, and the
// `fit-images` extension fits a screenshot a tool returns before its result is committed. The model takes images up to
// 1000 pixels wide here.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/47-fit-images.ts
import { deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import { createFitImagesExtension, fitImage } from "../../src/images/fit.ts";
import { createNodePhotonImages } from "../../src/images/node.ts";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, UserEntry } from "../../src/index.ts";
import { imageLimits } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

/** A `width` by `height` grey PNG, enough to show sizes. */
function greyPng(width: number, height: number): Uint8Array {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Uint8Array) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		out.set(body, 4);
		view.setUint32(8 + data.length, crc(body));
		return out;
	};
	const header = new Uint8Array(13);
	new DataView(header.buffer).setUint32(0, width);
	new DataView(header.buffer).setUint32(4, height);
	header[8] = 8;
	const rows = new Uint8Array((width + 1) * height).fill(128);
	for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const chunks = [chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())];
	return new Uint8Array([...signature, ...chunks.flatMap((each) => [...each])]);
}

/** A PNG image block's size, from its header. */
function size(image: ImageContent): string {
	const view = new DataView(Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)).buffer);
	return `${view.getUint32(16)}x${view.getUint32(20)} ${image.mimeType}`;
}

// The faux provider plays a model whose images may be at most 1000 pixels wide: it asks for a screenshot, then answers.
const faux = fauxProvider({
	models: [{ id: "faux-1", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 1000 } } } }],
});
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("screenshot", {}, { id: "s" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("Both look grey.")]),
]);

// One processor (Photon, in a worker thread) for the extension and the host's own input.
const images = await createNodePhotonImages();
const screenshot = defineTool({
	name: "screenshot",
	description: "Take a screenshot",
	parameters: obj({}),
	execute: async () => ({
		output: [{ type: "image", data: Buffer.from(greyPng(3000, 1000)).toString("base64"), mimeType: "image/png" }],
	}),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "screen", tools: [screenshot] }));
registry.install(createFitImagesExtension(images));

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// The host fits the attached photo to the conversation model's limits before it submits the message.
const model = models.getModel("faux", "faux-1");
const photo = await fitImage(greyPng(4000, 3000), "image/png", imageLimits(model), images);
if (photo.kind === "omitted") throw new Error(photo.note);
const text = ["Compare this photo with the screen.", ...photo.notes].join("\n");
const settled = await (
	await root.submit({ type: "input", content: [{ type: "text", text }, photo.image] }, context)
).wait(context);
console.log("status:", settled.status);

// What the transcript holds, and so what every later request replays.
for (const entry of [...(await root.entries({}, 20, undefined, context)).items].reverse()) {
	const message = entry.model?.[0];
	if (UserEntry.is(entry)) {
		const content = (message as UserMessage).content;
		if (typeof content === "string") continue;
		for (const item of content) console.log("user:", item.type === "image" ? size(item) : JSON.stringify(item.text));
	}
	if (message?.role === "toolResult") {
		for (const item of (message as ToolResultMessage).content)
			console.log("tool result:", item.type === "image" ? size(item) : JSON.stringify(item.text));
	}
}
await harness.close(context);
