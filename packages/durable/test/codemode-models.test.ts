import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type AssistantImages,
	type ClassifierResult,
	createProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { MemoryStorage, ToolResultEntry, UsageDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";
import type { ExecutionEnv } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const USAGE = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A chat whose models also have a classifier and an image model of a test provider, and the code mode extension. */
function modelsChat() {
	const setup = chatSetup();
	const calls = { classify: 0, images: 0, inFlight: 0, maxInFlight: 0 };
	// \`atFour\`: hold classifier calls until four run, then a little longer, so a fifth would show up.
	const gate = { open: deferred(), atFour: false };
	gate.open.resolve();
	(setup.models as MutableModels).setProvider(
		createProvider({
			id: "test",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [
				{
					id: "judge",
					name: "Judge",
					api: "test-classifier",
					provider: "test",
					baseUrl: "https://example.invalid",
					input: ["text"],
					cost: COST,
					headers: { authorization: "secret" },
					type: "classifier",
					contextWindow: 1000,
				},
				{
					id: "painter",
					name: "Painter",
					api: "test-images",
					provider: "test",
					baseUrl: "https://example.invalid",
					input: ["text"],
					cost: COST,
					type: "image",
					output: ["image"],
				},
			],
			classifiers: {
				"test-classifier": {
					classify: async (model, classifierContext): Promise<ClassifierResult> => {
						calls.classify++;
						if ((classifierContext.state as { fail?: boolean }).fail === true) {
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: {},
								stopReason: "error",
								errorMessage: "quota exceeded",
								timestamp: 0,
							};
						}
						calls.inFlight++;
						calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
						if (gate.atFour && calls.inFlight === 4) setTimeout(() => gate.open.resolve(), 50);
						await gate.open.promise;
						calls.inFlight--;
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { good: { value: true } } as unknown as ClassifierResult["answers"],
							usage: USAGE,
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
			images: {
				"test-images": {
					generateImages: async (model): Promise<AssistantImages> => {
						calls.images++;
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							output: [{ type: "image", data: PNG, mimeType: "image/png" }],
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
		}),
	);
	setup.registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
	return { setup, calls, gate };
}

async function run(chat: ReturnType<typeof modelsChat>, code: string, env?: ExecutionEnv) {
	chat.setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "s1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const { harness, root } = await openChat(new MemoryStorage(), chat.setup, env === undefined ? {} : { env });
	await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	const message = entry.model![0] as { content: { type: string; text?: string }[]; details?: unknown };
	const text = message.content
		.map((item) => item.text ?? `<${item.type}>`)
		.join("")
		.replace(/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "");
	const usage = await harness.snapshot(UsageDoc, root.id, context);
	await harness.close(context);
	return { text, message, usage };
}

describe("code mode models.*", () => {
	it("reads the model catalog without credentials in headers", async () => {
		const chat = modelsChat();
		const { text } = await run(
			chat,
			`const classifiers = await models.getModelsOfType("classifier", "test");
			const one = await models.getModelOfType("classifier", "test", "judge");
			const available = await models.getAvailableOfType("image");
			return [classifiers.map((m) => m.id), one.id, "headers" in one, available.map((m) => m.id)];`,
		);
		expect(JSON.parse(text)).toEqual([["judge"], "judge", false, ["painter"]]);
	});

	it("classifies through an internal tool: a nested call with its usage, hidden from tools and listings", async () => {
		const chat = modelsChat();
		const { text, message, usage } = await run(
			chat,
			`const model = await models.getModelOfType("classifier", "test", "judge");
			const result = await models.classify(model, {
				state: { text: "hi" },
				questions: { good: { type: "bool", instructions: "Is it good?", criteria: { true: "yes", false: "no" } } },
			});
			const found = (await searchTools("classify generate images models")).length;
			const described = (await describeTool("pi.codemode.models.classify")) !== undefined;
			return [result.stopReason, result.answers.good.value, Object.keys(tools).some((name) => name.includes("models")), ALL_TOOLS.some((tool) => tool.name.includes("models")), found, described];`,
		);
		expect(JSON.parse(text)).toEqual(["stop", true, false, false, 0, false]);
		expect(chat.calls.classify).toBe(1);
		expect((message.details as { calls: { name: string; status: string }[] }).calls).toMatchObject([
			{ name: "models.classify", status: "ok" },
		]);
		// Counted once, under the internal tool, by the Harness.
		expect(usage?.tools["pi.codemode.models.classify"]?.cost.total).toBeCloseTo(0.0012);
	});

	it("resolves a model call that failed with its result, as the coding agent does", async () => {
		const chat = modelsChat();
		const { text, message } = await run(
			chat,
			`const model = await models.getModelOfType("classifier", "test", "judge");
			const result = await models.classify(model, {
				state: { fail: true },
				questions: { good: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } },
			});
			return [result.stopReason, result.errorMessage];`,
		);
		expect(JSON.parse(text)).toEqual(["error", "quota exceeded"]);
		// The row still shows the failure.
		expect((message.details as { calls: { name: string; status: string }[] }).calls).toMatchObject([
			{ name: "models.classify", status: "error" },
		]);
	});

	it("rejects a bad classifier context with the expected shape, before any request", async () => {
		const chat = modelsChat();
		const { text } = await run(
			chat,
			`const model = await models.getModelOfType("classifier", "test", "judge");
			try { await models.classify(model, { prompt: "x" }); } catch (error) { return error.message; }`,
		);
		expect(text).toContain("context.state must be an object");
		expect(text).toContain("Expected context:");
		expect(chat.calls.classify).toBe(0);
	});

	it("runs at most four model calls at once", async () => {
		const chat = modelsChat();
		chat.gate.open = deferred();
		chat.gate.atFour = true;
		const { text } = await run(
			chat,
			`const model = await models.getModelOfType("classifier", "test", "judge");
			const context = { state: {}, questions: { good: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } };
			return (await Promise.all(Array.from({ length: 8 }, () => models.classify(model, context)))).length;`,
		);
		expect(text).toBe("8");
		expect(chat.calls.classify).toBe(8);
		expect(chat.calls.maxInFlight).toBe(4);
	});

	it("does not start a model call that waited for a slot after the script ended", async () => {
		const chat = modelsChat();
		chat.gate.open = deferred();
		const directory = await mkdtemp(join(tmpdir(), "pi-codemode-models-"));
		// The result spills to a file after the script ended and before the tool returns. Then the running
		// calls finish and free their slots, which the two waiting calls would take.
		class SlowTempFiles extends NodeExecutionEnv {
			override async createTempDir(prefix: string | undefined, ctx: Context) {
				chat.gate.open.resolve();
				await new Promise((resolve) => setTimeout(resolve, 100));
				return super.createTempDir(prefix, ctx);
			}
		}
		try {
			const { text } = await run(
				chat,
				`const model = await models.getModelOfType("classifier", "test", "judge");
				const context = { state: {}, questions: { good: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } };
				for (let i = 0; i < 6; i++) models.classify(model, context).catch(() => {});
				// A journaled call after them: by its result, the first four have been launched.
				await models.getModelsOfType("image");
				return "x".repeat(60000);`,
				new SlowTempFiles({ cwd: directory }),
			);
			expect(text).toContain("[Full output: ");
			expect(chat.calls.classify).toBe(4);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("notes generated images the script did not show", async () => {
		const chat = modelsChat();
		const hidden = await run(
			chat,
			`const model = await models.getModelOfType("image", "test", "painter");
			const result = await models.generateImages(model, { input: [{ type: "text", text: "a cat" }] });
			return result.output.length;`,
		);
		expect(hidden.text).toContain("Note: models.generateImages() returned 1 image that the script did not show");
		const shown = await run(
			modelsChat(),
			`const model = await models.getModelOfType("image", "test", "painter");
			const result = await models.generateImages(model, { input: [{ type: "text", text: "a cat" }] });
			image(result.output[0]);`,
		);
		expect(shown.text).not.toContain("Note:");
		expect(shown.message.content.some((item) => item.type === "image")).toBe(true);
	});
});
