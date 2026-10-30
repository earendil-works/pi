// Archives and recorded commits as they cross a trust boundary (slice 6a §13, slice 6b §1.6; decisions "Export archives
// are operations", "Writes carry their versions; archives are lossless"): the parts an export yields and an import
// takes, their order, and the compiled schemas every imported part and every applied write is checked against first.

import Type, { type TInteger } from "typebox";
import type { Context } from "../../context/index.ts";
import { arr, bool, int, lit, num, obj, opt, str, union, unknown } from "../contracts/index.ts";
import { invalid, validatorFor } from "../data/internal.ts";
import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

/** The archive format `export` writes; `import` takes this one only. */
export const ARCHIVE_FORMAT = 1;

/** The first part: the format, the store's schema version, its `lastSeq` and the allocator's next id (rule 24, D3). */
export type ArchiveManifest = {
	readonly kind: "manifest";
	readonly format: number;
	readonly schema: number;
	readonly lastSeq: number;
	readonly nextId: number;
};

/**
 * One part of an archive, in this order: the manifest; per table (by SQL name) its `table` write, its `put`s and its
 * `index` writes; per document record (by id, live and retired) its `document.create` without a base, then its kept
 * revisions in seq order; `end` with the count of the parts between.
 */
export type ArchivePart =
	| ArchiveManifest
	| Extract<TableWrite, { readonly kind: "table" | "put" | "index" }>
	| Extract<DocumentWrite, { readonly kind: "document.create" | "document.revision" }>
	| { readonly kind: "end"; readonly writes: number };

/** An integer from `min` up to 2^53 - 1: seqs, ids, versions and counts stay exact (a seq after 2^53 would repeat). */
function safe(min: number): TInteger {
	return int({ min, max: Number.MAX_SAFE_INTEGER });
}

const version = safe(1);

const column = obj({
	type: union([lit("str"), lit("int"), lit("num"), lit("bool"), lit("json")]),
	optional: opt(lit(true)),
	default: opt(union([str(), num(), bool()])),
	version: opt(version),
	fingerprint: opt(str()),
});

const versions = Type.Record(Type.String(), version);

const TABLE = obj({
	kind: lit("table"),
	table: str(),
	version,
	state: union([lit("ready"), lit("migrating")]),
	columns: Type.Record(Type.String(), column),
	key: arr(str()),
	fingerprint: str(),
});

const PUT = obj({
	kind: lit("put"),
	table: str(),
	row: Type.Record(Type.String(), unknown()),
	version,
	columns: versions,
});

const INDEX = obj({ kind: lit("index"), table: str(), name: str(), columns: arr(str()) });

const RECORD = obj({
	id: safe(1),
	owner: str(),
	namespace: str(),
	kind: str(),
	// Absent for a singleton.
	key: opt(str()),
	history: union([lit("none"), lit("latest"), lit("rewindable")]),
	createdAt: safe(1),
	retiredAt: opt(safe(1)),
	meta: opt(str()),
	revision: safe(1),
	version,
	fingerprint: str(),
});

const BASE = obj({ version, fingerprint: str(), value: unknown() });

/** A delta's ops; their shapes are checked where they are applied. */
const ops = arr(unknown());

const REVISION = obj({
	kind: lit("document.revision"),
	id: safe(1),
	seq: safe(1),
	content: union([obj({ kind: lit("base"), version, value: unknown() }), obj({ kind: lit("delta"), version, ops })]),
});

const PART = union([
	obj({ kind: lit("manifest"), format: safe(1), schema: safe(1), lastSeq: safe(0), nextId: safe(1) }),
	TABLE,
	PUT,
	INDEX,
	obj({ kind: lit("document.create"), record: RECORD }),
	REVISION,
	obj({ kind: lit("end"), writes: safe(0) }),
]);

const count = safe(0);

const edit = union([
	obj({ kind: lit("rename"), from: str(), to: str() }),
	obj({ kind: lit("add"), name: str(), column }),
	obj({ kind: lit("drop"), name: str() }),
	obj({ kind: lit("json"), name: str(), column }),
]);

const key = Type.Record(Type.String(), union([str(), num(), bool()]));

/** One recorded write of a commit (a batch's); `where` and `set` nodes are checked by the applier. */
const WRITE = union([
	TABLE,
	PUT,
	INDEX,
	obj({ kind: lit("dropIndex"), table: str(), name: str() }),
	obj({ kind: lit("alter"), table: str(), version, edit }),
	obj({ kind: lit("update"), table: str(), key, set: unknown(), columns: versions, count, version: opt(version) }),
	obj({ kind: lit("delete"), table: str(), key, count }),
	obj({
		kind: lit("updateWhere"),
		table: str(),
		where: unknown(),
		set: unknown(),
		columns: versions,
		count,
		version: opt(version),
	}),
	obj({ kind: lit("deleteWhere"), table: str(), where: unknown(), count }),
	obj({ kind: lit("document.create"), record: RECORD, base: BASE }),
	obj({
		kind: lit("document.change"),
		id: safe(1),
		revision: safe(1),
		content: union([
			obj({ kind: lit("base"), version, fingerprint: str(), value: unknown() }),
			obj({ kind: lit("delta"), version, ops }),
		]),
	}),
	obj({ kind: lit("document.retire"), id: safe(1), revision: safe(1) }),
]);

const PART_SCHEMA = { schema: PART };

const WRITE_SCHEMA = { schema: WRITE };

/** Checks one imported part against the archive schema (a trust boundary); `invalid/args` naming its position. */
export function checkPart(part: unknown, position: number, context: Context): ArchivePart {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validatorFor(PART_SCHEMA, context).Check(part)) {
		throw invalid("args", `import: part ${position}: not an archive part`);
	}
	// The check above establishes the type.
	return part as ArchivePart;
}

/** Checks one write of a batch's commit against the write schema (a trust boundary); `what` names its place. */
export function checkWrite(write: unknown, what: string, context: Context): StoreWrite {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validatorFor(WRITE_SCHEMA, context).Check(write)) throw invalid("args", `${what}: not a store write`);
	// The check above establishes the type, the nodes aside (the applier checks them).
	return write as StoreWrite;
}
