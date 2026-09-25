import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ClassifierModel, type ClassifierResult, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolDetails,
	createCodemodeTool,
	createCodemodeToolDefinition,
} from "../../src/core/tools/codemode.ts";
import { readCodemodeStore } from "../../src/core/tools/codemode-execute.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const echoSchema = Type.Object({ text: Type.String({ description: "Text to echo" }) });
const echoTool: AgentTool<typeof echoSchema> = {
	name: "echo",
	label: "Echo",
	description: "Echo text back.\n\nSecond paragraph that codemode omits.",
	parameters: echoSchema,
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `echo: ${params.text}` }],
		details: {},
	}),
};

const statsTool: AgentTool = {
	name: "stats",
	label: "Stats",
	description: "Return structured stats",
	parameters: Type.Object({}),
	outputSchema: Type.Object({ files: Type.Number(), names: Type.Array(Type.String()) }),
	execute: async () => ({
		content: [{ type: "text", text: "2 files" }],
		details: {},
		structuredContent: { files: 2, names: ["a", "b"] },
	}),
};

const screenshotTool: AgentTool = {
	name: "screenshot",
	label: "Screenshot",
	description: "Return a screenshot",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [
			{ type: "text", text: "captured" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		],
		details: {},
	}),
};

function codemodeResult(harness: Harness): ToolResultMessage {
	const result = harness.session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
	);
	if (!result) throw new Error("No codemode tool result");
	return result;
}

function resultText(message: ToolResultMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

describe("AgentSession codemode tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(extensionFactories?: HarnessOptions["extensionFactories"]) {
		const harness = await createHarness({
			tools: [echoTool as AgentTool, statsTool, screenshotTool, createCodemodeTool() as AgentTool],
			extensionFactories,
		});
		harnesses.push(harness);
		return harness;
	}

	it("declares the other active tools in its description", async () => {
		const harness = await setup();
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).toContain("declare const tools: {");
		expect(codemode?.description).toContain("/** Echo text back. */");
		expect(codemode?.description).not.toContain("Second paragraph");
		expect(codemode?.description).toContain("/** Text to echo */");
		expect(codemode?.description).toContain("}): Promise<string>;");
		expect(codemode?.description).toContain("stats(args?: Record<string, unknown>): Promise<{");
		expect(codemode?.description).toContain("declare function image(args: string): Promise<null>;");
		expect(codemode?.description).not.toMatch(/\bcodemode\(args/);

		harness.session.setActiveToolsByName(["echo", "codemode"]);
		const narrowed = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(narrowed?.description).toContain("echo(args");
		expect(narrowed?.description).not.toContain("stats(args");
	});

	it("runs nested calls in parallel and returns only the script result", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [a, b, stats] = await Promise.all([
								tools.echo({ text: "one" }),
								tools.echo({ text: "two" }),
								tools.stats({}),
							]);
							console.log("files", stats.files);
							return { a, b, names: stats.names };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.isError).toBe(false);
		expect(JSON.parse(resultText(result).split("\n\nConsole:")[0])).toEqual({
			a: "echo: one",
			b: "echo: two",
			names: ["a", "b"],
		});
		expect(resultText(result)).toContain("Console:\nfiles 2");
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.status])).toEqual([
			["echo", "ok"],
			["echo", "ok"],
			["stats", "ok"],
		]);
		expect(details.calls.every((call) => call.id.startsWith(`${result.toolCallId}/`))).toBe(true);
		// Nested calls never become transcript tool results or top-level tool events.
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		const started = harness.eventsOfType("tool_execution_start").map((event) => event.toolName);
		expect(started).toEqual(["codemode"]);
		const updates = harness.eventsOfType("tool_execution_update");
		expect(updates.length).toBeGreaterThan(0);
	});

	it("routes nested calls through extension hooks", async () => {
		const seen: string[] = [];
		const harness = await setup([
			(pi) => {
				pi.on("tool_call", (event) => {
					seen.push(`${event.toolName}:${event.parentToolCallId ?? "top"}`);
					if (event.toolName === "echo" && (event.input as { text: string }).text === "forbidden") {
						return { block: true, reason: "echo of forbidden text is blocked" };
					}
					return undefined;
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "stats") {
						return { content: [{ type: "text", text: "redacted" }] };
					}
					return undefined;
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							let blocked;
							try {
								await tools.echo({ text: "forbidden" });
							} catch (error) {
								blocked = error.message;
							}
							const stats = await tools.stats({});
							return { blocked, stats };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		const parent = result.toolCallId;
		expect(seen).toEqual(["codemode:top", `echo:${parent}`, `stats:${parent}`]);
		// Replacing content without replacing structured content drops the structured result.
		expect(JSON.parse(resultText(result))).toEqual({
			blocked: "echo of forbidden text is blocked",
			stats: "redacted",
		});
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => call.status)).toEqual(["error", "ok"]);
	});

	it("attaches images only when the script asks for them", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const shot = await tools.screenshot({});
							await tools.screenshot({});
							image(shot);
							return shot;
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(resultText(result)).toBe("captured\n[image:1 image/png]\n<image>");
	});

	it("reports script failures with the calls that already ran", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: `await tools.echo({ text: "x" });\nthrow new Error("boom");` })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.isError).toBe(true);
		const text = resultText(result);
		expect(text).toContain("Error: boom");
		expect(text).toContain("codemode.js:2");
		expect(text).toContain("Tool calls made before the failure (they are not undone): echo (ok)");
	});
});

describe("codemode options and store", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// No tools override: the session builds its own codemode tool, including the store writer.
	async function setup() {
		const harness = await createHarness({ initialActiveToolNames: ["codemode"] });
		harnesses.push(harness);
		return harness;
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
		);
		const result = results.at(-1);
		if (!result) throw new Error("No codemode tool result");
		return result;
	}

	function storeEntries(harness: Harness): unknown[] {
		return harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE,
			)
			.map((entry) => entry.data);
	}

	const increment = `const next = (load("count") ?? 0) + 1;\nstore("count", next);\nreturn next;`;

	it("declares a grammar for raw source input", () => {
		const definition = createCodemodeToolDefinition();
		expect(definition.constrainedSampling).toEqual({
			type: "grammar",
			variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
		});
		expect(Object.keys(definition.parameters.properties)).toEqual(["code"]);
		expect(definition.description).toContain("declare function store(key: string, value: unknown): void;");
	});

	it("applies the @options timeout and rejects invalid options", async () => {
		const harness = await setup();
		const timedOut = await run(harness, '// @options {"timeout": 0.2}\nwhile (true) {}');
		expect(timedOut.isError).toBe(true);
		expect(resultText(timedOut)).toContain("Script timed out");

		const invalid = await run(harness, '// @options {"yield": 1}\nreturn 1');
		expect(invalid.isError).toBe(true);
		expect(resultText(invalid)).toContain('Unknown @options key "yield"');
	});

	it("keeps script line numbers when an options line is present", async () => {
		const harness = await setup();
		const result = await run(harness, '// @options {"timeout": 5}\nconst a = 1;\nthrow new Error("line three");');
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("codemode.js:3");
	});

	it("persists store() writes as custom entries for later calls", async () => {
		const harness = await setup();
		expect(resultText(await run(harness, increment))).toBe("1");
		expect(resultText(await run(harness, increment))).toBe("2");
		expect(storeEntries(harness)).toEqual([
			{ set: { count: 1 }, delete: [] },
			{ set: { count: 2 }, delete: [] },
		]);
		const appended = harness
			.eventsOfType("entry_appended")
			.filter((event) => event.entry.type === "custom" && event.entry.customType === CODEMODE_STORE_ENTRY_TYPE);
		expect(appended).toHaveLength(2);

		expect(resultText(await run(harness, 'store("count", undefined);\nreturn load("count") === undefined;'))).toBe(
			"true",
		);
		expect(storeEntries(harness).at(-1)).toEqual({ set: {}, delete: ["count"] });
	});

	it("appends nothing for failed scripts or scripts without writes", async () => {
		const harness = await setup();
		expect((await run(harness, 'store("count", 5);\nthrow new Error("boom");')).isError).toBe(true);
		expect((await run(harness, 'return load("count") ?? "missing";')).isError).toBe(false);
		expect(storeEntries(harness)).toEqual([]);
	});

	it("loads the values written on the current branch", async () => {
		const harness = await setup();
		await run(harness, increment);
		const firstPrompt = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstPrompt) throw new Error("No first prompt entry");
		expect(resultText(await run(harness, increment))).toBe("2");

		// Branch from the first prompt: the store entries written after it are on another path.
		harness.sessionManager.branch(firstPrompt.id);
		expect(resultText(await run(harness, increment))).toBe("1");
	});

	it("folds store entries from the root, ignoring malformed data", () => {
		const entry = (data: unknown, customType = CODEMODE_STORE_ENTRY_TYPE): CustomEntry => ({
			type: "custom",
			customType,
			data,
			id: Math.random().toString(36).slice(2),
			parentId: null,
			timestamp: new Date(0).toISOString(),
		});
		expect(
			readCodemodeStore([
				entry({ set: { a: 1, b: { c: 2 } }, delete: [] }),
				entry({ set: { a: 3 }, delete: ["b"] }),
				entry({ set: { z: 1 } }),
				entry({ set: { other: 1 }, delete: [] }, "other-extension"),
			]),
		).toEqual({ a: 3 });
	});
});

describe("codemode models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const scorerModel: ClassifierModel<"test-classifier"> = {
		type: "classifier",
		id: "judge",
		name: "Judge",
		api: "test-classifier",
		provider: "scorer",
		baseUrl: "https://classifier.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		headers: { "X-Secret": "hunter2" },
	};

	interface ClassifyObservation {
		baseUrl: string;
		apiKey: string | undefined;
		text: unknown;
	}

	async function setup() {
		const harness = await createHarness({ initialActiveToolNames: ["codemode"] });
		harnesses.push(harness);
		const observed: ClassifyObservation[] = [];
		let active = 0;
		let maxActive = 0;
		harness.session.modelRuntime.registerProvider("scorer", {
			apiKey: "secret-key",
			models: [scorerModel],
			classifiers: {
				"test-classifier": {
					classify: async (model, context, options): Promise<ClassifierResult> => {
						active++;
						maxActive = Math.max(maxActive, active);
						await new Promise((resolve) => setTimeout(resolve, 10));
						active--;
						const text = context.state.text;
						observed.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, text });
						if (text === "explode") {
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: {},
								stopReason: "error",
								errorMessage: "classifier exploded",
								timestamp: 0,
							};
						}
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { approved: { type: "bool", probability: text === "good" ? 0.9 : 0.1 } },
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
		});
		harness.session.setActiveToolsByName(["codemode"]);
		return { harness, observed, maxActive: () => maxActive };
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return codemodeResult(harness);
	}

	const questions = `{ approved: { type: "bool", instructions: "Approval?", criteria: { true: "yes", false: "no" } } }`;

	it("declares models only for the session's own codemode tool", async () => {
		const { harness } = await setup();
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).toContain("declare const models: {");
		expect(codemode?.description).toContain(
			"classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>;",
		);
		expect(codemode?.description).toContain("interface ClassifierResult {");

		const overridden = await createHarness({ tools: [createCodemodeTool() as AgentTool] });
		harnesses.push(overridden);
		const plain = overridden.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(plain?.description).not.toContain("declare const models");
	});

	it("lists models and classifies with catalog auth, ignoring script-supplied fields", async () => {
		const { harness, observed, maxActive } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("classifier", "scorer");
			const listed = await models.getModelsOfType("classifier");
			const same = await models.getModelOfType("classifier", "scorer", "judge");
			const texts = ["good", "bad", "good", "bad", "good", "bad"];
			const results = await Promise.all(
				texts.map((text) => models.classify({ ...model, baseUrl: "https://evil.test" }, { state: { text }, questions: ${questions} })),
			);
			return {
				id: model.id,
				headers: "headers" in model,
				listed: listed.some((entry) => entry.provider === "scorer" && entry.id === "judge"),
				same: same.id,
				missing: (await models.getModelOfType("classifier", "scorer", "nope")) === undefined,
				probabilities: results.map((r) => r.answers.approved.probability),
			};
		`,
		);
		expect(result.isError).toBe(false);
		expect(JSON.parse(resultText(result))).toEqual({
			id: "judge",
			headers: false,
			listed: true,
			same: "judge",
			missing: true,
			probabilities: [0.9, 0.1, 0.9, 0.1, 0.9, 0.1],
		});
		expect(observed).toHaveLength(6);
		expect(
			observed.every((entry) => entry.baseUrl === "https://classifier.test/v1" && entry.apiKey === "secret-key"),
		).toBe(true);
		// Six classifications with at most four in flight.
		expect(maxActive()).toBe(4);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.args, call.status])).toEqual(
			Array.from({ length: 6 }, () => ["models.classify", "scorer/judge", "ok"]),
		);
	});

	it("reports provider errors as results and invalid arguments as exceptions", async () => {
		const { harness } = await setup();
		const result = await run(
			harness,
			`
			const model = await models.getModelOfType("classifier", "scorer", "judge");
			const failed = await models.classify(model, { state: { text: "explode" }, questions: ${questions} });
			const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
			return {
				failed: [failed.stopReason, failed.errorMessage],
				badType: await attempt(() => models.getModelsOfType("video")),
				unknown: await attempt(() => models.classify({ provider: "scorer", id: "nope" }, {})),
				noModel: await attempt(() => models.classify("judge", {})),
			};
		`,
		);
		expect(result.isError).toBe(false);
		const value = JSON.parse(resultText(result));
		expect(value.failed).toEqual(["error", "classifier exploded"]);
		expect(value.badType).toContain('Unknown model type "video"');
		expect(value.unknown).toBe('Unknown classifier model "scorer/nope"');
		expect(value.noModel).toContain("expects a model");
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.status, call.error])).toEqual([
			["models.classify", "error", "classifier exploded"],
		]);
	});
});
