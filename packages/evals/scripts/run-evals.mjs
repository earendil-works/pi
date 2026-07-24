import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

if (hasCliModelSelection && (!provider || !model)) {
	console.error("CLI model selection requires both --provider and --model.");
	process.exit(1);
}

provider ??= process.env.PI_PROVIDER;
model ??= process.env.PI_MODEL;

if (!provider || !model) {
	console.error(
		"No eval model selected. Pass --provider and --model, or set PI_PROVIDER and PI_MODEL.",
	);
	process.exit(1);
}

const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestCliPath = resolve(dirname(vitestPackagePath), "vitest.mjs");

console.error(`[eval] provider=${provider} model=${model}`);
const result = spawnSync(
	process.execPath,
	[vitestCliPath, "run", "--config", "vitest.config.ts", ...vitestArgs],
	{
		cwd: packageRoot,
		stdio: "inherit",
		env: {
			...process.env,
			PI_PROVIDER: provider,
			PI_MODEL: model,
		},
	},
);

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
