#!/usr/bin/env node

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function printUsage() {
	console.log(`Usage: node scripts/diff-model-catalog.mjs [--thinking] [provider ...]

Generates the model catalog at HEAD and in the current worktree, then shows
JSON differences. If providers are omitted, all providers are compared.

--thinking compares each worktree's effective thinking levels using that
worktree's getSupportedThinkingLevels() implementation.

Examples:
  node scripts/diff-model-catalog.mjs github-copilot
  npm run diff:model-catalog -- --thinking moonshotai kimi-coding
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
const thinkingOnly = args.includes("--thinking");
const requestedProviders = args.filter((arg) => arg !== "--thinking");
if (requestedProviders.some((arg) => arg.startsWith("-"))) {
	printUsage();
	process.exit(1);
}

const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true }).trim();
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-model-catalog-diff-"));
const baselineWorktree = join(temporaryRoot, "baseline-worktree");
const baselineOutput = join(temporaryRoot, "before");
const currentOutput = join(temporaryRoot, "after");
const baselineThinkingOutput = join(temporaryRoot, "before-thinking");
const currentThinkingOutput = join(temporaryRoot, "after-thinking");
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

function generateThinkingCatalog(cwd, catalogPath, outputDir) {
	run(process.execPath, ["scripts/generate-thinking-capabilities.mjs", catalogPath, outputDir], {
		cwd,
		capture: true,
	});
}

const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_RANKS = new Map(THINKING_LEVEL_ORDER.map((key, index) => [key, index]));

function sortJsonKeys(keys, parentKey) {
	if (parentKey !== "thinkingLevelMap" && parentKey !== "values") return keys.sort();
	return keys.sort((left, right) => {
		const leftRank = THINKING_LEVEL_RANKS.get(left) ?? Number.POSITIVE_INFINITY;
		const rightRank = THINKING_LEVEL_RANKS.get(right) ?? Number.POSITIVE_INFINITY;
		return leftRank - rightRank || left.localeCompare(right);
	});
}

function canonicalizeJson(value, parentKey) {
	if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
	if (value === null || typeof value !== "object") return value;

	const result = {};
	for (const key of sortJsonKeys(Object.keys(value), parentKey)) {
		result[key] = canonicalizeJson(value[key], key);
	}
	return result;
}

function formatJsonForDiff(value, indent = "") {
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const childIndent = `${indent}  `;
		return `[\n${value.map((entry) => `${childIndent}${formatJsonForDiff(entry, childIndent)},`).join("\n")}\n${indent}]`;
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);

	const entries = Object.entries(value);
	if (entries.length === 0) return "{}";
	const childIndent = `${indent}  `;
	return `{\n${entries
		.map(([key, entry]) => `${childIndent}${JSON.stringify(key)}: ${formatJsonForDiff(entry, childIndent)},`)
		.join("\n")}\n${indent}}`;
}

function writeModelSnapshot(path, model) {
	writeFileSync(path, model === undefined ? "" : `${formatJsonForDiff(canonicalizeJson(model))}\n`);
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
	copyFileSync(
		join(repoRoot, "scripts", "generate-thinking-capabilities.mjs"),
		join(baselineWorktree, "scripts", "generate-thinking-capabilities.mjs"),
	);

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

	if (thinkingOnly) {
		console.log("Computing effective thinking capabilities...");
		generateThinkingCatalog(baselineWorktree, join(baselineOutput, "models.json"), baselineThinkingOutput);
		generateThinkingCatalog(repoRoot, join(currentOutput, "models.json"), currentThinkingOutput);
	}

	const beforeProviders = JSON.parse(readFileSync(join(baselineOutput, "providers.json"), "utf8"));
	const afterProviders = JSON.parse(readFileSync(join(currentOutput, "providers.json"), "utf8"));
	const providers =
		requestedProviders.length > 0 ? requestedProviders : [...new Set([...beforeProviders, ...afterProviders])].sort();
	const beforeCatalogOutput = thinkingOnly ? baselineThinkingOutput : baselineOutput;
	const currentCatalogOutput = thinkingOnly ? currentThinkingOutput : currentOutput;
	const beforeModelPath = "before-model.json";
	const afterModelPath = "after-model.json";
	const changedModels = [];
	let differences = 0;

	for (const provider of providers) {
		const beforeModels = readProviderCatalog(beforeCatalogOutput, provider);
		const afterModels = readProviderCatalog(currentCatalogOutput, provider);
		if (beforeModels === undefined && afterModels === undefined) {
			throw new Error(`Unknown provider: ${provider}`);
		}

		const modelIds = [...new Set([...Object.keys(beforeModels ?? {}), ...Object.keys(afterModels ?? {})])].sort();
		for (const modelId of modelIds) {
			const beforeModel = beforeModels?.[modelId];
			const afterModel = afterModels?.[modelId];
			if (JSON.stringify(canonicalizeJson(beforeModel)) === JSON.stringify(canonicalizeJson(afterModel))) continue;

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
		console.log(`No model catalog changes${requestedProviders.length === 1 ? ` for ${requestedProviders[0]}` : ""}.`);
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
