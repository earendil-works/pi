#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function printUsage() {
	console.log(`Usage: node scripts/diff-model-catalog.mjs [provider ...]

Generates the model catalog at HEAD and in the current worktree, then shows
JSON differences. If providers are omitted, all providers are compared.

Examples:
  node scripts/diff-model-catalog.mjs github-copilot
  npm run diff:model-catalog -- github-copilot
`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${details}`);
	}
	return result.stdout ?? "";
}

function runDiff(args, cwd) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
	printUsage();
	process.exit(0);
}
if (args.some((arg) => arg.startsWith("-"))) {
	printUsage();
	process.exit(1);
}

const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true }).trim();
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-model-catalog-diff-"));
const baselineWorktree = join(temporaryRoot, "baseline-worktree");
const baselineOutput = join(temporaryRoot, "before");
const currentOutput = join(temporaryRoot, "after");
let worktreeAdded = false;

function generateCatalog(cwd, outputDir, pretty = false) {
	const args = ["packages/ai/scripts/generate-models.ts", "--strict", "--json-only", "--json-output", outputDir];
	if (pretty) args.push("--pretty");
	run(process.execPath, args, { cwd, capture: true });
}

function formatProviderCatalogs(outputDir) {
	const providersDir = join(outputDir, "providers");
	for (const entry of readdirSync(providersDir)) {
		if (!entry.endsWith(".json")) continue;
		const path = join(providersDir, entry);
		const value = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	}
}

function readProviderCatalog(outputDir, provider) {
	const path = join(outputDir, "providers", `${provider}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function writeModelSnapshot(path, model) {
	writeFileSync(path, model === undefined ? "" : `${JSON.stringify(model, null, 2)}\n`);
}

function writeChangedLines(output) {
	const changedLines = output.split("\n").filter((line) => {
		const withoutColor = line.replace(/\u001b\[[0-9;]*m/g, "");
		return (
			(withoutColor.startsWith("+") && !withoutColor.startsWith("+++")) ||
			(withoutColor.startsWith("-") && !withoutColor.startsWith("---"))
		);
	});
	if (changedLines.length > 0) process.stdout.write(`${changedLines.join("\n")}\n`);
}

try {
	run("git", ["worktree", "add", "--detach", baselineWorktree, "HEAD"], { cwd: repoRoot });
	worktreeAdded = true;

	const nodeModules = join(repoRoot, "node_modules");
	if (existsSync(nodeModules)) {
		symlinkSync(nodeModules, join(baselineWorktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	}

	console.log("Generating catalog from HEAD...");
	generateCatalog(baselineWorktree, baselineOutput);
	formatProviderCatalogs(baselineOutput);
	console.log("Generating catalog from the current worktree...");
	generateCatalog(repoRoot, currentOutput, true);
	formatProviderCatalogs(currentOutput);

	const beforeProviders = JSON.parse(readFileSync(join(baselineOutput, "providers.json"), "utf8"));
	const afterProviders = JSON.parse(readFileSync(join(currentOutput, "providers.json"), "utf8"));
	const providers = args.length > 0 ? args : [...new Set([...beforeProviders, ...afterProviders])].sort();
	const beforeModelPath = "before-model.json";
	const afterModelPath = "after-model.json";
	const changedModels = [];
	let differences = 0;

	for (const provider of providers) {
		const beforeModels = readProviderCatalog(baselineOutput, provider);
		const afterModels = readProviderCatalog(currentOutput, provider);
		if (beforeModels === undefined && afterModels === undefined) {
			throw new Error(`Unknown provider: ${provider}`);
		}

		const modelIds = [...new Set([...Object.keys(beforeModels ?? {}), ...Object.keys(afterModels ?? {})])].sort();
		for (const modelId of modelIds) {
			const beforeModel = beforeModels?.[modelId];
			const afterModel = afterModels?.[modelId];
			if (JSON.stringify(beforeModel) === JSON.stringify(afterModel)) continue;

			writeModelSnapshot(join(temporaryRoot, beforeModelPath), beforeModel);
			writeModelSnapshot(join(temporaryRoot, afterModelPath), afterModel);
			const result = runDiff(
				[
					"diff",
					"--no-index",
					"--no-ext-diff",
					"--color=always",
					"--unified=0",
					"--",
					beforeModelPath,
					afterModelPath,
				],
				temporaryRoot,
			);
			if (result.status === 1) {
				const changedModel = `${provider}/${modelId}`;
				console.log(`\n${changedModel}`);
				writeChangedLines(result.stdout);
				changedModels.push(changedModel);
				differences++;
			} else if (result.status !== 0) {
				throw new Error(`Could not compare ${provider}/${modelId}: ${result.stderr || result.stdout}`);
			}
		}
	}

	if (differences === 0) {
		console.log(`No model catalog changes${args.length === 1 ? ` for ${args[0]}` : ""}.`);
	} else {
		console.log(`\n${differences} model catalog entr${differences === 1 ? "y" : "ies"} changed.`);
		for (const changedModel of changedModels) {
			console.log(`- ${changedModel}`);
		}
	}
} finally {
	if (worktreeAdded) {
		try {
			run("git", ["worktree", "remove", "--force", baselineWorktree], { cwd: repoRoot });
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
	}
	rmSync(temporaryRoot, { recursive: true, force: true });
}
