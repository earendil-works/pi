/**
 * Modalities of media a transcript references rather than carries (see `FileContent`).
 *
 * The modality decides two things: which `Model.input` entry gates the block, and what a provider
 * does with it. It is read from the mime type so that one block shape covers audio and video.
 */

import type { FileContent } from "../types.ts";

/** A modality a `FileContent` block can carry. Every value is also a `ModelInputModality`. */
export type MediaModality = "image" | "audio" | "video";

/** Reason given where a provider's request format has no place for media sent by reference. */
export const MEDIA_UNSUPPORTED_BY_API = "not accepted by this API";

/** The modality of a mime type, or undefined for types pi does not attach by reference. */
export function mediaModalityForMimeType(mimeType: string): MediaModality | undefined {
	const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (base.startsWith("image/")) return "image";
	if (base.startsWith("audio/")) return "audio";
	if (base.startsWith("video/")) return "video";
	return undefined;
}

/** How a `FileContent` block names itself in text and in placeholders. */
export function fileContentName(file: FileContent): string {
	return file.name ?? (file.path ? (file.path.split(/[\\/]/).pop() ?? file.path) : file.mimeType);
}

/** The text that stands in for a `FileContent` block a provider cannot take, naming the reason. */
export function omittedMediaText(file: FileContent, reason: string): string {
	const modality = mediaModalityForMimeType(file.mimeType) ?? "file";
	return `(${modality} "${fileContentName(file)}" omitted: ${reason})`;
}
