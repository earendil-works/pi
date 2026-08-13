import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = process.env.PI_EVAL_ARTIFACT_DIR
	? resolve(packageRoot, process.env.PI_EVAL_ARTIFACT_DIR)
	: resolve(
			packageRoot,
			".eval",
			`${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`,
		);
const args = process.argv.slice(2);
let provider;
let model;
let hasCliModelSelection = false;
const vitestArgs = [];

for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (arg === "--provider" || arg === "--model") {
		const value = args[index + 1];
		if (!value || value.startsWith("-")) {
			console.error(`Missing value for ${arg}`);
			process.exit(1);
		}
		if (arg === "--provider") provider = value;
		else model = value;
		hasCliModelSelection = true;
		index += 1;
		continue;
	}
	if (arg.startsWith("--provider=")) {
		provider = arg.slice("--provider=".length);
		hasCliModelSelection = true;
		continue;
	}
	if (arg.startsWith("--model=")) {
		model = arg.slice("--model=".length);
		hasCliModelSelection = true;
		continue;
	}
	vitestArgs.push(arg);
}

provider = provider?.trim() || undefined;
model = model?.trim() || undefined;
if (hasCliModelSelection) {
	if (!provider || !model) {
		console.error("CLI model selection requires both --provider and --model.");
		process.exit(1);
	}
} else {
	provider = process.env.PI_PROVIDER?.trim() || undefined;
	model = process.env.PI_MODEL?.trim() || undefined;
	if (Boolean(provider) !== Boolean(model)) {
		console.error("Default model selection requires both PI_PROVIDER and PI_MODEL.");
		process.exit(1);
	}
}

const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestCliPath = resolve(dirname(vitestPackagePath), "vitest.mjs");

mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
console.error(`[eval] default-model=${provider && model ? `${provider}/${model}` : "none"}`);
console.error(`[eval] artifacts=${artifactDirectory}`);
const childEnvironment = {
	...process.env,
	PI_EVAL_ARTIFACT_DIR: artifactDirectory,
};
if (provider && model) {
	childEnvironment.PI_PROVIDER = provider;
	childEnvironment.PI_MODEL = model;
} else {
	delete childEnvironment.PI_PROVIDER;
	delete childEnvironment.PI_MODEL;
}
const result = spawnSync(
	process.execPath,
	[vitestCliPath, "run", "--config", "vitest.config.ts", ...vitestArgs],
	{
		cwd: packageRoot,
		stdio: "inherit",
		env: childEnvironment,
	},
);

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
