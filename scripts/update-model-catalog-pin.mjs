#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function updateModelCatalogPin(root) {
	const { version } = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	const response = await fetch(`https://pi.dev/api/models?pi-version=${encodeURIComponent(version)}`);
	if (!response.ok) throw new Error(`Catalog discovery failed: HTTP ${response.status}`);
	const revision = response.headers.get("x-pi-model-catalog-revision");
	if (!revision || !/^sha256-[0-9a-f]{64}$/.test(revision)) {
		throw new Error("Catalog discovery returned an invalid revision");
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision) {
		throw new Error("Catalog discovery body does not match its revision");
	}

	// Do not record a pin until its immutable URL is available and verified.
	const pinned = await fetch(`https://pi.dev/api/models/revisions/${revision}`);
	if (!pinned.ok) throw new Error(`Pinned catalog fetch failed: HTTP ${pinned.status}`);
	const pinnedBytes = Buffer.from(await pinned.arrayBuffer());
	if (`sha256-${createHash("sha256").update(pinnedBytes).digest("hex")}` !== revision) {
		throw new Error("Pinned catalog body does not match its revision");
	}
	writeFileSync(join(root, "nix/model-catalog.json"), `${JSON.stringify({ revision }, null, 2)}\n`);
	return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	console.log(await updateModelCatalogPin(root));
}
