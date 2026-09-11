import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { getOrThrow, type TextLine, type TextLineReader } from "../../src/harness/types.ts";

let root: string;
let env: NodeExecutionEnv;
const readers: TextLineReader[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-text-line-reader-"));
	env = new NodeExecutionEnv({ cwd: root });
});

afterEach(async () => {
	await Promise.all(readers.splice(0).map((reader) => reader.close(BACKGROUND_CONTEXT)));
	await rm(root, { recursive: true, force: true });
});

async function openReader(content: string | Uint8Array): Promise<TextLineReader> {
	await writeFile(join(root, "text.txt"), content);
	const reader = getOrThrow(await env.openTextLineReader("text.txt", BACKGROUND_CONTEXT));
	readers.push(reader);
	return reader;
}

async function readLines(reader: TextLineReader): Promise<TextLine[]> {
	const lines: TextLine[] = [];
	while (true) {
		const line = getOrThrow(await reader.readLine(BACKGROUND_CONTEXT));
		if (line === undefined) return lines;
		lines.push(line);
	}
}

describe("TextLineReader", () => {
	it("decodes Unicode, blank lines, and a torn final line", async () => {
		const reader = await openReader("hé🙂\n\n\n終\ntorn");
		expect(await readLines(reader)).toEqual([
			{ text: "hé🙂", terminated: true },
			{ text: "", terminated: true },
			{ text: "", terminated: true },
			{ text: "終", terminated: true },
			{ text: "torn", terminated: false },
		]);
		expect(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT))).toBeUndefined();
	});

	it("reads an empty file", async () => {
		const reader = await openReader("");
		expect(await readLines(reader)).toEqual([]);
	});

	it("decodes multibyte characters split across 64 KiB chunks", async () => {
		const first = `${"a".repeat(64 * 1024 - 1)}🙂${"é".repeat(40_000)}\n`;
		const reader = await openReader(`${first}終`);
		expect(await readLines(reader)).toEqual([
			{ text: first.slice(0, -1), terminated: true },
			{ text: "終", terminated: false },
		]);
	});

	it("replaces malformed and incomplete UTF-8", async () => {
		const reader = await openReader(new Uint8Array([0xff, 0x0a, 0xe2, 0x82]));
		expect(await readLines(reader)).toEqual([
			{ text: "�", terminated: true },
			{ text: "�", terminated: false },
		]);
	});

	it("rejects an open with a pre-aborted context", async () => {
		await writeFile(join(root, "text.txt"), "one\n");
		const controller = new AbortController();
		controller.abort();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		expect(await env.openTextLineReader("text.txt", context)).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});

	it("does not consume a buffered line when its context is pre-aborted", async () => {
		const reader = await openReader("one\ntwo\n");
		getOrThrow(await reader.readLine(BACKGROUND_CONTEXT));
		const controller = new AbortController();
		controller.abort();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		expect(await reader.readLine(context)).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT))?.text).toBe("two");
	});

	it("honors cancellation during a read and allows retry", async () => {
		const reader = await openReader(`${"é".repeat(70_000)}\nlast`);
		const controller = new AbortController();
		const pending = reader.readLine(withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect((await readLines(reader)).map((line) => line.text)).toEqual(["é".repeat(70_000), "last"]);
	});

	it("closes idempotently even with an aborted context and rejects later reads", async () => {
		const reader = await openReader("one\ntwo\n");
		getOrThrow(await reader.readLine(BACKGROUND_CONTEXT));
		const controller = new AbortController();
		controller.abort();
		await expect(reader.close(withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).resolves.toBeUndefined();
		await expect(reader.close(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		expect(await reader.readLine(BACKGROUND_CONTEXT)).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	it("returns a FileError for a missing file", async () => {
		expect(await env.openTextLineReader("missing.txt", BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "not_found", path: join(root, "missing.txt") },
		});
	});
});
