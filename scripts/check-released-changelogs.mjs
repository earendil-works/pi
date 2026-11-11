#!/usr/bin/env node

/**
 * Fails when a released section of a published package's CHANGELOG.md differs from the newest release tag.
 *
 * A branch that adds an entry under `## [Unreleased]` and is merged after a release lands the entry under the release's
 * heading: the diff anchors on the lines around it, which the release left under `## [x.y.z]`. The newest tag's file
 * holds every released section as released, so one comparison per changelog covers them all.
 * CI runs this after fetching the newest tag; `npm run check` does not.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASED_HEADING = /^## \[\d+\.\d+\.\d+\]/m;

const tag = git(["tag", "--list", "v*.*.*", "--sort=-v:refname"]).split("\n")[0];
if (!tag) {
	console.error("No release tag found. Fetch the newest one: git fetch --depth=1 origin refs/tags/<tag>:refs/tags/<tag>");
	process.exit(1);
}

let failed = false;
for (const { directory } of getPublicWorkspacePackages()) {
	const path = join(directory, "CHANGELOG.md").replaceAll("\\", "/");
	if (!existsSync(path)) continue;
	const tagged = gitFileAt(tag, path);
	// A package first published after the tag has no released sections to compare.
	if (tagged === undefined) continue;
	const current = releasedPart(readFileSync(path, "utf8"));
	const released = releasedPart(tagged);
	if (current === released) continue;
	failed = true;
	console.error(`${path}: released sections differ from ${tag}:`);
	for (const line of changedLines(released, current)) console.error(`  ${line}`);
}

if (failed) {
	console.error("\nReleased sections are fixed. Move new entries to ## [Unreleased] and restore the rest as in the tag.");
	process.exit(1);
}
console.log(`Released changelog sections match ${tag}.`);

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** `path` as it was at `ref`, or undefined when it did not exist there. */
function gitFileAt(ref, path) {
	try {
		return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

/** The text from the first `## [x.y.z]` heading on: everything below `## [Unreleased]`. */
function releasedPart(text) {
	const match = RELEASED_HEADING.exec(text);
	return match ? text.slice(match.index) : "";
}

/** The lines only one side has, `+` for added and `-` for removed, each with the release heading it is under. */
function changedLines(before, after) {
	const counts = new Map();
	for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
	const added = [];
	let heading = "";
	for (const line of after.split("\n")) {
		if (RELEASED_HEADING.test(line)) heading = line.match(/\[[^\]]+\]/)[0];
		const count = counts.get(line) ?? 0;
		if (count > 0) counts.set(line, count - 1);
		else added.push(`+ ${heading} ${line}`);
	}
	const removed = [...counts].flatMap(([line, count]) => Array.from({ length: count }, () => `- ${line}`));
	return [...added, ...removed];
}
