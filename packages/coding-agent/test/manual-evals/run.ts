#!/usr/bin/env tsx

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
	type AssistantMessage,
	getModels,
	getProviders,
	type KnownProvider,
	type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getManualEvalScenarios, type ManualEvalScenario, type ManualEvalSuiteName } from "./scenarios.js";

interface Args {
	suite?: ManualEvalSuiteName;
	scenario?: string;
	repeats: number;
	outDir: string;
	modelPattern?: string;
}

const KNOWN_PROVIDERS = new Set<string>(getProviders());

function parseArgs(argv: string[]): Args {
	let suite: ManualEvalSuiteName | undefined;
	let scenario: string | undefined;
	let repeats = 1;
	let outDir = resolve(join(tmpdir(), `pi-manual-evals-${Date.now()}`));
	let modelPattern: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--suite") {
			const value = argv[++index];
			if (value === "discovery" || value === "plan-mode" || value === "max-edit") {
				suite = value;
			} else {
				throw new Error(`Invalid --suite value: ${value}`);
			}
			continue;
		}
		if (arg === "--scenario") {
			scenario = argv[++index];
			continue;
		}
		if (arg === "--repeats") {
			repeats = Number.parseInt(argv[++index] ?? "1", 10);
			continue;
		}
		if (arg === "--out") {
			outDir = resolve(argv[++index] ?? outDir);
			continue;
		}
		if (arg === "--model") {
			modelPattern = argv[++index];
			continue;
		}
		if (arg === "--help") {
			printHelp();
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!Number.isInteger(repeats) || repeats < 1) {
		throw new Error("--repeats must be a positive integer");
	}

	return { suite, scenario, repeats, outDir, modelPattern };
}

function printHelp(): void {
	console.log(`Usage: npx tsx test/manual-evals/run.ts [options]

Options:
  --suite <discovery|plan-mode|max-edit>
  --scenario <name>
  --repeats <n>        Default: 1
  --out <dir>          Default: OS temp dir
  --model <provider/id>
  --help
`);
}

function isKnownProvider(value: string): value is KnownProvider {
	return KNOWN_PROVIDERS.has(value);
}

function resolveModel(pattern: string | undefined) {
	if (!pattern) {
		return undefined;
	}

	const [provider, modelId] = pattern.split("/");
	if (!provider || !modelId) {
		throw new Error(`Invalid --model value: ${pattern}. Expected provider/id.`);
	}
	if (!isKnownProvider(provider)) {
		throw new Error(`Unknown provider in --model: ${provider}`);
	}
	const model = getModels(provider).find((candidate) => candidate.id === modelId);
	if (!model) {
		throw new Error(`Model not found: ${pattern}`);
	}
	return model;
}

function getLastAssistantText(messages: AssistantMessage[]): string {
	const last = messages[messages.length - 1];
	if (!last) {
		return "";
	}

	return last.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

async function runScenario(
	scenario: ManualEvalScenario,
	repetition: number,
	args: Args,
): Promise<{
	suite: string;
	name: string;
	repetition: number;
	pass: boolean;
	notes: string[];
	assistantText: string;
	toolNames: string[];
}> {
	const workspaceDir = mkdtempSync(join(tmpdir(), `pi-manual-eval-${scenario.name}-`));
	await scenario.setup(workspaceDir);

	const agentDir = join(args.outDir, "agent");
	const settingsManager = SettingsManager.create(workspaceDir, agentDir);
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const model = resolveModel(args.modelPattern);

	const resourceLoader = new DefaultResourceLoader({
		cwd: workspaceDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: scenario.extensionPaths ?? [],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: workspaceDir,
		agentDir,
		settingsManager,
		sessionManager,
		resourceLoader,
		authStorage,
		model,
	});
	await session.bindExtensions({});
	if (scenario.tools) {
		session.setActiveToolsByName(scenario.tools);
	}

	await session.prompt(scenario.prompt);

	const assistantMessages = session.messages.filter(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	const toolResults = session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
	const assistantText = getLastAssistantText(assistantMessages);
	const toolNames = toolResults.map((message) => message.toolName);
	const check = scenario.check({
		assistantText,
		toolNames,
		toolResults,
		workspaceDir,
	});

	session.dispose();

	return {
		suite: scenario.suite,
		name: scenario.name,
		repetition,
		pass: check.pass,
		notes: check.notes,
		assistantText,
		toolNames,
	};
}

function writeOutputs(outDir: string, results: Awaited<ReturnType<typeof runScenario>>[]): void {
	mkdirSync(outDir, { recursive: true });
	const jsonlPath = join(outDir, "results.jsonl");
	const markdownPath = join(outDir, "SUMMARY.md");

	writeFileSync(jsonlPath, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, "utf-8");

	const summaryLines = ["# Manual Eval Summary", ""];
	for (const result of results) {
		summaryLines.push(`## ${result.suite} / ${result.name} / run ${result.repetition}`);
		summaryLines.push(`- pass: ${result.pass}`);
		summaryLines.push(`- tools: ${result.toolNames.join(", ") || "(none)"}`);
		summaryLines.push(`- assistant: ${result.assistantText || "(empty)"}`);
		summaryLines.push(`- notes: ${result.notes.join(" | ")}`);
		summaryLines.push("");
	}
	writeFileSync(markdownPath, summaryLines.join("\n"), "utf-8");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const scenarios = getManualEvalScenarios({
		suite: args.suite,
		name: args.scenario,
	});

	if (scenarios.length === 0) {
		throw new Error("No manual eval scenarios matched the provided filters.");
	}

	const results: Awaited<ReturnType<typeof runScenario>>[] = [];
	for (const scenario of scenarios) {
		for (let repetition = 1; repetition <= args.repeats; repetition++) {
			results.push(await runScenario(scenario, repetition, args));
		}
	}

	writeOutputs(args.outDir, results);
	console.log(`Wrote manual eval results to ${args.outDir}`);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
