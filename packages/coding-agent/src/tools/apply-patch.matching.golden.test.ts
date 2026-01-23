import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runApplyPatchMatchingCharacterization } from "./apply-patch/matching-characterization.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(currentDir, "apply-patch", "__fixtures__", "apply-patch.matching.golden.txt");

describe("apply_patch matching characterization", () => {
	it("matches the golden master output", async () => {
		const output = await runApplyPatchMatchingCharacterization();
		const golden = await readFile(fixturePath, "utf8");
		expect(output).toBe(golden);
	}, 30000);
});
