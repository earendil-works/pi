#!/usr/bin/env node
/**
 * Run pi with the Ollama models served by the local model proxy.
 *
 * Run scripts/ollama/ollama-proxy.mjs first, then this script. It:
 *   1. Checks that the proxy (and Ollama behind it) is healthy.
 *   2. Discovers the available models through the proxy.
 *   3. Registers them as an "ollama" provider in pi's models.json
 *      (~/.pi/agent/models.json or $PI_CODING_AGENT_DIR/models.json),
 *      keeping every other provider entry untouched.
 *   4. Launches pi with the first Ollama model preselected.
 *
 * Usage:
 *   node scripts/ollama/pi-with-ollama.mjs [options] [-- <pi args>]
 *
 * Options:
 *   --proxy <url>    Proxy base URL (default: http://127.0.0.1:11435, env: PI_OLLAMA_PROXY_URL)
 *   --pi <command>   pi executable to launch (default: "pi" from PATH, falling back to repo sources)
 *   --configure-only Update models.json and exit without launching pi
 *   --help           Show this help
 *
 * Everything after "--" (or any unrecognized argument) is passed to pi as-is.
 *
 * Works on Linux, macOS, and Windows (requires Node.js 18+).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_KEY = "ollama";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");

function printHelp() {
	console.log(`pi-with-ollama - run pi with Ollama models from the local model proxy

Usage: node scripts/ollama/pi-with-ollama.mjs [options] [-- <pi args>]

Options:
  --proxy <url>     Proxy base URL (default: http://127.0.0.1:11435, env: PI_OLLAMA_PROXY_URL)
  --pi <command>    pi executable to launch (default: "pi" from PATH, falling back to repo sources)
  --configure-only  Update models.json and exit without launching pi
  --help            Show this help

Start the proxy first:
  node scripts/ollama/ollama-proxy.mjs`);
}

function parseArgs(argv) {
	const options = {
		proxy: (process.env.PI_OLLAMA_PROXY_URL || "http://127.0.0.1:11435").replace(/\/+$/, ""),
		pi: undefined,
		configureOnly: false,
		piArgs: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			options.piArgs.push(...argv.slice(i + 1));
			break;
		}
		switch (arg) {
			case "--proxy":
				options.proxy = (argv[++i] ?? "").replace(/\/+$/, "");
				break;
			case "--pi":
				options.pi = argv[++i];
				break;
			case "--configure-only":
				options.configureOnly = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				options.piArgs.push(arg);
		}
	}
	if (!options.proxy) {
		console.error("pi-with-ollama: --proxy requires a URL");
		process.exit(1);
	}
	return options;
}

async function fetchJson(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? "GET"} ${url} failed: HTTP ${response.status}`);
	}
	return response.json();
}

async function checkProxy(proxyUrl) {
	let health;
	try {
		const response = await fetch(`${proxyUrl}/healthz`);
		health = await response.json();
	} catch (error) {
		console.error(`pi-with-ollama: cannot reach the model proxy at ${proxyUrl} (${error.message}).`);
		console.error("pi-with-ollama: start it first in another terminal:");
		console.error("  node scripts/ollama/ollama-proxy.mjs");
		process.exit(1);
	}
	if (health.status !== "ok") {
		console.error(`pi-with-ollama: the proxy is running but Ollama is not reachable behind it.`);
		console.error(`pi-with-ollama: proxy said: ${health.ollama?.error ?? "unknown error"}`);
		console.error("pi-with-ollama: start Ollama with 'ollama serve' (or open the Ollama app) and retry.");
		process.exit(1);
	}
}

/** Discover models through the proxy and enrich them with per-model details from Ollama. */
async function discoverModels(proxyUrl) {
	const list = await fetchJson(`${proxyUrl}/v1/models`);
	const ids = (list.data ?? []).map((entry) => entry.id).filter(Boolean);
	if (ids.length === 0) {
		console.error("pi-with-ollama: Ollama has no models installed.");
		console.error("pi-with-ollama: pull one first, e.g.: ollama pull qwen2.5-coder:7b");
		process.exit(1);
	}

	const models = [];
	for (const id of ids) {
		const model = { id, name: `${id} (Ollama)` };
		try {
			const show = await fetchJson(`${proxyUrl}/api/show`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const capabilities = show.capabilities ?? [];
			model.reasoning = capabilities.includes("thinking");
			if (!capabilities.includes("tools")) {
				console.warn(
					`pi-with-ollama: warning: '${id}' does not support tool calling; pi's coding tools will not work with it.`,
				);
			}
			const contextKey = Object.keys(show.model_info ?? {}).find((key) => key.endsWith(".context_length"));
			if (contextKey) {
				model.contextWindow = show.model_info[contextKey];
			}
		} catch {
			// /api/show is best-effort; pi applies sensible defaults when fields are omitted.
		}
		models.push(model);
	}
	return models;
}

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Merge the ollama provider into models.json without touching other providers. */
function updateModelsJson(proxyUrl, models) {
	const agentDir = getAgentDir();
	const modelsPath = join(agentDir, "models.json");
	let config = {};
	if (existsSync(modelsPath)) {
		const raw = readFileSync(modelsPath, "utf8");
		try {
			config = JSON.parse(raw);
		} catch (error) {
			console.error(`pi-with-ollama: ${modelsPath} exists but is not valid JSON (${error.message}).`);
			console.error("pi-with-ollama: fix or remove it, then rerun this script. Nothing was modified.");
			process.exit(1);
		}
		copyFileSync(modelsPath, `${modelsPath}.bak`);
	} else {
		mkdirSync(agentDir, { recursive: true });
	}

	config.providers = config.providers ?? {};
	config.providers[PROVIDER_KEY] = {
		name: "Ollama (local proxy)",
		baseUrl: `${proxyUrl}/v1`,
		api: "openai-completions",
		// Ollama ignores API keys, but pi requires one for a model to be selectable.
		apiKey: "ollama",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
		models,
	};

	writeFileSync(modelsPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	return modelsPath;
}

function commandExists(command) {
	const probe = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(probe, [command], { stdio: "ignore", shell: process.platform === "win32" });
	return result.status === 0;
}

/** Resolve how to launch pi: --pi flag, installed binary, or this repo's sources. */
function resolvePiCommand(explicit) {
	if (explicit) {
		return { command: explicit, args: [], description: explicit };
	}
	if (commandExists("pi")) {
		return { command: "pi", args: [], description: "pi (from PATH)" };
	}
	const tsx = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
	const cli = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
	if (existsSync(tsx) && existsSync(cli)) {
		return {
			command: tsx,
			args: ["--tsconfig", join(REPO_ROOT, "tsconfig.json"), cli],
			description: "pi (from repo sources via tsx)",
		};
	}
	console.error("pi-with-ollama: could not find a way to launch pi.");
	console.error("pi-with-ollama: install it (npm install -g @earendil-works/pi-coding-agent),");
	console.error("pi-with-ollama: run 'npm install --ignore-scripts' in this repo, or pass --pi <command>.");
	process.exit(1);
}

/** cmd.exe needs shell:true for .cmd shims, which in turn needs manual quoting. */
function runInherited(command, args) {
	if (process.platform === "win32") {
		const quote = (value) => (/[\s"^&|<>()%!]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
		return spawnSync([command, ...args].map(quote).join(" "), { stdio: "inherit", shell: true });
	}
	return spawnSync(command, args, { stdio: "inherit" });
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	await checkProxy(options.proxy);
	const models = await discoverModels(options.proxy);
	console.log(`pi-with-ollama: found ${models.length} Ollama model(s) via ${options.proxy}:`);
	for (const model of models) {
		console.log(`  - ${model.id}`);
	}

	const modelsPath = updateModelsJson(options.proxy, models);
	console.log(`pi-with-ollama: registered provider '${PROVIDER_KEY}' in ${modelsPath}`);

	if (options.configureOnly) {
		console.log("pi-with-ollama: --configure-only set, not launching pi.");
		console.log(`pi-with-ollama: select a model in pi with /model or: pi --provider ${PROVIDER_KEY} --model <id>`);
		return;
	}

	const piArgs = [...options.piArgs];
	const hasModelSelection = piArgs.some((arg) => arg === "--provider" || arg === "--model" || arg === "-m");
	if (!hasModelSelection) {
		piArgs.unshift("--provider", PROVIDER_KEY, "--model", models[0].id);
	}

	const pi = resolvePiCommand(options.pi);
	console.log(`pi-with-ollama: launching ${pi.description} ${piArgs.join(" ")}`);
	const result = runInherited(pi.command, [...pi.args, ...piArgs]);
	process.exit(result.status ?? 1);
}

main().catch((error) => {
	console.error(`pi-with-ollama: fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
