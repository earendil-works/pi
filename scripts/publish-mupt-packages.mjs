#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const workspaces = ["packages/ai", "packages/agent", "packages/coding-agent"];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
	if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
	return result;
}

for (const workspace of workspaces) {
	const pkg = JSON.parse(readFileSync(`${workspace}/package.json`, "utf8"));
	const existing = run("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], { capture: true, allowFailure: true });
	if (existing.status === 0 && existing.stdout.trim() === pkg.version) {
		console.log(`Skipping ${pkg.name}@${pkg.version}; already published`);
		continue;
	}
	const args = ["publish", "--workspace", workspace, "--access", "public", "--provenance"];
	if (dryRun) args.push("--dry-run");
	run("npm", args);
}
