// Tests of the schema switch from TypeBox to pi-schema (decision "A schema package beneath pi-ai and Chord"): the same
// declarations give byte-identical fingerprints and normal forms, and data stored by the code before the switch loads
// after it (`recorded.json` and `stored/` were made with the TypeBox helpers, see `write-stored.ts`).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { fingerprints, storedReads } from "./proofs.ts";

const recorded = JSON.parse(readFileSync(new URL("./recorded.json", import.meta.url), "utf8"));

describe("fingerprints", () => {
	it("keeps every fingerprint and normal form of contracts, documents, tables, json columns and jobs", () => {
		expect(fingerprints()).toEqual(recorded.fingerprints);
	});
});

describe("stored data", () => {
	it("reads a store and an archive written before the switch: documents, tables, a migrated table, stopped runs", async () => {
		expect(await storedReads(context)).toEqual(recorded.stored);
	});
});
