// Writes the stored data of the schema switch's proof (`stored/`): a SQLite store and its export archive, made by the
// code before the switch (TypeBox helpers). Kept as it was written; rerun only to make a new fixture on purpose.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/schema/write-stored.ts

import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { encodeJsonl } from "../../../src/next/store/index.ts";
import { EditsV1, Owner } from "./declarations.ts";
import { ownerHost } from "./owner.ts";

const stored = fileURLToPath(new URL("./stored/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "chord-schema-switch-"));
const path = join(directory, "store.db");
try {
	const { store, host } = await ownerHost(path, EditsV1, "wait", context);
	const owner = await host.get(Owner, {}, context);
	for (const [id, body] of [
		["a", "first note"],
		["b", "second"],
		["c", "third one"],
	] as const) {
		await owner.write({ id, body }, context);
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	await mkdir(stored, { recursive: true });
	await pipeline(encodeJsonl(store.export(context)), createWriteStream(join(stored, "archive.jsonl")));
	// A clean close: the waiting runs are stored `stopped`, resumed by the next host.
	await host.close(context);
	await store.close(context);
	await copyFile(path, join(stored, "store.db"));
	console.log("written to", stored);
} finally {
	await rm(directory, { recursive: true, force: true });
}
