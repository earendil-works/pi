#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
	console.error("Usage: node scripts/release-mupt.mjs <patch|minor|x.y.z-mupt.n>");
	process.exit(1);
}

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	return execFileSync(command, args, { encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
}

if (run("git", ["branch", "--show-current"], { capture: true }).trim() !== "main") throw new Error("Mupt releases must run from main");
if (run("git", ["status", "--porcelain"], { capture: true }).trim()) throw new Error("Mupt releases require a clean worktree");

run("node", ["scripts/version-mupt-packages.mjs", target]);
run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
run("node", ["scripts/generate-coding-agent-shrinkwrap.mjs"]);
run("node", ["scripts/generate-coding-agent-install-lock.mjs"]);
run("npm", ["run", "check"]);

const version = JSON.parse(readFileSync("packages/ai/package.json", "utf8")).version;
const tag = `v${version}`;
const files = [
	"packages/ai/package.json",
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
	"package-lock.json",
	"packages/coding-agent/npm-shrinkwrap.json",
	"packages/coding-agent/install-lock/package.json",
	"packages/coding-agent/install-lock/package-lock.json",
];
run("git", ["add", "--", ...files]);
run("git", ["commit", "-m", `chore: release mupt ${tag}`]);
run("git", ["tag", tag]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);
