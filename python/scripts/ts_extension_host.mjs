#!/usr/bin/env node
/**
 * JSON-RPC host for TypeScript pi extensions (line-delimited JSON on stdin/stdout).
 * Used by the Python coding agent to load and execute .ts/.js extensions via jiti.
 */

import { createJiti } from "jiti";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
	const envRoot = process.env.PI_MONO_ROOT;
	if (envRoot && fs.existsSync(path.join(envRoot, "package.json"))) {
		return path.resolve(envRoot);
	}
	let current = path.resolve(startDir);
	while (true) {
		const packageJsonPath = path.join(current, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
				if (pkg.workspaces || pkg.name === "pi-mono") {
					return current;
				}
			} catch {
				// continue walking
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	throw new Error("Could not locate pi-mono repository root for TypeScript extension loading");
}

function buildAliases(repoRoot) {
	const require = createRequire(import.meta.url);
	const loaderDir = path.join(repoRoot, "packages/coding-agent/src/core/extensions");
	const packageIndex = path.join(repoRoot, "packages/coding-agent/src/index.ts");
	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");
	const resolveWorkspaceOrImport = (workspaceRelativePath, specifier) => {
		const workspacePath = path.join(repoRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	return {
		"@earendil-works/pi-coding-agent": packageIndex,
		"@earendil-works/pi-agent-core": resolveWorkspaceOrImport(
			"packages/agent/src/index.ts",
			"@earendil-works/pi-agent-core",
		),
		"@earendil-works/pi-tui": resolveWorkspaceOrImport("packages/tui/src/index.ts", "@earendil-works/pi-tui"),
		"@earendil-works/pi-ai": resolveWorkspaceOrImport("packages/ai/src/index.ts", "@earendil-works/pi-ai"),
		"@earendil-works/pi-ai/oauth": resolveWorkspaceOrImport(
			"packages/ai/src/oauth.ts",
			"@earendil-works/pi-ai/oauth",
		),
		"@mariozechner/pi-coding-agent": packageIndex,
		"@mariozechner/pi-agent-core": resolveWorkspaceOrImport(
			"packages/agent/src/index.ts",
			"@mariozechner/pi-agent-core",
		),
		"@mariozechner/pi-tui": resolveWorkspaceOrImport("packages/tui/src/index.ts", "@mariozechner/pi-tui"),
		"@mariozechner/pi-ai": resolveWorkspaceOrImport("packages/ai/src/index.ts", "@mariozechner/pi-ai"),
		"@mariozechner/pi-ai/oauth": resolveWorkspaceOrImport(
			"packages/ai/src/oauth.ts",
			"@mariozechner/pi-ai/oauth",
		),
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};
}

const repoRoot = findRepoRoot(path.join(__dirname, "..", ".."));
const jiti = createJiti(import.meta.url, {
	alias: buildAliases(repoRoot),
});
const loader = jiti(path.join(repoRoot, "packages/coding-agent/src/core/extensions/loader.ts"));
const eventBusModule = jiti(path.join(repoRoot, "packages/coding-agent/src/core/event-bus.ts"));

/** @type {Map<string, { extension: any, cwd: string }>} */
const loadedExtensions = new Map();

function writeResponse(response) {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handleRequest(request) {
	const { id, method, params } = request;
	try {
		if (method === "ping") {
			writeResponse({ id, result: { ok: true } });
			return;
		}
		if (method === "load") {
			const extensionPath = params?.path;
			const cwd = params?.cwd ?? process.cwd();
			if (!extensionPath) {
				throw new Error("Missing extension path");
			}
			const eventBus = eventBusModule.createEventBus();
			const loadResult = await loader.loadExtensions([extensionPath], cwd, eventBus);
			const extension = loadResult.extensions?.[0];
			const error = loadResult.errors?.[0]?.error;
			if (error || !extension) {
				throw new Error(error ?? "Failed to load extension");
			}
			loadedExtensions.set(extension.path, { extension, cwd });
			const tools = Array.from(extension.tools.values()).map((entry) => {
				const definition = entry.definition;
				return {
					name: definition.name,
					label: definition.label,
					description: definition.description,
					parameters: definition.parameters,
				};
			});
			const commands = Array.from(extension.commands.values()).map((command) => ({
				name: command.name,
				description: command.description,
			}));
			writeResponse({
				id,
				result: {
					path: extension.path,
					resolvedPath: extension.resolvedPath,
					tools,
					commands,
				},
			});
			return;
		}
		if (method === "execute_command") {
			const extensionPath = params?.extensionPath;
			const commandName = params?.commandName;
			const args = params?.args ?? "";
			const loaded = loadedExtensions.get(extensionPath);
			if (!loaded) {
				throw new Error(`Extension not loaded: ${extensionPath}`);
			}
			const command = loaded.extension.commands.get(commandName);
			if (!command) {
				throw new Error(`Unknown command: ${commandName}`);
			}
			const ctx = {
				cwd: loaded.cwd,
				ui: {},
				mode: "print",
				has_ui: false,
				session_manager: {},
				model_registry: {},
				model: null,
				signal: undefined,
				is_idle: () => true,
				abort: () => {},
				has_pending_messages: () => false,
				shutdown: () => {},
				wait_for_idle: async () => {},
				new_session: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigate_tree: async () => ({ cancelled: false }),
				switch_session: async () => ({ cancelled: false }),
				reload: async () => {},
			};
			await command.handler(args, ctx);
			writeResponse({ id, result: { ok: true } });
			return;
		}
		if (method === "execute_tool") {
			const extensionPath = params?.extensionPath;
			const toolName = params?.toolName;
			const args = params?.args ?? {};
			const loaded = loadedExtensions.get(extensionPath);
			if (!loaded) {
				throw new Error(`Extension not loaded: ${extensionPath}`);
			}
			const toolEntry = loaded.extension.tools.get(toolName);
			if (!toolEntry) {
				throw new Error(`Unknown tool: ${toolName}`);
			}
			const result = await toolEntry.definition.execute(toolName, args, undefined, undefined, undefined);
			writeResponse({ id, result });
			return;
		}
		if (method === "shutdown") {
			writeResponse({ id, result: { ok: true } });
			process.exit(0);
			return;
		}
		throw new Error(`Unknown method: ${method}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeResponse({ id, error: { message } });
	}
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	if (!line.trim()) {
		return;
	}
	let request;
	try {
		request = JSON.parse(line);
	} catch (error) {
		writeResponse({
			id: null,
			error: { message: error instanceof Error ? error.message : String(error) },
		});
		return;
	}
	void handleRequest(request);
});
