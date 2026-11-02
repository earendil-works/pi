// The values the schema switch must keep (`recorded.json`, made with the TypeBox helpers): the fingerprints and normal
// forms of `declarations.ts`, and what a host reads back from the stored data in `stored/`.

import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../../src/context/index.ts";
import type { JsonValue } from "../../../src/json.ts";
import type { Contract } from "../../../src/next/contracts/index.ts";
import { contractData } from "../../../src/next/contracts/internal.ts";
import { snapshotSchema } from "../../../src/next/contracts/snapshot.ts";
import { decodeJsonl, importStore, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import * as declared from "./declarations.ts";
import { finished, ownerHost } from "./owner.ts";

/** Every fingerprint and normal form of the declarations. */
export function fingerprints(): JsonValue {
	const contract = (C: Contract) => {
		const data = contractData(C);
		return {
			params: data.params.normal,
			versions: data.versions.map((version) => ({
				fingerprint: version.fingerprint,
				variants: Object.fromEntries(
					[...version.variants].map(([name, variant]) => [
						name,
						{
							state: Object.fromEntries([...variant.state].map(([m, s]) => [m, s.normal])),
							keyed: Object.fromEntries([...variant.keyed].map(([m, s]) => [m, s.normal])),
							methods: Object.fromEntries(
								[...variant.methods].map(([m, { args, result }]) => [
									m,
									{ args: args.normal, result: result.normal },
								]),
							),
						},
					]),
				),
			})),
		};
	};
	const table = (T: { readonly fingerprint: string; readonly record: unknown }) => ({
		fingerprint: T.fingerprint,
		record: T.record as unknown as JsonValue,
	});
	return {
		contracts: {
			everything: contract(declared.Everything),
			account: contract(declared.Account),
			owner: contract(declared.Owner),
		},
		documents: {
			profile: {
				fingerprint: declared.Profile.fingerprint,
				normal: snapshotSchema(declared.everything, "p").normal,
			},
			notes: declared.Notes.fingerprint,
			importState: declared.ImportState.fingerprint,
		},
		tables: {
			rows: table(declared.Rows),
			editsV1: table(declared.EditsV1),
			editsV2: table(declared.EditsV2),
			editsV3: table(declared.EditsV3),
		},
		job: declared.ImportJob.fingerprint,
	};
}

const stored = fileURLToPath(new URL("./stored/", import.meta.url));

/**
 * What a host of the current code reads from the stored data: from a copy of the SQLite store, and from a store
 * imported from the archive (both written at table version 1, read at version 3; the stopped job runs resume).
 */
export async function storedReads(context: Context): Promise<JsonValue> {
	const directory = await mkdtemp(join(tmpdir(), "chord-schema-switch-"));
	try {
		const fromStore = join(directory, "store.db");
		await copyFile(join(stored, "store.db"), fromStore);
		const store = await read(fromStore, context);
		const imported = await importStore(
			sqliteBackend(await openNodeSqliteDatabase(join(directory, "imported.db"))),
			decodeJsonl(createReadStream(join(stored, "archive.jsonl"))),
			context,
		);
		await imported.close(context);
		const archive = await read(join(directory, "imported.db"), context);
		return { store, archive };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** The owner's dump on the store at `path`, after its stopped runs finished. */
async function read(path: string, context: Context): Promise<JsonValue> {
	finished.length = 0;
	const { store, host } = await ownerHost(path, declared.EditsV3, "finish", context);
	const owner = await host.get(declared.Owner, {}, context);
	for (let i = 0; i < 100 && finished.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	const dump = await owner.dump({}, context);
	const result = {
		dump: dump as JsonValue,
		finished: [...finished] as JsonValue,
		note: await owner.read("b", context),
	};
	await host.close(context);
	await store.close(context);
	return result;
}
