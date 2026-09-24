import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type CodemodeToolDetails, createCodemodeTool } from "../../src/core/tools/codemode.ts";
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
