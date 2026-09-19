import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { publishFileAtomically, publishJsonl } from "../../src/harness/session/jsonl/io.ts";
import type { JsonlStorageHeader } from "../../src/harness/session/jsonl/types.ts";
import { sessionName, setValue } from "../../src/harness/session/values.ts";
import { err, FileError } from "../../src/harness/types.ts";

let root: string;
let path: string;
let fileSystem: NodeExecutionEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-jsonl-io-"));
	path = join(root, "session.jsonl");
	fileSystem = new NodeExecutionEnv({ cwd: root });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe("atomic file publication", () => {
	it("keeps the destination unchanged until all content has been written", async () => {
		await writeFile(path, "original");

		await publishFileAtomically(fileSystem, path, BACKGROUND_CONTEXT, async (append) => {
			await append("first\n");
			expect(await readFile(`${path}.tmp`, "utf8")).toBe("first\n");
			expect(await readFile(path, "utf8")).toBe("original");
			await append("second\n");
			expect(await readFile(path, "utf8")).toBe("original");
		});

		expect(await readFile(path, "utf8")).toBe("first\nsecond\n");
		await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("discards partial content and preserves the original error when the callback fails", async () => {
		await writeFile(path, "original");
		const failure = new Error("content generation failed");

		await expect(
			publishFileAtomically(fileSystem, path, BACKGROUND_CONTEXT, async (append) => {
				await append("partial");
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(await readFile(path, "utf8")).toBe("original");
		await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["writeFile", "appendFile", "renameFile"] as const)(
		"preserves the destination and allows retry after %s fails",
		async (method) => {
			await writeFile(path, "original");
			const failure = new FileError("unknown", "injected I/O failure", path);
			vi.spyOn(fileSystem, method).mockResolvedValueOnce(err(failure));

			await expect(
				publishFileAtomically(fileSystem, path, BACKGROUND_CONTEXT, (append) => append("replacement")),
			).rejects.toMatchObject({ cause: failure });

			expect(await readFile(path, "utf8")).toBe("original");
			await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });

			await publishFileAtomically(fileSystem, path, BACKGROUND_CONTEXT, (append) => append("retry"));
			expect(await readFile(path, "utf8")).toBe("retry");
		},
	);
});

describe("JSONL publication", () => {
	const header: JsonlStorageHeader = {
		v: 4,
		kind: "header",
		id: "session",
		storageVersion: 1,
		createdAt: 1_700_000_000_000,
		cwd: "/workspace",
		nextSeq: 4,
	};

	it("writes the header first and preserves single-write and multi-write transaction boundaries", async () => {
		const first = { ...setValue(sessionName, "first"), seq: 1 };
		const second = { ...setValue(sessionName, "second"), seq: 2 };
		const third = { ...setValue(sessionName, "third"), seq: 3 };

		await publishJsonl(fileSystem, path, header, BACKGROUND_CONTEXT, async (append) => {
			await append([first]);
			await append([second, third]);
		});

		expect(await readFile(path, "utf8")).toBe(
			[JSON.stringify(header), JSON.stringify(first), JSON.stringify([second, third]), ""].join("\n"),
		);
	});

	it("publishes a header-only file when the callback emits no transactions", async () => {
		await publishJsonl(fileSystem, path, header, BACKGROUND_CONTEXT, async () => {});
		expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(header)}\n`);
	});
});
