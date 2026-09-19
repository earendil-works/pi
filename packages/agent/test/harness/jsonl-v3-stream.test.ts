import { beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import type { CommittedEntryWrite, CommittedValueSetWrite } from "../../src/harness/session/commit.ts";
import type { LegacyV3SessionHeader } from "../../src/harness/session/jsonl/codec.ts";
import { LegacyV3Source } from "../../src/harness/session/jsonl/legacy-v3.ts";
import { type FileError, getOrThrow, ok, type Result, type TextLineReader } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;
const HEADER: LegacyV3SessionHeader = {
	type: "session",
	version: 3,
	id: "legacy",
	timestamp: new Date(NOW).toISOString(),
	cwd: "/workspace",
};
type OutputWrite = CommittedEntryWrite | CommittedValueSetWrite;

function entry(type: string, id: string, parentId: string | null, fields: Record<string, unknown> = {}) {
	return { type, id, parentId, timestamp: new Date(NOW).toISOString(), ...fields };
}

function message(id: string, parentId: string | null, content = id) {
	return entry("message", id, parentId, { message: { role: "user", content, timestamp: NOW } });
}

async function collect(source: LegacyV3Source, selected?: (id: string) => boolean): Promise<OutputWrite[]> {
	const writes: OutputWrite[] = [];
	for await (const write of source.writes(BACKGROUND_CONTEXT, selected)) writes.push(write);
	return writes;
}

class ObservedEnv extends NodeExecutionEnv {
	lineReads = 0;
	opens = 0;
	closes = 0;

	override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await super.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		this.opens++;
		return ok({
			readLine: (readContext: Context) => {
				this.lineReads++;
				return opened.value.readLine(readContext);
			},
			close: async (closeContext: Context) => {
				this.closes++;
				await opened.value.close(closeContext);
			},
		});
	}
}

describe("streaming legacy v3 normalization", () => {
	let fileSystem: ObservedEnv;
	let fixtureId = 0;

	beforeEach(() => {
		fileSystem = new ObservedEnv({ cwd: createTempDir() });
	});

	async function fixture(records: readonly unknown[], suffix = "") {
		const path = `legacy-${fixtureId++}.jsonl`;
		const content = `${[HEADER, ...records].map((record) => JSON.stringify(record)).join("\n")}\n${suffix}`;
		getOrThrow(await fileSystem.writeFile(path, content, BACKGROUND_CONTEXT));
		return {
			path,
			content,
			reader: fileSystem,
			read: () => LegacyV3Source.read(fileSystem, path, BACKGROUND_CONTEXT),
		};
	}

	it("materializes a selected compaction with its branch-local tail", async () => {
		const { read, reader } = await fixture([
			message("before", null),
			entry("session_info", "boundary", "before"),
			message("kept", "boundary", "Unicode é漢字"),
			message("other", "before", "not on this branch"),
			entry("compaction", "selected", "kept", {
				summary: "selected",
				firstKeptEntryId: "boundary",
				tokensBefore: 20,
				fromHook: true,
				details: { a: 2 },
			}),
		]);
		const source = await read();
		const selectedId = [...source.entryStructures()].at(-1)!.id;
		expect(await collect(source, () => false)).toEqual(source.values);
		reader.lineReads = 0;
		const writes = await collect(source, (id) => id === selectedId);
		expect(writes).toHaveLength(2);
		expect(writes[0]).toMatchObject({
			type: "compaction",
			id: selectedId,
			seq: 4,
			fromHook: true,
			details: { a: 2 },
			retainedTail: [{ role: "user", content: "Unicode é漢字", timestamp: NOW }],
		});
		expect(reader.lineReads).toBe(6); // Header plus each captured physical record, read once.
	});

	it("reuses an earlier cached message in selected compaction tails on different branches", async () => {
		const { read, reader } = await fixture([
			message("root", null),
			message("left", "root"),
			entry("compaction", "left-compaction", "left", {
				summary: "left summary",
				firstKeptEntryId: "root",
				tokensBefore: 10,
			}),
			message("right", "root"),
			entry("compaction", "right-compaction", "right", {
				summary: "right summary",
				firstKeptEntryId: "root",
				tokensBefore: 20,
			}),
		]);
		const source = await read();
		const structures = [...source.entryStructures()];
		const selected = new Set([structures[2]!.id, structures[4]!.id]);
		reader.lineReads = 0;
		const writes = await collect(source, (id) => selected.has(id));
		expect(writes).toHaveLength(3);
		expect(writes[0]).toMatchObject({
			type: "compaction",
			summary: "left summary",
			retainedTail: [
				{ role: "user", content: "root", timestamp: NOW },
				{ role: "user", content: "left", timestamp: NOW },
			],
		});
		expect(writes[1]).toMatchObject({
			type: "compaction",
			summary: "right summary",
			retainedTail: [
				{ role: "user", content: "root", timestamp: NOW },
				{ role: "user", content: "right", timestamp: NOW },
			],
		});
		expect(reader.lineReads).toBe(6);
		expect(await collect(source, (id) => selected.has(id))).toEqual(writes);
	});

	it("ignores a torn tail and emits only the captured complete records after later appends", async () => {
		const { path, read, reader } = await fixture([message("a", null)], JSON.stringify(message("torn", "a")));
		const source = await read();
		getOrThrow(
			await fileSystem.appendFile(path, `\n${JSON.stringify(message("later", "torn"))}\n`, BACKGROUND_CONTEXT),
		);
		reader.lineReads = 0;
		const writes = await collect(source);
		expect(writes).toHaveLength(2);
		expect(reader.lineReads).toBe(2); // Header plus the single captured complete record.
		expect(source.nextSeq).toBe(3);
	});
});
