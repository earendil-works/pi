#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareReleaseVersions } from "./publish-release-announcement.mjs";

export async function updateModelCatalogPin(root, releaseVersion) {
	const { version } = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	const pinPath = join(root, "nix/model-catalog.json");
	const current = JSON.parse(readFileSync(pinPath, "utf8"));
	let revision;
	if (releaseVersion !== undefined) {
		if (compareReleaseVersions(releaseVersion, version) > 0) {
			throw new Error(`Release ${releaseVersion} is newer than checkout ${version}`);
		}
		if (current.baselineRelease && compareReleaseVersions(releaseVersion, current.baselineRelease) < 0) {
			throw new Error(`Refusing to downgrade model baseline from ${current.baselineRelease} to ${releaseVersion}`);
		}
		const response = await fetch(`https://pi.dev/api/installer/releases/${releaseVersion}`);
		if (!response.ok) throw new Error(`Verified release metadata unavailable: HTTP ${response.status}`);
		const release = await response.json();
		if (release?.schemaVersion !== 1 || release.version !== releaseVersion) {
			throw new Error("Verified release metadata does not match the requested release");
		}
		revision = release.modelCatalogRevision;
	} else {
		const response = await fetch(`https://pi.dev/api/models?pi-version=${encodeURIComponent(version)}`);
		if (!response.ok) throw new Error(`Catalog discovery failed: HTTP ${response.status}`);
		revision = response.headers.get("x-pi-model-catalog-revision");
		const bytes = Buffer.from(await response.arrayBuffer());
		if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision) {
			throw new Error("Catalog discovery body does not match its revision");
		}
	}
	if (typeof revision !== "string" || !/^sha256-[0-9a-f]{64}$/.test(revision)) {
		throw new Error("Catalog metadata returned an invalid or missing revision");
	}

	// Do not record a pin until its immutable URL is available and verified.
	const pinned = await fetch(`https://pi.dev/api/models/revisions/${revision}`);
	if (!pinned.ok) throw new Error(`Pinned catalog fetch failed: HTTP ${pinned.status}`);
	const pinnedBytes = Buffer.from(await pinned.arrayBuffer());
	if (`sha256-${createHash("sha256").update(pinnedBytes).digest("hex")}` !== revision) {
		throw new Error("Pinned catalog body does not match its revision");
	}
	// Retain the last release baseline even when manually refreshing live metadata.
	const baselineRelease = releaseVersion ?? current.baselineRelease;
	writeFileSync(pinPath, `${JSON.stringify({ revision, baselineRelease }, null, 2)}\n`);
	return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--release")) {
		throw new Error("Usage: node scripts/update-model-catalog-pin.mjs [--release <version>]");
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	console.log(await updateModelCatalogPin(root, args[1]));
}
