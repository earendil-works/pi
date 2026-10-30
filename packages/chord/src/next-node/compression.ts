// Compression for Chord v2 hosts on Node (§22, slice 4b): the synchronous compressor `createHost({ compression })`
// takes, over Node's zlib. Node-only, so it lives outside `src/next`, which imports no Node module.

import { constants as buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { Compression } from "../next/link/index.ts";

/**
 * Raw deflate at level 1 (`deflateRawSync`), and inflate bounded by `maxOutputLength` (`inflateRawSync`): past the
 * limit `too_large`, data that is no raw deflate stream `corrupt`.
 */
export const nodeCompression: Compression = {
	deflate: (bytes) => deflateRawSync(bytes, { level: 1 }),
	inflate: (bytes, limit) => {
		try {
			// zlib refuses a bound of 0: inflate at most one byte, and one byte is past a limit of 0.
			const inflated = inflateRawSync(bytes, { maxOutputLength: Math.max(1, Math.min(limit, buffer.MAX_LENGTH)) });
			return inflated.byteLength > limit ? { kind: "too_large" } : { kind: "bytes", bytes: inflated };
		} catch (error) {
			if ((error as { readonly code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") return { kind: "too_large" };
			return { kind: "corrupt", error };
		}
	},
};
