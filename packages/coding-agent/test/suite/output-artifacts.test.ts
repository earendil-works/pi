import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../../src/core/exec.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { getOutputArtifacts, OutputArtifacts } from "../../src/core/output-artifacts.ts";
import { readArtifact } from "../../src/core/read-artifact.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ReadToolDetails } from "../../src/core/tools/read.ts";
import { createMcpToolDefinition } from "../../src/extensions/mcp/tools.ts";
import { createHarness, getMessageText, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const fixtures: Array<{ harness: Harness; directory: string }> = [];

async function fixture(options: HarnessOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-artifact-test-"));
	const harness = await createHarness({
		...options,
		sessionManager: options.sessionManager ?? SessionManager.create(directory, join(directory, "sessions")),
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...options.settings },
	});
	fixtures.push({ harness, directory });
	await harness.session.bindExtensions({});
	return harness;
}

function emitter(text: string) {
	return (pi: ExtensionAPI) =>
		pi.registerTool({
			name: "large_output",
			label: "large output",
			description: "Produce retained text for inspection",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text }], details: {} }),
		});
}

function uriIn(text: string): string {
	const uri = /artifact:\/\/(?:temporary\/)?[a-f0-9]{64}\/[a-f0-9-]{36}/.exec(text)?.[0];
	if (!uri) throw new Error("No retained artifact reference");
	return uri;
}

async function emit(harness: Harness): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("large_output", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Output retained"),
	]);
	await harness.session.prompt("Inspect the tool output");
	return uriIn(getMessageText(getToolResult(harness, "large_output")));
}

afterEach(async () => {
	for (const { harness, directory } of fixtures.splice(0)) {
		await harness.session.abort();
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("session-owned output artifacts", () => {
	it("retains the post-hook text privately without putting omitted bytes in chat history", async () => {
		const secret = "PRIVATE_SERVER_CREDENTIAL";
		const payload = `${"evidence\n".repeat(1000)}${secret}`;
		const harness = await fixture({
			settings: { outputArtifacts: { maxInlineTokens: 128 } },
			extensionFactories: [
				emitter(payload),
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName !== "large_output") return;
						return { content: [{ type: "text", text: getMessageText(event).replace(secret, "REDACTED_TAIL") }] };
					});
				},
			],
		});
		const uri = await emit(harness);
		const store = getOutputArtifacts(harness.sessionManager)!;
		const retained = readFileSync(store.resolve(uri), "utf8");
		expect(retained).toBe(payload.replace(secret, "REDACTED_TAIL"));
		const history = readFileSync(harness.sessionManager.getSessionFile()!, "utf8");
		expect(history).not.toContain("REDACTED_TAIL");
		expect(history).not.toContain(secret);
		const visible = getMessageText(getToolResult(harness, "large_output"));
		expect(visible.length).toBeLessThanOrEqual(store.budget().maxChars);
		expect(visible.slice(0, 256)).toContain(uri);
		if (process.platform !== "win32") expect(statSync(store.resolve(uri)).mode & 0o777).toBe(0o600);
	});

	it.each([
		{ maxInlineTokens: 128, contextWindowFraction: 0.05, payload: `BEGIN🚀${"汉字🚀".repeat(400)}END` },
		{ maxInlineTokens: 40_000, contextWindowFraction: 1, payload: `BEGIN${"q".repeat(150_000)}END` },
	])(
		"reassembles pages without overlap, broken Unicode, or recursive artifacts ($maxInlineTokens tokens)",
		async ({ payload, ...outputArtifacts }) => {
			const harness = await fixture({ settings: { outputArtifacts }, extensionFactories: [emitter(payload)] });
			const parts: string[] = [];
			let uri: string | undefined;
			let previousEnd = 0;
			let exhausted = false;
			const next: FauxResponseFactory = () => {
				if (!uri) {
					uri = uriIn(getMessageText(getToolResult(harness, "large_output")));
					return fauxAssistantMessage([fauxToolCall("read", { path: uri })], { stopReason: "toolUse" });
				}
				const result = getToolResult(harness, "read");
				// Only the native read tool produced this result; its metadata is not part of model text.
				const page = (result.details as ReadToolDetails).artifactPage!;
				expect(page.byteOffset).toBe(previousEnd);
				expect(page.endByteOffset).toBeGreaterThan(page.byteOffset);
				previousEnd = page.endByteOffset;
				parts.push(result.content.find((block) => block.type === "text")?.text ?? "");
				const visible = getMessageText(result);
				const budget = getOutputArtifacts(harness.sessionManager)!.budget();
				expect(visible.length).toBeLessThanOrEqual(budget.maxChars);
				expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(budget.maxBytes);
				if (page.nextByteOffset === undefined) {
					exhausted = true;
					return fauxAssistantMessage("All evidence retrieved");
				}
				expect(visible).toContain(`byteOffset=${page.nextByteOffset}`);
				return fauxAssistantMessage([fauxToolCall("read", { path: uri, byteOffset: page.nextByteOffset })], {
					stopReason: "toolUse",
				});
			};
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("large_output", {})], { stopReason: "toolUse" }),
				...Array.from({ length: 100 }, () => next),
			]);
			await harness.session.prompt("Retrieve the entire retained output in bounded pages");
			expect(exhausted).toBe(true);
			expect(parts.join("")).toBe(payload);
			const path = getOutputArtifacts(harness.sessionManager)!.resolve(uri!);
			expect(readdirSync(dirname(path))).toEqual([basename(path)]);
		},
	);

	it("honors line ranges and rejects invalid or escaping artifact requests", async () => {
		const harness = await fixture();
		const store = getOutputArtifacts(harness.sessionManager)!;
		const saved = await store.save([{ type: "text", text: "one\ntwo🚀\nthree\nfour" }]);
		const page = await readArtifact(store, { path: saved.uri, offset: 2, limit: 2 });
		expect(page.structuredContent).toBe("two🚀\nthree\n");
		const continuation = await readArtifact(store, {
			path: saved.uri,
			byteOffset: page.details.artifactPage.nextByteOffset,
		});
		expect(continuation.structuredContent).toBe("four");
		await expect(readArtifact(store, { path: saved.uri, offset: 10 })).rejects.toThrow("beyond");
		await expect(readArtifact(store, { path: saved.uri, offset: 1, byteOffset: 0 })).rejects.toThrow("not both");
		await expect(readArtifact(store, { path: "artifact://../outside" })).rejects.toThrow("Invalid artifact URI");
		const controller = new AbortController();
		controller.abort();
		await expect(readArtifact(store, { path: saved.uri }, controller.signal)).rejects.toThrow();
	});

	it("adapts to model limits and settings without spilling an exact-boundary result", async () => {
		const harness = await fixture({
			models: [
				{ id: "small", contextWindow: 4000 },
				{ id: "large", contextWindow: 8000 },
			],
		});
		const store = getOutputArtifacts(harness.sessionManager)!;
		const boundary = [{ type: "text" as const, text: "a".repeat(800) }];
		expect(await store.limit(boundary)).toBe(boundary);
		const above = await store.limit([{ type: "text", text: "a".repeat(801) }]);
		expect(uriIn(getMessageText({ content: above }))).toBeDefined();
		await harness.session.setModel(harness.getModel("large")!);
		expect(await store.limit([{ type: "text", text: "a".repeat(801) }])).toEqual([
			{ type: "text", text: "a".repeat(801) },
		]);
		harness.settingsManager.applyOverrides({ outputArtifacts: { maxInlineTokens: 128 } });
		const limited = await store.limit(boundary);
		expect(getMessageText({ content: limited }).length).toBeLessThanOrEqual(512);
		expect(readFileSync(store.resolve(uriIn(getMessageText({ content: limited }))), "utf8")).toBe(boundary[0].text);
	});

	it("retains all text around attachments without writing image data into the text artifact", async () => {
		const harness = await fixture({ settings: { outputArtifacts: { maxInlineTokens: 128 } } });
		const store = getOutputArtifacts(harness.sessionManager)!;
		const image = { type: "image" as const, mimeType: "image/png", data: "PRIVATE_IMAGE_DATA" };
		const first = "Before image\n".repeat(200);
		const last = "Evidence after image";
		const limited = await store.limit([{ type: "text", text: first }, image, { type: "text", text: last }]);
		expect(limited.filter((block) => block.type === "image")).toEqual([image]);
		const body = readFileSync(store.resolve(uriIn(getMessageText({ content: limited }))), "utf8");
		expect(body).toBe(`${first}\n${last}`);
		expect(body).not.toContain(image.data);
	});

	it("keeps full MCP structured results usable by nested consumers while bounding direct model output", async () => {
		const payload = `${"record\n".repeat(5000)}FINAL_MCP_EVIDENCE`;
		const harness = await fixture({
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createMcpToolDefinition({
							server: "local",
							name: "mcp__local__large",
							exposure: "direct",
							namespace: { name: "local" },
							timeoutMs: 1000,
							tool: { name: "large", inputSchema: { type: "object" } },
							getClient: async () => ({
								callTool: async () => ({
									content: [{ type: "text", text: payload }],
									structuredContent: { evidence: "FINAL_MCP_EVIDENCE" },
								}),
							}),
						}),
					);
					pi.registerTool({
						name: "consume_mcp",
						label: "consume",
						description: "Extract final evidence",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							const outcome = await ctx.executeTool("mcp__local__large", {});
							// This adapter's declared output is a CallToolResult, not its bounded model preview.
							const value = outcome.result.structuredContent as {
								content: Array<{ type: string; text?: string }>;
								structuredContent: { evidence: string };
							};
							const original = value.content.find((block) => block.type === "text")?.text ?? "";
							return {
								content: [
									{
										type: "text",
										text: original.endsWith(value.structuredContent.evidence)
											? value.structuredContent.evidence
											: "MISSING_EVIDENCE",
									},
								],
								details: {},
							};
						},
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__local__large", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("consume_mcp", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Consumed final evidence"),
		]);
		await harness.session.prompt("Read and consume the complete MCP result");
		const direct = getToolResult(harness, "mcp__local__large");
		const store = getOutputArtifacts(harness.sessionManager)!;
		expect(readFileSync(store.resolve(uriIn(getMessageText(direct))), "utf8")).toBe(payload);
		expect(getMessageText(getToolResult(harness, "consume_mcp"))).toBe("FINAL_MCP_EVIDENCE");
		expect(getMessageText(direct).length).toBeLessThanOrEqual(store.budget().maxChars);
		expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).not.toContain(
			JSON.stringify(payload).slice(1, -1),
		);
	});

	it.each([0, 128])(
		"streams complete command output instead of killing its producer at a %d-byte string cap",
		async (maxBuffer) => {
			const harness = await fixture();
			const path = join(harness.tempDir, "produce.mjs");
			writeFileSync(
				path,
				'import { once } from "node:events";\nprocess.stdout.write("BEGIN\\n");\nfor (let i = 0; i < 32; i++) { if (!process.stdout.write("a".repeat(65536))) await once(process.stdout, "drain"); }\nprocess.stdout.write("\\nEND\\n");\n',
			);
			const result = await execCommand(process.execPath, [path], harness.tempDir, {
				maxBuffer,
				outputArtifacts: getOutputArtifacts(harness.sessionManager),
			});
			expect(result.killed).toBe(false);
			expect(result.code).toBe(0);
			expect(result.truncated).toBe(true);
			expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxBuffer);
			expect(readFileSync(result.artifact!.path, "utf8")).toBe(`BEGIN\n${"a".repeat(32 * 65536)}\nEND\n`);
		},
	);

	it("does not require artifact storage for short output, and reports spill failures through the producer signal", async () => {
		const harness = await fixture();
		writeFileSync(join(harness.tempDir, "artifacts"), "not a directory");
		const store = getOutputArtifacts(harness.sessionManager)!;
		const short = store.capture();
		short.output.append(Buffer.from("ok"));
		short.output.finish();
		await short.output.closeTempFile();
		expect(short.output.snapshot().content).toBe("ok");
		expect(short.artifact).toBeUndefined();
		const large = store.capture();
		large.output.append(Buffer.alloc(100_000, 97));
		expect(large.output.fileErrorSignal.aborted).toBe(true);
		large.output.finish();
		await expect(large.output.closeTempFile()).rejects.toThrow();
	});

	it("keeps parent and child storage separate and can resume artifact reads after compaction", async () => {
		const payload = `first\n${"middle".repeat(1000)}\nRESUMABLE_EVIDENCE`;
		const harness = await fixture({
			settings: { compaction: { enabled: false, keepRecentTokens: 0 }, outputArtifacts: { maxInlineTokens: 128 } },
			extensionFactories: [emitter(payload)],
		});
		const uri = await emit(harness);
		const store = getOutputArtifacts(harness.sessionManager)!;
		const childOwner = SessionManager.create(harness.tempDir, join(harness.tempDir, "child-sessions"));
		const child = new OutputArtifacts(
			childOwner,
			join(harness.tempDir, "artifacts"),
			() => undefined,
			() => 128_000,
		);
		const before = readFileSync(harness.sessionManager.getSessionFile()!, "utf8");
		const childArtifact = await child.save([{ type: "text", text: "PRIVATE_CHILD_ARTIFACT" }]);
		expect(dirname(childArtifact.path)).not.toBe(dirname(store.resolve(uri)));
		expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).toBe(before);
		harness.setResponses([
			fauxAssistantMessage("Another turn"),
			fauxAssistantMessage(`Retained evidence: ${uri}`),
			fauxAssistantMessage(`Turn evidence: ${uri}`),
		]);
		await harness.session.prompt("Keep this evidence for later");
		await harness.session.compact();
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.open(harness.sessionManager.getSessionFile()!),
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			tools: ["read"],
		});
		try {
			await resumed.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: uri, offset: 3, limit: 1 })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Recovered evidence"),
			]);
			await resumed.session.prompt("Recover the original final line");
			const read = resumed.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "read",
			);
			expect(getMessageText(read)).toContain("RESUMABLE_EVIDENCE");
			expect(readFileSync(store.resolve(uri), "utf8")).toBe(payload);
		} finally {
			await resumed.session.abort();
			resumed.session.dispose();
		}
	});

	it("lets temporary side sessions read persisted references without mixing their output storage", async () => {
		const harness = await fixture();
		const parent = getOutputArtifacts(harness.sessionManager)!;
		const memory = new OutputArtifacts(
			SessionManager.inMemory(harness.tempDir),
			join(harness.tempDir, "artifacts"),
			() => undefined,
			() => 128_000,
		);
		const persisted = await parent.save([{ type: "text", text: "PERSISTED_PARENT_EVIDENCE" }]);
		const temporary = await memory.save([{ type: "text", text: "TEMPORARY_SIDE_EVIDENCE" }]);
		expect((await readArtifact(memory, { path: persisted.uri })).structuredContent).toBe("PERSISTED_PARENT_EVIDENCE");
		expect((await readArtifact(parent, { path: temporary.uri })).structuredContent).toBe("TEMPORARY_SIDE_EVIDENCE");
		expect(dirname(persisted.path)).not.toBe(dirname(temporary.path));
	});

	it.each(["failure", "message_end"] as const)(
		"retains oversized %s text without losing its diagnostic tail",
		async (mode) => {
			const payload = `${"diagnostic-line\n".repeat(400)}FINAL_DIAGNOSTIC`;
			const harness = await fixture({
				settings: { outputArtifacts: { maxInlineTokens: 128 } },
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "large_output",
							label: "diagnostic",
							description: "Inspect diagnostics",
							parameters: Type.Object({}),
							execute: async () => {
								if (mode === "failure") throw new Error(payload);
								return { content: [{ type: "text", text: "small result" }], details: {} };
							},
						});
						if (mode === "message_end")
							pi.on("message_end", (event) => {
								if (event.message.role !== "toolResult" || event.message.toolName !== "large_output") return;
								return { message: { ...event.message, content: [{ type: "text", text: payload }] } };
							});
					},
				],
			});
			const uri = await emit(harness);
			const result = getToolResult(harness, "large_output");
			const store = getOutputArtifacts(harness.sessionManager)!;
			expect(result.isError).toBe(mode === "failure");
			expect(getMessageText(result).length).toBeLessThanOrEqual(store.budget().maxChars);
			expect(readFileSync(store.resolve(uri), "utf8")).toContain(payload);
			expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).not.toContain("FINAL_DIAGNOSTIC");
		},
	);
});
