// The chat view's image references (src/runtime/entry-images.ts): image parts become references with their size,
// everything else stays the same object, and clients show both references and inline parts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { entryImageRefs, imageAt, shownImage } from "../../src/runtime/entry-images.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const image: ImageContent = { type: "image", mimeType: "image/png", data: PNG };

const entry = (id: number, model: EntryRecord["model"]): EntryRecord => ({
	id: id as EntryId,
	conversationId: 1 as ConversationId,
	kind: "pi.tool-result",
	...(model === undefined ? {} : { model }),
});

const screenshot = entry(7, [
	{
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: "Read image" }, image],
		isError: false,
		timestamp: 1,
	},
]);

describe("entryImageRefs", () => {
	it("replaces image parts by references with their size, keeping the other parts", () => {
		const shown = entryImageRefs("session-a", 2)(screenshot);
		const message = shown.model?.[0];
		assert(message?.role === "toolResult");
		assert.deepEqual(message.content[0], { type: "text", text: "Read image" });
		assert.deepEqual(message.content[1], {
			type: "image",
			mimeType: "image/png",
			src: "/entry-image?session=session-a&conversation=2&entry=7&message=0&part=1",
			width: 1,
			height: 1,
		});
		assert.equal(JSON.stringify(shown).includes(PNG), false, "no bytes left");
		assert.equal(imageAt(screenshot, { entry: 7, message: 0, part: 1 }), image);
		assert.equal(imageAt(screenshot, { entry: 7, message: 0, part: 0 }), undefined, "a text part");
		assert.equal(imageAt(screenshot, { entry: 7, message: 1, part: 0 }), undefined, "no such message");
	});

	it("returns entries without images as they are, and each entry's result once", () => {
		const refs = entryImageRefs("session-a", 1);
		const text = entry(3, [{ role: "user", content: "hello", timestamp: 1 }]);
		const display = entry(4, undefined);
		assert.equal(refs(text), text);
		assert.equal(refs(display), display);
		assert.equal(refs(screenshot), refs(screenshot), "unchanged entries stay the same objects");
	});
});

describe("shownImage", () => {
	it("shows a reference as it is and an inline part as a data URL with its size, once per part", () => {
		const reference = entryImageRefs("session-a", 1)(screenshot).model?.[0];
		assert(reference?.role === "toolResult");
		const part = reference.content[1];
		assert(part?.type === "image");
		assert.equal(shownImage(part), part);
		const inline = shownImage(image);
		assert.deepEqual(inline, { mimeType: "image/png", src: `data:image/png;base64,${PNG}`, width: 1, height: 1 });
		assert.equal(shownImage(image), inline);
	});
});
