// The worker thread of `createNodePhotonImages()`: Photon prepares images here, off the caller's event loop.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import type { ImageLimits, PreparedImage } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

/** One request: the image to prepare, and its ID for the reply. */
export type PrepareRequest = {
	readonly id: number;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly limits: ImageLimits;
};

/** The reply to a request: its result, or why it failed. */
export type PrepareReply =
	| { readonly id: number; readonly result: PreparedImage | undefined }
	| { readonly id: number; readonly error: string };

const port = parentPort;
if (port === null) throw new Error("The Photon image worker needs a parent thread");
const images = createPhotonImages(
	readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
);
port.on("message", (request: PrepareRequest) => {
	void images.prepare(request.bytes, request.mimeType, request.limits).then(
		(result) => port.postMessage({ id: request.id, result } satisfies PrepareReply),
		(error: unknown) =>
			port.postMessage({
				id: request.id,
				error: error instanceof Error ? error.message : String(error),
			} satisfies PrepareReply),
	);
});
