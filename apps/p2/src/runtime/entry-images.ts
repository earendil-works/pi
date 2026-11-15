// Images of a conversation's entries as clients get them. The chat view carries a reference per image part instead of
// its bytes: a screenshot is megabytes of base64, and a window of 50 entries with screenshots once came to 38 MB, past
// what a browser link takes in one part. Pages load the bytes from the chat plugin's route (`ENTRY_IMAGE_PATH`).
import type { ImageContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { imageSize } from "./image-size.ts";

/** An image part of an entry's message as the chat view carries it: `src` loads its bytes; its pixel size when known. */
export type ImageRef = {
	readonly type: "image";
	readonly mimeType: string;
	readonly src: string;
	readonly width?: number;
	readonly height?: number;
};

/** An image as clients show it: where it loads from and its pixel size when known. */
export type ShownImage = Omit<ImageRef, "type">;

/** Where one image part lives: its entry, the message in the entry's `model`, the part in that message's content. */
export type ImagePlace = { readonly entry: number; readonly message: number; readonly part: number };

/** The route serving an entry's image (plugins/chat/server.ts). */
export const ENTRY_IMAGE_PATH = "/entry-image";

/**
 * The entries of a conversation as clients get them, each image part a reference; entries without images stay as they
 * are. One per conversation: it keeps each entry's result by identity, so a view's unchanged entries stay the same
 * objects and its derive diffs them by one comparison each.
 */
export function entryImageRefs(session: string, conversation: number): (entry: EntryRecord) => EntryRecord {
	const shown = new WeakMap<EntryRecord, EntryRecord>();
	return (entry) => {
		let result = shown.get(entry);
		if (result === undefined) {
			result = withImageRefs(entry, session, conversation);
			shown.set(entry, result);
		}
		return result;
	};
}

function withImageRefs(entry: EntryRecord, session: string, conversation: number): EntryRecord {
	const model = entry.model;
	if (model === undefined || !model.some(hasImages)) return entry;
	const messages = model.map((message, index) => {
		if (message.role === "assistant" || typeof message.content === "string" || !hasImages(message)) return message;
		const content = message.content.map((part, at): unknown =>
			part.type === "image"
				? imageRef(part, src(session, conversation, { entry: entry.id, message: index, part: at }))
				: part,
		);
		return { ...message, content };
	});
	// The decided exception to Durable's types: the chat view's image parts are `ImageRef`s, which clients read through
	// `shownImage`.
	return { ...entry, model: messages } as unknown as EntryRecord;
}

function hasImages(message: NonNullable<EntryRecord["model"]>[number]): boolean {
	return (
		message.role !== "assistant" &&
		typeof message.content !== "string" &&
		message.content.some((part) => part.type === "image")
	);
}

function imageRef(image: ImageContent, at: string): ImageRef {
	const size = imageSize(image.data);
	return size === undefined
		? { type: "image", mimeType: image.mimeType, src: at }
		: { type: "image", mimeType: image.mimeType, src: at, width: size.width, height: size.height };
}

function src(session: string, conversation: number, place: ImagePlace): string {
	const query = new URLSearchParams({
		session,
		conversation: String(conversation),
		entry: String(place.entry),
		message: String(place.message),
		part: String(place.part),
	});
	return `${ENTRY_IMAGE_PATH}?${query}`;
}

const inlineImages = new WeakMap<ImageContent, ShownImage>();

/**
 * An image part of a chat view's entry as clients show it: its reference, or a data URL for a part still inline (a
 * page's kept copy from before references). Made once per part, so a part keeps its shown image's identity.
 */
export function shownImage(part: ImageContent): ShownImage {
	// Durable's types say `ImageContent`; the chat view's parts are `ImageRef`s (`entryImageRefs`).
	const image = part as ImageContent | ImageRef;
	if ("src" in image) return image;
	let shown = inlineImages.get(image);
	if (shown === undefined) {
		const size = imageSize(image.data);
		const at = `data:${image.mimeType};base64,${image.data}`;
		shown =
			size === undefined ? { mimeType: image.mimeType, src: at } : { mimeType: image.mimeType, src: at, ...size };
		inlineImages.set(image, shown);
	}
	return shown;
}

/** The image part at `place` of `entry`, or undefined when there is none. */
export function imageAt(entry: EntryRecord, place: ImagePlace): ImageContent | undefined {
	const message = entry.model?.[place.message];
	if (message === undefined || message.role === "assistant" || typeof message.content === "string") return undefined;
	const part = message.content[place.part];
	return part?.type === "image" ? part : undefined;
}
