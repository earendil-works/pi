#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const allowValue = process.env.LYLA_ALLOW_LOCKFILE_CHANGE;
const allowed = allowValue === "1" || allowValue === "true" || allowValue === "yes";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJsonFromGit(ref) {
	try {
		return JSON.parse(git(["show", ref]));
	} catch {
		return undefined;
	}
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return lockPath || "<root>";
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packageLabel(lockPath, entry) {
	const name = entry?.name ?? packageNameFromLockPath(lockPath);
	return entry?.version ? `${name}@${entry.version}` : name;
}

function summarizeLockfileChange() {
	const before = readJsonFromGit("HEAD:package-lock.json");
	const after = readJsonFromGit(":package-lock.json");
	if (!before?.packages || !after?.packages) return [];

	const changes = [];
	const paths = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
	for (const lockPath of [...paths].sort()) {
		if (!lockPath.includes("node_modules/")) continue;
		const oldEntry = before.packages[lockPath];
		const newEntry = after.packages[lockPath];
		if (!oldEntry && newEntry) {
			changes.push(`added ${packageLabel(lockPath, newEntry)}`);
		} else if (oldEntry && !newEntry) {
			changes.push(`removed ${packageLabel(lockPath, oldEntry)}`);
		} else if (oldEntry?.version !== newEntry?.version) {
			changes.push(
				`changed ${packageNameFromLockPath(lockPath)} ${oldEntry?.version ?? "<none>"} -> ${newEntry?.version ?? "<none>"}`,
			);
		}
	}
	return changes;
}

const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

if (!stagedFiles.includes("package-lock.json")) {
	process.exit(0);
}

if (allowed) {
	console.error("package-lock.json is staged; LYLA_ALLOW_LOCKFILE_CHANGE is set, allowing commit.");
	process.exit(0);
}

console.error("package-lock.json is staged.");
console.error("");
console.error("Review lockfile changes before committing:");
console.error("  - confirm every new/updated package is intentional");
console.error("  - confirm npm age gates were active for resolution");
console.error("  - review any new lifecycle scripts in the dependency tree");
console.error("  - regenerate/check coding-agent shrinkwrap if release deps changed");

const changes = summarizeLockfileChange();
if (changes.length > 0) {
	console.error("");
	console.error("Detected package version changes:");
	for (const change of changes.slice(0, 40)) {
		console.error(`  - ${change}`);
	}
	if (changes.length > 40) {
		console.error(`  ... ${changes.length - 40} more`);
	}
}

console.error("");
console.error("If this lockfile change is intentional, commit with:");
console.error("  LYLA_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
