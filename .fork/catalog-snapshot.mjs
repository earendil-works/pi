#!/usr/bin/env node
// Pin the catalogue inputs: hydrate model data from the committed snapshot, or refresh the snapshot from live sources.
//
//   .fork/catalog-snapshot.mjs hydrate   generate packages/ai/src/providers/data from the snapshot (offline)
//   .fork/catalog-snapshot.mjs refresh   fetch every live source and rewrite the snapshot (network; fork/tooling only)
//
// The snapshot holds the catalogue source data (loadCatalogSources output), not generated data, so the catalog rules of the checked-out tree
// (next merges every branch's rules) transform pinned inputs. The repository is the checkout containing the cwd, or
// FORK_SYNC_REPO; the snapshot sits next to this script.
import { execFileSync, spawnSync } from "node:child_process";
import { renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogSources } from "../packages/ai/catalog/sources/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = join(here, "catalog-snapshot.json");
const repo = process.env.FORK_SYNC_REPO ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const aiDir = join(repo, "packages/ai");
const command = process.argv[2];

if (command === "hydrate") hydrate();
else if (command === "refresh") await refresh();
else {
	console.error("usage: catalog-snapshot.mjs hydrate|refresh (see header)");
	process.exit(2);
}

function hydrate() {
	const result = spawnSync("node", ["catalog/generate.ts", "--strict", "--data-only"], {
		cwd: aiDir,
		stdio: "inherit",
		env: { ...process.env, PI_FORK_CATALOG_SNAPSHOT: snapshot },
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
	console.log(`hydrated model data from ${snapshot}`);
}

async function refresh() {
	const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim();
	const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	if (branch !== "fork/tooling" && upstream !== "origin/fork/tooling") {
		console.error(`refresh must run on fork/tooling or a branch tracking origin/fork/tooling (on ${branch || "detached HEAD"}); commit the result there`);
		process.exit(1);
	}
	delete process.env.PI_FORK_CATALOG_SNAPSHOT;
	const sources = await loadCatalogSources(true);
	const out = { ...sources, nvidiaModelIds: [...sources.nvidiaModelIds] };
	const tmp = `${snapshot}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
	renameSync(tmp, snapshot);
	console.log(`wrote ${snapshot} (${statSync(snapshot).size} bytes); review and commit it on fork/tooling`);
}
