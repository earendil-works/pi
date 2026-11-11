// Extract page-labelled text or bounded page images using the local PDFium WebAssembly engine.
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { PNG } from "pngjs";
import { MAX_READER_INPUT_BYTES, MAX_READER_TEXT_BYTES, type ReaderRequest, type ReaderResult } from "./protocol.ts";

/** Read selected PDF pages without executing embedded document JavaScript or performing OCR. */
export async function readPdf(request: ReaderRequest, input?: Uint8Array): Promise<ReaderResult> {
	if (request.format === "markdown") throw new Error("PDF format must be text or images");
	const bytes =
		input ?? (request.data !== undefined ? Buffer.from(request.data, "base64") : await readPdfBytes(request.path));
	if (bytes.byteLength > MAX_READER_INPUT_BYTES) throw new Error("PDF exceeds the 64 MiB input limit");
	const library = await PDFiumLibrary.init({ wasmBinary: await readFile(request.pdfiumWasmPath) });
	try {
		const document = await library.loadDocument(bytes);
		try {
			const pageCount = document.getPageCount();
			if (pageCount === 0) throw new Error("PDF has no pages");
			const images = request.format === "images";
			const pages = selectPages(request.pages, pageCount, images ? 10 : 1000, images);
			const result: ReaderResult = {
				status: "ok",
				text: `PDF: ${request.path}\nPages: ${pageCount}\nSelected: ${pages.join(", ")}`,
				images: [],
				source: { kind: "pdf", path: request.path, pageCount, pages },
			};
			let textBytes = Buffer.byteLength(result.text);
			for (const number of pages) {
				const page = document.getPage(number - 1);
				try {
					if (images) {
						const { originalWidth, originalHeight } = page.getOriginalSize();
						// PDF dimensions are untrusted document data; bound allocation before rasterizing.
						if (
							!Number.isFinite(originalWidth) ||
							!Number.isFinite(originalHeight) ||
							originalWidth <= 0 ||
							originalHeight <= 0
						)
							throw new Error(`Invalid dimensions on PDF page ${number}`);
						const rendered = await page.render({
							scale: Math.min(2, 1600 / Math.max(originalWidth, originalHeight)),
							colorSpace: "RGBA",
							renderFormFields: true,
							render: "bitmap",
						});
						// pngjs's synchronous encoder consumes bitmap fields; its declaration unnecessarily requires stream methods.
						const png = PNG.sync.write({
							width: rendered.width,
							height: rendered.height,
							data: Buffer.from(rendered.data.buffer, rendered.data.byteOffset, rendered.data.byteLength),
						} as PNG);
						result.images.push({
							page: number,
							width: rendered.width,
							height: rendered.height,
							data: png.toString("base64"),
							mimeType: "image/png",
						});
					} else {
						const text = page.getText().replace(/\r\n/g, "\n");
						const body = `\n\n--- Page ${number} of ${pageCount} ---\n${text.trim() ? text : "[No extractable text. Use format:images to inspect this page; OCR is not enabled.]"}`;
						textBytes += Buffer.byteLength(body);
						if (textBytes > MAX_READER_TEXT_BYTES) throw new Error("PDF text exceeds 8 MiB; select fewer pages");
						result.text += body;
						if (!text.trim()) result.status = "partial";
					}
				} finally {
					page.close();
				}
			}
			return result;
		} finally {
			document.destroy();
		}
	} finally {
		library.destroy();
	}
}

function selectPages(selection: string | undefined, count: number, maximum: number, images: boolean): number[] {
	if (!selection) {
		if (images) return [1];
		if (count > maximum) throw new Error(`PDF has ${count} pages; select at most ${maximum} pages per call`);
		return Array.from({ length: count }, (_, index) => index + 1);
	}
	const selected = new Set<number>();
	for (const part of selection.split(",")) {
		const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
		if (!match) throw new Error("PDF pages must be positive page numbers or inclusive ranges, e.g. 3-5,8");
		const start = Number(match[1]);
		const end = Number(match[2] ?? match[1]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count)
			throw new Error(`PDF page range ${part} is outside 1-${count}`);
		if (end - start + 1 > maximum) throw new Error(`Select at most ${maximum} PDF pages per call`);
		for (let number = start; number <= end; number++) selected.add(number);
		if (selected.size > maximum) throw new Error(`Select at most ${maximum} PDF pages per call`);
	}
	return [...selected].sort((a, b) => a - b);
}

async function readPdfBytes(path: string): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > MAX_READER_INPUT_BYTES) throw new Error("PDF exceeds the 64 MiB input limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}
