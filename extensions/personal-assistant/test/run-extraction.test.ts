import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	runMemoryExtraction,
	writeExtractionReport,
	extractMemoriesWithCallLlm,
	type RunMemoryExtractionOptions,
} from "../extraction.ts";
import { MemoryIndex } from "../storage.ts";
import type { ExtractionPlan } from "../types.ts";

// Mock embed.ts so tests don't require a live ollama. The mock factory must be
// hoisted (vitest hoists vi.mock calls to the top of the file). Same char-bag
// strategy as extraction.test.ts — deterministic, L2-normalised vectors that
// the supersede threshold (0.92) will not falsely trigger for distinct texts.
vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			const arr = new Array(1024).fill(0);
			for (let i = 0; i < text.length; i++) {
				arr[text.charCodeAt(i) % 1024] += 1;
			}
			const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
			if (norm > 0) {
				for (let i = 0; i < 1024; i++) arr[i] /= norm;
			}
			return arr;
		}),
	};
});

describe("runMemoryExtraction", () => {
	let tmpDir: string;
	let dbPath: string;
	let atomsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-extract-"));
		dbPath = path.join(tmpDir, "memory.db");
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const mockLlm = (response: unknown) => async (_prompt: string) => JSON.stringify(response);

	it("creates atoms from LLM plan (S51)", async () => {
		const opts: RunMemoryExtractionOptions = {
			callLlm: mockLlm({
				items: [
					{
						type: "rule",
						title: "Test rule",
						content: "User prefers dark mode in all UI applications.",
						summary: "Dark mode preference",
						tags: ["ui"],
						importance: 0.7,
					},
				],
			}),
			config: { model: "test-model" },
			messages: [{ role: "user", content: "I prefer dark mode" }],
			dbPath,
			atomsDir,
		};
		const result = await runMemoryExtraction(opts);
		expect(result.created).toHaveLength(1);
		expect(result.created[0]!.title).toBe("Test rule");
		expect(result.plan.items).toHaveLength(1);
		expect(result.plan.modelUsed).toBe("test-model");
	});

	it("returns empty plan if LLM returns no items (S52)", async () => {
		const opts: RunMemoryExtractionOptions = {
			callLlm: mockLlm({ items: [] }),
			config: { model: "test-model" },
			messages: [{ role: "user", content: "nothing to extract" }],
			dbPath,
			atomsDir,
		};
		const result = await runMemoryExtraction(opts);
		expect(result.created).toHaveLength(0);
		expect(result.plan.items).toHaveLength(0);
		expect(result.updated).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("returns empty result if LLM returns invalid JSON (S53)", async () => {
		const opts: RunMemoryExtractionOptions = {
			callLlm: async () => "not json at all",
			config: { model: "test-model" },
			messages: [{ role: "user", content: "hi" }],
			dbPath,
			atomsDir,
		};
		const result = await runMemoryExtraction(opts);
		expect(result.created).toHaveLength(0);
		expect(result.plan.items).toHaveLength(0);
	});
});

describe("writeExtractionReport", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes extraction report to logDir (S54)", async () => {
		const logDir = path.join(tmpDir, "logs");
		const plan: ExtractionPlan = {
			items: [
				{
					item: {
						type: "rule",
						title: "T",
						content: "User prefers dark mode for late-night coding.",
						summary: "Dark mode preference",
						tags: [],
						importance: 0.5,
					},
					status: "create",
				},
			],
			modelUsed: "test",
			generatedAt: Date.now(),
		};
		const fp = await writeExtractionReport(plan, logDir);
		const exists = await fs.stat(fp).then(() => true).catch(() => false);
		expect(exists).toBe(true);
		const content = await fs.readFile(fp, "utf8");
		const parsed = JSON.parse(content);
		expect(parsed.itemCount).toBe(1);
		expect(parsed.plan.modelUsed).toBe("test");
		expect(typeof parsed.timestamp).toBe("string");
	});

	it("creates logDir if it does not exist", async () => {
		const logDir = path.join(tmpDir, "nested", "logs");
		const plan: ExtractionPlan = {
			items: [],
			modelUsed: "test",
			generatedAt: Date.now(),
		};
		const fp = await writeExtractionReport(plan, logDir);
		const exists = await fs.stat(fp).then(() => true).catch(() => false);
		expect(exists).toBe(true);
	});
});

describe("extractMemoriesWithCallLlm (index reuse)", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-with-llm-"));
		atomsDir = path.join(tmpDir, "atoms");
		dbPath = path.join(tmpDir, "memory.db");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(dbPath);
		await index.init();
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reuses an existing index and does not close it", async () => {
		const callLlm = async (_prompt: string) =>
			JSON.stringify({
				items: [
					{
						type: "fact",
						title: "PDF tool",
						content: "PDF extraction uses PyMuPDF library directly.",
						summary: "PyMuPDF for PDF extraction",
						tags: ["pdf"],
						importance: 0.6,
					},
				],
			});
		const result = await extractMemoriesWithCallLlm(callLlm, [{ role: "user", content: "x" }], index, {
			atomsDir,
			model: "test",
		});
		expect(result.created).toHaveLength(1);
		// index is still usable after the call (not closed by extractMemoriesWithCallLlm)
		expect(index.getActiveAtoms()).toHaveLength(1);
	});
});
