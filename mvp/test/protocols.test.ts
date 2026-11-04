import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGovernanceProtocols } from "../src/harness/protocols.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nlt-mvp-protocols-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadGovernanceProtocols optional file reads", () => {
	it("reports missing .toi and .otoi files as diagnostics, not errors", async () => {
		const cwd = tempDir();
		const context = await loadGovernanceProtocols({ cwd });
		expect(context.diagnostics.some((line) => line.includes("No .toi document found"))).toBe(true);
		expect(context.diagnostics.some((line) => line.includes("No .otoi charter found"))).toBe(true);
	});

	it("reads a present file and reports a parse failure for invalid content", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, ".otoi"), "not json");
		const context = await loadGovernanceProtocols({ cwd });
		expect(context.diagnostics.some((line) => line.includes("Failed to honor .otoi") || line.includes("Failed to parse"))).toBe(true);
		expect(context.diagnostics.some((line) => line.includes("No .otoi charter found"))).toBe(false);
	});

	it("still surfaces errors other than a missing file (a directory is not a charter)", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".otoi"));
		await expect(loadGovernanceProtocols({ cwd })).rejects.toThrow();
	});
});
