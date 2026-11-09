// What a base build read (decision "Workers start from the base code the server booted with", slice 11 §1; design §21):
// each file's bytes, hashed as esbuild's loader receives them (one read per file, never a later read racing a save),
// the record the watcher's `base` mark compares the files on disk with.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

/** What a base artifact was built from: the hash of each file's bytes as read (`contentHash`), by absolute path. */
export type BaseInputs = ReadonlyMap<string, string>;

/** The hash of `bytes` a base record keeps (SHA-256, hex). */
export function contentHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Reads `path` for a build, recording its bytes' hash in `inputs`: the one read of the file, its bytes for esbuild. */
export async function readRecorded(path: string, inputs: Map<string, string>): Promise<Buffer> {
	const bytes = await readFile(path);
	inputs.set(path, contentHash(bytes));
	return bytes;
}

/**
 * An esbuild plugin loading every file through `readRecorded`, with esbuild's own loader for its extension: what the
 * build read, in `inputs`. The last of a build's plugins: an earlier `onLoad` returning contents reads (and records)
 * the file itself.
 */
export function recordedSources(inputs: Map<string, string>): Plugin {
	return {
		name: "chord-recorded-sources",
		setup(builder) {
			builder.onLoad({ filter: /.*/ }, async (args) => {
				if (args.namespace !== "file") return undefined;
				return { contents: await readRecorded(args.path, inputs), loader: "default" };
			});
		},
	};
}
