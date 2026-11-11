// Validate the helper-process boundary and publish one bounded result before disconnecting.
import { Compile } from "typebox/compile";
import {
	MAX_READER_TEXT_BYTES,
	type ReaderRequest,
	ReaderRequestSchema,
	type ReaderResponse,
	type ReaderResult,
} from "./protocol.ts";

/** Serve exactly one reader request over the parent-owned IPC channel. */
export function serveReader(read: (request: ReaderRequest) => Promise<ReaderResult>): void {
	const validator = Compile(ReaderRequestSchema);
	process.once("message", (message: unknown) => {
		void (async () => {
			let response: ReaderResponse;
			try {
				// IPC is the helper's wire boundary; never execute a malformed request.
				if (!validator.Check(message)) throw new Error("Invalid reader request");
				const result = await read(message);
				if (Buffer.byteLength(result.text) > MAX_READER_TEXT_BYTES)
					throw new Error("Extracted text exceeds 8 MiB; select fewer PDF pages or narrow the SQL query");
				if (result.images.reduce((total, image) => total + image.data.length, 0) > 48 * 1024 * 1024)
					throw new Error("Rendered images exceed 48 MiB; select fewer PDF pages");
				response = { ok: true, result };
			} catch (error) {
				response = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			process.send!(response, () => process.disconnect());
		})();
	});
}
