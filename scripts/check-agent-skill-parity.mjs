#!/usr/bin/env node
// Checks that the per-agent skill surfaces stay in sync.
//
// The repository carries the same governance skills for more than one agent surface
// (.claude/skills/ and .kilo/skills/). They are intentional copies, so they can drift, and a
// drifted governance skill is a false authority claim: one agent would be told something
// different from another. This script fails when they diverge.
//
// Usage: node scripts/check-agent-skill-parity.mjs
//
// Not wired into `npm run check` or `npm run test:scripts`. Wiring it in is the owner's decision.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const canonicalRoot = ".claude/skills";
const mirrorRoots = [".kilo/skills"];
const problems = [];

function skillMap(root) {
	if (!existsSync(root)) return null;
	const skills = new Map();
	for (const entry of readdirSync(root)) {
		const directory = join(root, entry);
		if (!statSync(directory).isDirectory()) continue;
		const file = join(directory, "SKILL.md");
		skills.set(entry, existsSync(file) ? readFileSync(file, "utf8") : null);
	}
	return skills;
}

function frontmatterName(text) {
	const block = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!block) return null;
	const name = /^name:\s*(\S+)\s*$/m.exec(block[1]);
	return name ? name[1] : null;
}

const canonical = skillMap(canonicalRoot);
if (!canonical) {
	console.error(`FAIL  ${canonicalRoot} does not exist`);
	process.exit(1);
}

for (const [name, text] of canonical) {
	if (text === null) {
		problems.push(`${canonicalRoot}/${name}: no SKILL.md`);
		continue;
	}
	const declared = frontmatterName(text);
	if (declared !== name) {
		problems.push(`${canonicalRoot}/${name}/SKILL.md: frontmatter name "${declared}" does not match folder "${name}"`);
	}
}

for (const mirrorRoot of mirrorRoots) {
	const mirror = skillMap(mirrorRoot);
	if (!mirror) {
		// Removing the mirror and relying on Kilo's own .claude/skills/ compatibility path
		// is a documented, supported arrangement (.kilo/README.md), so an absent mirror is
		// nothing to compare rather than a failure.
		console.log(`SKIP  ${mirrorRoot} does not exist; no mirror to compare`);
		continue;
	}
	for (const [name, text] of canonical) {
		if (!mirror.has(name)) {
			problems.push(`${mirrorRoot}/${name}: missing (present in ${canonicalRoot})`);
			continue;
		}
		const mirrored = mirror.get(name);
		if (mirrored === null) {
			problems.push(`${mirrorRoot}/${name}: no SKILL.md`);
		} else if (mirrored !== text) {
			problems.push(`${mirrorRoot}/${name}/SKILL.md: differs from ${canonicalRoot}/${name}/SKILL.md`);
		}
	}
	for (const name of mirror.keys()) {
		if (!canonical.has(name)) {
			problems.push(`${mirrorRoot}/${name}: extra (not in ${canonicalRoot})`);
		}
	}
}

if (problems.length) {
	console.error("Agent skill surfaces are out of sync:");
	for (const problem of problems) console.error(`  FAIL  ${problem}`);
	console.error("\nFix: make the surfaces identical, or remove the mirror and rely on Kilo's");
	console.error("native .claude/skills/ compatibility path.");
	process.exit(1);
}

for (const mirrorRoot of mirrorRoots) {
	if (existsSync(mirrorRoot)) {
		console.log(`PASS  ${mirrorRoot} matches ${canonicalRoot} (${canonical.size} skills)`);
	}
}
console.log("Results: agent skill surfaces in sync");
