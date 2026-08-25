import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

const temporaryPaths: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryPaths.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryPaths.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	vi.useRealTimers();
});

describe("read speculation policy", () => {
	it("permits only direct local workspace targets that stay on the filesystem branch", async () => {
		const workspace = createTemporaryDirectory("read-speculation-workspace-");
		const outsideWorkspace = createTemporaryDirectory("read-speculation-outside-");
		writeFileSync(join(workspace, "plain.txt"), "plain UTF-8 text\n");
		mkdirSync(join(workspace, "directory"));
		writeFileSync(
			join(workspace, "image.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JXz0AAAAASUVORK5CYII=",
				"base64",
			),
		);
		writeFileSync(join(workspace, "document.pdf"), "%PDF-1.7\n");
		writeFileSync(join(workspace, "database.sqlite"), Buffer.from("SQLite format 3\u0000", "ascii"));
		writeFileSync(join(outsideWorkspace, "outside.txt"), "outside\n");

		const tool = createReadTool(workspace);
		const canExecute = tool.speculation?.canExecute;
		expect(canExecute).toBeDefined();
		if (!canExecute) throw new Error("Read tool must expose speculation policy");

		const check = async (path: string) =>
			await canExecute({
				toolCall: { type: "toolCall", id: `call-${path}`, name: "read", arguments: { path } },
				args: { path },
			});

		await expect(check("plain.txt")).resolves.toBe(true);
		await expect(check("directory")).resolves.toBe(true);
		await expect(check("https://example.invalid/readme.txt")).resolves.toBe(false);
		await expect(check("mcp://tool/readme.txt")).resolves.toBe(false);
		await expect(check("archive.zip:entry.txt")).resolves.toBe(false);
		await expect(check("database.sqlite?query=SELECT%201")).resolves.toBe(false);
		await expect(check("document.pdf")).resolves.toBe(false);
		await expect(check("image.png")).resolves.toBe(false);
		await expect(check("plain.txt:conflicts")).resolves.toBe(false);
		await expect(check(join(outsideWorkspace, "outside.txt"))).resolves.toBe(false);
		await expect(check("missing.txt")).resolves.toBe(false);
	});
});

describe("read speculative execution", () => {
	it("overlaps a real local read with provider generation and commits its sole physical result", async () => {
		vi.useFakeTimers();
		const workspace = createTemporaryDirectory("read-speculation-agent-");
		writeFileSync(join(workspace, "fixture.txt"), "fixture content\n");
		const model: Model<"openai-responses"> = {
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
		const run = async (enabled: boolean, path = "fixture.txt") => {
			const tool = createReadTool(workspace);
			const execute = tool.execute;
			let physicalExecutions = 0;
			let providerFinished = false;
			let executedBeforeProviderFinished = false;
			let signalPhysicalExecution = () => {};
			const physicalExecution = new Promise<void>((resolve) => {
				signalPhysicalExecution = resolve;
			});
			let signalProviderTailScheduled = () => {};
			const providerTailScheduled = new Promise<void>((resolve) => {
				signalProviderTailScheduled = resolve;
			});
			tool.execute = async (toolCallId, params, signal, onUpdate) => {
				physicalExecutions++;
				executedBeforeProviderFinished ||= !providerFinished;
				signalPhysicalExecution();
				return await execute(toolCallId, params, signal, onUpdate);
			};
			const telemetry: Array<{ outcome: string; overlapMs?: number }> = [];
			let providerCalls = 0;
			const agent = new Agent({
				initialState: { model, tools: [tool] },
				streamFn: () => {
					const response = new EventStream<AssistantMessageEvent, AssistantMessage>(
						(event) => event.type === "done" || event.type === "error",
						(event) => {
							if (event.type === "done") return event.message;
							if (event.type === "error") return event.error;
							throw new Error("Unexpected response event");
						},
					);
					providerCalls++;
					queueMicrotask(() => {
						if (providerCalls === 1) {
							const assistantMessage: AssistantMessage = {
								role: "assistant",
								content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path } }],
								api: "openai-responses",
								provider: "openai",
								model: "mock",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "toolUse",
								timestamp: Date.now(),
							};
							response.push({ type: "start", partial: assistantMessage });
							response.push({
								type: "toolcall_end",
								contentIndex: 0,
								toolCall: assistantMessage.content[0] as Extract<
									AssistantMessage["content"][number],
									{ type: "toolCall" }
								>,
								partial: assistantMessage,
							});
							setTimeout(() => {
								providerFinished = true;
								response.push({ type: "done", reason: "toolUse", message: assistantMessage });
							}, 400);
							signalProviderTailScheduled();
							return;
						}
						response.push({
							type: "done",
							reason: "stop",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "done" }],
								api: "openai-responses",
								provider: "openai",
								model: "mock",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
								timestamp: Date.now(),
							},
						});
					});
					return response;
				},
				...(enabled
					? { speculativeToolExecution: { enabled: true, onTelemetry: (event) => telemetry.push(event) } }
					: {}),
			});
			const completion = agent.prompt("read fixture");
			await providerTailScheduled;
			if (enabled && path === "fixture.txt") {
				await physicalExecution;
			} else {
				await Promise.resolve();
				await Promise.resolve();
			}
			vi.advanceTimersByTime(400);
			await completion;
			return {
				executedBeforeProviderFinished,
				physicalExecutions,
				telemetry,
				history: agent.state.messages.map((message) => {
					const { timestamp: _timestamp, ...stableMessage } = message;
					return stableMessage;
				}),
			};
		};

		const enabled = await run(true);
		const disabled = await run(false);

		expect(enabled.executedBeforeProviderFinished).toBe(true);
		expect(disabled.executedBeforeProviderFinished).toBe(false);
		expect(enabled.physicalExecutions).toBe(1);
		expect(disabled.physicalExecutions).toBe(1);
		expect(enabled.telemetry).toContainEqual(
			expect.objectContaining({ outcome: "committed", overlapMs: expect.any(Number) }),
		);
		expect(enabled.history).toEqual(disabled.history);
		const http = await run(true, "https://example.invalid/fixture.txt");

		expect(http.executedBeforeProviderFinished).toBe(false);
		expect(http.telemetry).toContainEqual(expect.objectContaining({ outcome: "ineligible" }));
	});
});
