// The portability fixtures need a stable built-in catalog, not today's live feeds.
// Copy only model data from the matching published release; all tested code stays local.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.85.1";
const digest = "+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==";
const directory = await mkdtemp(join(tmpdir(), "pi-ollama-catalog-"));
try {
	const response = await fetch(`https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${version}.tgz`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Catalog archive: HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	if (createHash("sha512").update(archive).digest("base64") !== digest) {
		throw new Error("Published catalog archive failed its integrity check");
	}
	const archivePath = join(directory, "package.tgz");
	await writeFile(archivePath, archive);
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", directory, "package/dist/providers/data"], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Catalog extraction failed: ${result.status}`);
	await cp(
		join(directory, "package/dist/providers/data"),
		fileURLToPath(new URL("../packages/ai/src/providers/data", import.meta.url)),
		{ recursive: true },
	);
	console.log(`Restored pi-ai ${version} catalog for Ollama portability fixtures.`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
