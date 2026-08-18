#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const allowValue = process.env.PI_ALLOW_LOCKFILE_CHANGE;
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

function getLockfilePackageChanges() {
	const before = readJsonFromGit("HEAD:package-lock.json");
	const after = readJsonFromGit(":package-lock.json");
	if (!before?.packages || !after?.packages) return undefined;

	const changes = [];
	const paths = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
	for (const lockPath of [...paths].sort()) {
		const oldEntry = before.packages[lockPath];
		const newEntry = after.packages[lockPath];
		if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
			changes.push({ lockPath, oldEntry, newEntry });
		}
	}
	return changes;
}

function isWorkspacePackagePath(lockPath) {
	return lockPath.startsWith("packages/");
}

function hasOnlyWorkspacePackageChanges(changes) {
	return changes.length > 0 && changes.every((change) => isWorkspacePackagePath(change.lockPath));
}

function summarizeLockfileChange(changes) {
	const nodeModuleChanges = changes.filter((change) => change.lockPath.includes("node_modules/"));
	const summary = [];
	for (const { lockPath, oldEntry, newEntry } of nodeModuleChanges) {
		if (!oldEntry && newEntry) {
			summary.push(`added ${packageLabel(lockPath, newEntry)}`);
		} else if (oldEntry && !newEntry) {
			summary.push(`removed ${packageLabel(lockPath, oldEntry)}`);
		} else if (oldEntry?.version !== newEntry?.version) {
			summary.push(
				`changed ${packageNameFromLockPath(lockPath)} ${oldEntry?.version ?? "<none>"} -> ${newEntry?.version ?? "<none>"}`,
			);
		} else {
			summary.push(`changed ${packageLabel(lockPath, newEntry)}`);
		}
	}
	return summary;
}

const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

if (!stagedFiles.includes("package-lock.json")) {
	process.exit(0);
}

if (allowed) {
	console.error("package-lock.json is staged; PI_ALLOW_LOCKFILE_CHANGE is set, allowing commit.");
	process.exit(0);
}

const changes = getLockfilePackageChanges();
if (changes && hasOnlyWorkspacePackageChanges(changes)) {
	console.error("package-lock.json only updates workspace package metadata; allowing commit.");
	process.exit(0);
}

console.error("package-lock.json is staged.");
console.error("");
console.error("Review lockfile changes before committing:");
console.error("  - confirm every new/updated package is intentional");
console.error("  - confirm npm age gates were active for resolution");
console.error("  - review any new lifecycle scripts in the dependency tree");
console.error("  - regenerate/check coding-agent shrinkwrap if release deps changed");

const summary = changes ? summarizeLockfileChange(changes) : [];
if (summary.length > 0) {
	console.error("");
	console.error("Detected package version changes:");
	for (const change of summary.slice(0, 40)) {
		console.error(`  - ${change}`);
	}
	if (summary.length > 40) {
		console.error(`  ... ${summary.length - 40} more`);
	}
}

console.error("");
console.error("If this lockfile change is intentional, commit with:");
console.error("  PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
