// #10585: a full, over-quota or unwritable temp dir must not crash pi. Bash output that cannot be
// saved to a temp file keeps its in-memory tail and says why the full output is missing.
import type * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	failure: undefined as "write" | "exists" | undefined,
	createdPaths: [] as string[],
}));

/** Node's errors: the message starts with the code, as the user-facing text shows it. */
function fsError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

// Fault injection for failures a test cannot cause on a real disk. `write`: the file opens, then every
// write fails (ENOSPC, EDQUOT). `exists`: something already sits at the path, so the `wx` open fails.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		createWriteStream: (path: string, options: Parameters<typeof actual.createWriteStream>[1]) => {
			if (fsMocks.failure === undefined) return actual.createWriteStream(path, options);
			actual.writeFileSync(path, "partial");
			fsMocks.createdPaths.push(path);
			const opens = fsMocks.failure === "write";
			const stream = new Writable({
				write(_chunk, _encoding, callback) {
					setImmediate(() => callback(fsError("ENOSPC", "no space left on device, write")));
				},
			});
			// Like a real write stream: `open` first, or the open error alone.
			process.nextTick(() => {
				if (opens) stream.emit("open", 0);
				else stream.destroy(fsError("EEXIST", `file already exists, open '${path}'`));
			});
			return stream;
		},
	};
});

import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, type BashToolOutput, createBashTool } from "../src/core/tools/bash.ts";
import { createOutputFileStream, type OutputFileStream } from "../src/utils/output-files.ts";

/** 3000 numbered lines: over the 2000-line limit, so the full output goes to a temp file. */
const operations: BashOperations = {
	exec: async (_command, _cwd, { onData }) => {
		for (let i = 1; i <= 3000; i++) onData(Buffer.from(`${i}\n`));
		return { exitCode: 0 };
	},
};

let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-output-file-failures-"));
	fsMocks.failure = undefined;
	fsMocks.createdPaths = [];
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

/** Point the temp dir at a directory that does not exist, so opening output files fails. */
function useMissingTempDir(): void {
	const missing = join(tempRoot, "missing");
	for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, missing);
}

/** Open an output file and return it with its path, which a `failed` result no longer carries. */
function openOutputFile(): { file: OutputFileStream; path: string } {
	const file = createOutputFileStream("pi-test", ".log");
	if (file.result.kind !== "saved") throw new Error("a new output file starts as saved");
	return { file, path: file.result.path };
}

describe("createOutputFileStream", () => {
	it("reports an open failure from close() instead of crashing", async () => {
		useMissingTempDir();
		const { file, path } = openOutputFile();
		file.write("data");
		const result = await file.close();
		expect(result).toEqual({ kind: "failed", error: expect.stringContaining("ENOENT") });
		expect(existsSync(path)).toBe(false);
	});

	it("drops a partially written file and does not hang on close", async () => {
		fsMocks.failure = "write";
		const { file, path } = openOutputFile();
		file.write("data");
		await vi.waitFor(() => expect(file.result).toEqual({ kind: "failed", error: expect.stringContaining("ENOSPC") }));
		file.write("more");
		expect(await file.close()).toEqual({ kind: "failed", error: expect.stringContaining("ENOSPC") });
		expect(existsSync(path)).toBe(false);
	});

	it("leaves a file it did not create in place", async () => {
		fsMocks.failure = "exists";
		const { file, path } = openOutputFile();
		file.write("data");
		expect(await file.close()).toEqual({ kind: "failed", error: expect.stringContaining("EEXIST") });
		expect(existsSync(path)).toBe(true);
		rmSync(path);
	});

	it("saves the full output when writing succeeds", async () => {
		const { file, path } = openOutputFile();
		file.write("data");
		expect(await file.close()).toEqual({ kind: "saved", path });
		expect(file.result).toEqual({ kind: "saved", path });
		expect(existsSync(path)).toBe(true);
		rmSync(path);
	});
});

describe("bash tool", () => {
	it.each(["open", "write"])("keeps the output tail when the temp file %s fails", async (failure) => {
		if (failure === "open") useMissingTempDir();
		else fsMocks.failure = "write";
		const result = await createBashTool(tempRoot, { operations }).execute("call", { command: "seq 3000" });

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("\n2999\n3000\n");
		expect(text).toMatch(
			new RegExp(
				`\\[Showing lines \\d+-3000 of 3000\\. Could not save the full output: .*${failure === "open" ? "ENOENT" : "ENOSPC"}`,
			),
		);
		expect(result.details?.fullOutputPath).toBeUndefined();
		const structured = result.structuredContent as BashToolOutput;
		expect(structured.truncated).toBe(true);
		expect(structured.full_output_path).toBeUndefined();
		expect(structured.output).toMatch(/^\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/);
		expect(structured.output.endsWith("2999\n3000\n")).toBe(true);
		for (const path of fsMocks.createdPaths) expect(existsSync(path)).toBe(false);
	});
});

describe("user bash executor", () => {
	it.each(["open", "write"])("keeps the output tail when the temp file %s fails", async (failure) => {
		if (failure === "open") useMissingTempDir();
		else fsMocks.failure = "write";
		const result = await executeBashWithOperations("seq 3000", tempRoot, operations);

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeUndefined();
		expect(result.output).toMatch(/\n2999\n3000\n?$/);
		for (const path of fsMocks.createdPaths) expect(existsSync(path)).toBe(false);
	});
});
