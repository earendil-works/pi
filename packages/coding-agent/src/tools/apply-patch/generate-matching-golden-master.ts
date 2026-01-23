import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runApplyPatchMatchingCharacterization } from "./matching-characterization.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(currentDir, "__fixtures__");
const fixturePath = join(fixtureDir, "apply-patch.matching.golden.txt");

const output = await runApplyPatchMatchingCharacterization();
await mkdir(fixtureDir, { recursive: true });
await writeFile(fixturePath, output, "utf8");

console.log(`Wrote matching golden master to ${fixturePath}`);
