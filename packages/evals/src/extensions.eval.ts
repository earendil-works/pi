import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { recordEvalSourceArtifact } from "./vitest-evals/artifacts.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

type ExtensionAuthoringOutput = {
	response: string;
	systemPromptHasGuidelines: boolean;
	systemPromptHasPiDocs: boolean;
	extensionErrors: Array<{ path: string; error: string }>;
	loadedExtensions: Array<{ path: string; tools: string[] }>;
	extensionSource: string | null;
};

function createExtensionAuthoringHarness(name: string, transformSystemPrompt?: (defaultPrompt: string) => string) {
	return createPiCodingAgentHarness({
		name,
		...(transformSystemPrompt ? { transformSystemPrompt } : {}),
		output: ({ response, session }) => {
			const extensions = session.resourceLoader.getExtensions();
			const extensionPath = join(session.sessionManager.getCwd(), ".pi", "extensions", "hello.ts");
			const extensionSource = existsSync(extensionPath) ? readFileSync(extensionPath, "utf8") : null;
			return {
				response,
				systemPromptHasGuidelines: session.systemPrompt.includes("\nGuidelines:\n"),
				systemPromptHasPiDocs: session.systemPrompt.includes("\nPi documentation (read only"),
				extensionErrors: extensions.errors,
				loadedExtensions: extensions.extensions.map(({ path, tools }) => ({
					path,
					tools: [...tools.keys()],
				})),
				extensionSource,
			};
		},
	});
}

function excludeGuidelinesAndDocumentation(defaultPrompt: string): string {
	const guidelinesStart = defaultPrompt.indexOf("\nGuidelines:\n");
	if (guidelinesStart === -1) throw new Error("Default Pi system prompt has no Guidelines section.");
	return defaultPrompt.slice(0, guidelinesStart);
}

function prepareDefaultPromptOverride(defaultPrompt: string): string {
	const cwdStart = defaultPrompt.lastIndexOf("\nCurrent working directory: ");
	if (cwdStart === -1) throw new Error("Default Pi system prompt has no working-directory section.");
	return defaultPrompt.slice(0, cwdStart);
}

const ExtensionAuthoringJudge = createJudge<PiCodingAgentInput, ExtensionAuthoringOutput>(
	"ExtensionAuthoringJudge",
	({ output, toolCalls }) => {
		const failures: string[] = [];
		if (output.extensionSource === null) {
			failures.push("generated extension source is unavailable");
		} else {
			const imports = Array.from(
				output.extensionSource.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/g),
				(match) => match[1],
			);
			if (!imports.includes("@earendil-works/pi-coding-agent")) {
				failures.push("extension does not import the canonical @earendil-works/pi-coding-agent package");
			}
			if (imports.some((specifier) => specifier.startsWith("@mariozechner/"))) {
				failures.push("extension imports a legacy @mariozechner package");
			}
			if (imports.some((specifier) => specifier.startsWith("@sinclair/typebox"))) {
				failures.push('extension imports legacy "@sinclair/typebox" instead of "typebox"');
			}
		}
		if (output.extensionErrors.length > 0) failures.push("extension loader reported errors");
		if (!output.loadedExtensions.some(({ tools }) => tools.includes("hello"))) {
			failures.push('no loaded extension registered the "hello" tool');
		}
		if (
			!toolCalls.some(
				(call) =>
					call.name === "hello" &&
					call.status === "ok" &&
					call.arguments?.name === "Bob" &&
					call.result === "Hello, Bob!",
			)
		) {
			failures.push('no successful hello({ name: "Bob" }) call returned "Hello, Bob!"');
		}
		if (output.response !== "Hello, Bob!") failures.push('final response was not exactly "Hello, Bob!"');

		return {
			score: failures.length === 0 ? 1 : 0,
			metadata: {
				rationale: failures.length === 0 ? "Extension authoring workflow completed." : failures.join("; "),
			},
		};
	},
);

const extensionHarnessTable = evalHarnessTable("Pi extension authoring system prompt", {
	baseline: createExtensionAuthoringHarness("system-prompt-without-docs", excludeGuidelinesAndDocumentation),
	candidate: createExtensionAuthoringHarness("default-system-prompt", prepareDefaultPromptOverride),
});

describe.for(extensionHarnessTable)("$name", ({ harness }) => {
	describeEval(
		"Pi extension authoring system prompt",
		{ harness, judges: [ExtensionAuthoringJudge], judgeThreshold: null },
		(it) => {
			it("creates, reloads, and uses a hello extension", async ({ run, task }) => {
				const result = await run([
					{
						type: "prompt",
						content:
							"Create a Pi extension with a hello tool that takes a name and returns a greeting. For example, passing Bob should return `Hello, Bob!`.",
					},
					{ type: "reload" },
					{
						type: "prompt",
						content:
							"Use the hello tool to greet Bob. Respond with exactly the tool's greeting and nothing else.",
					},
				]);
				if (result.output.extensionSource !== null) {
					const runId = result.artifacts?.runId;
					if (typeof runId !== "string") throw new Error("Pi eval run did not record a run ID.");
					await recordEvalSourceArtifact(task, runId, {
						name: "hello.ts",
						contentType: "text/typescript",
						body: result.output.extensionSource,
						bodyEncoding: "utf-8",
					});
				}
				const expectsFullPrompt = harness.name === "default-system-prompt";
				expect(result.output.systemPromptHasGuidelines).toBe(expectsFullPrompt);
				expect(result.output.systemPromptHasPiDocs).toBe(expectsFullPrompt);
			});
		},
	);
});
