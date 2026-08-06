import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { MemoryStore, SUMMARY_TAG } from "../src/memory/index.ts";
import type { ServerResponse } from "../src/protocol.ts";
import { RpServer } from "../src/server.ts";
import { buildPngWithCard } from "./png-util.ts";

class MemoryIO {
	public lines: string[] = [];

	write(line: string): void {
		this.lines.push(line);
	}

	responses(): ServerResponse[] {
		return this.lines.map((line) => JSON.parse(line) as ServerResponse);
	}
}

function createTestServer(): { server: RpServer; io: MemoryIO } {
	const io = new MemoryIO();
	const server = new RpServer(io);
	return { server, io };
}

describe("rp-server", () => {
	it("responds to ping", async () => {
		const { server, io } = createTestServer();
		await server.handleLine(JSON.stringify({ type: "ping" }));
		expect(io.responses()).toEqual([{ type: "pong" }]);
	});

	it("errors on prompt before init", async () => {
		const { server, io } = createTestServer();
		await server.handleLine(JSON.stringify({ type: "prompt", text: "hello" }));
		const responses = io.responses();
		expect(responses[0]).toMatchObject({ type: "error", error: "Server not initialized; send init first" });
	});

	it("rejects malformed requests", async () => {
		const { server, io } = createTestServer();
		await server.handleLine("not json");
		expect(io.responses()[0]).toMatchObject({ type: "error" });
		await server.handleLine(JSON.stringify({ type: "bogus" }));
		expect(io.responses()[1]).toMatchObject({ type: "error" });
	});

	it("runs a roleplay prompt with the faux provider", async () => {
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: {
						model: {
							id: model.id,
							api: faux.api,
							provider: model.provider,
							baseUrl: model.baseUrl,
						},
						systemPrompt: "You are a tavern keeper.",
						thinkingLevel: "off",
					},
				}),
			);
			expect(io.responses()[0]).toEqual({ type: "ready" });

			faux.setResponses([fauxAssistantMessage("Welcome to the Rusty Lantern!")]);

			io.lines.length = 0;
			await server.handleLine(JSON.stringify({ type: "prompt", text: "Do you have a room?" }));

			const responses = io.responses();
			const events = responses.filter((response) => response.type === "event");

			expect(responses.at(-1)).toEqual({ type: "result" });
			expect(events.some((response) => response.type === "event" && response.event.type === "agent_start")).toBe(
				true,
			);
			expect(events.some((response) => response.type === "event" && response.event.type === "agent_end")).toBe(true);
			expect(events.some((response) => response.type === "event" && response.event.type === "turn_end")).toBe(true);

			const textEvents = events.filter(
				(response) => response.type === "event" && response.event.type === "message_update",
			);
			expect(textEvents.length).toBeGreaterThan(0);

			const agentEnd = events.find(
				(response): response is Extract<ServerResponse, { type: "event" }> =>
					response.type === "event" && response.event.type === "agent_end",
			);
			const transcript = agentEnd?.event.type === "agent_end" ? agentEnd.event.messages : [];
			const assistantMessage = transcript.find((message: AgentMessage) => message.role === "assistant");
			expect(assistantMessage).toBeDefined();
			const text = (assistantMessage as { content: Array<{ type: "text"; text: string }> }).content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			expect(text).toContain("Welcome to the Rusty Lantern!");
		} finally {
			faux.unregister();
		}
	});

	it("loads a character card and injects greeting + persona into context", async () => {
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: { model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl } },
				}),
			);
			io.lines.length = 0;

			const cardJson = JSON.stringify({
				spec: "chara_card_v2",
				data: { name: "阿琳", description: "酒馆老板娘", first_mes: "欢迎光临～" },
			});

			let seenSystemPrompt = "";
			let greetingInContext = false;
			faux.setResponses([
				(context) => {
					seenSystemPrompt = context.systemPrompt ?? "";
					greetingInContext = context.messages.some(
						(message) => message.role === "assistant" && JSON.stringify(message.content).includes("欢迎光临～"),
					);
					return fauxAssistantMessage("要喝一杯吗？");
				},
			]);

			await server.handleLine(JSON.stringify({ type: "card", format: "json", data: cardJson }));
			const responses = io.responses();
			expect(responses[0]).toMatchObject({
				type: "card_loaded",
				name: "阿琳",
				greeting: "欢迎光临～",
			});

			io.lines.length = 0;
			await server.handleLine(JSON.stringify({ type: "prompt", text: "来一杯麦酒" }));
			expect(io.responses().at(-1)).toEqual({ type: "result" });
			expect(seenSystemPrompt).toContain("You are 阿琳.");
			expect(seenSystemPrompt).toContain("酒馆老板娘");
			expect(seenSystemPrompt).toContain("Never break character");
			expect(greetingInContext).toBe(true);
		} finally {
			faux.unregister();
		}
	});

	it("rejects a card with an invalid format", async () => {
		const { server, io } = createTestServer();
		await server.handleLine(JSON.stringify({ type: "card", format: "bogus", data: "{}" }));
		expect(io.responses()[0]).toMatchObject({ type: "error" });
	});

	it("loads a card from a PNG payload", async () => {
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: { model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl } },
				}),
			);
			io.lines.length = 0;

			const cardJson = JSON.stringify({ name: "PNG角色", first_mes: "从 PNG 来的你好" });
			const encoded = Buffer.from(buildPngWithCard(cardJson)).toString("base64");
			await server.handleLine(JSON.stringify({ type: "card", format: "png", data: encoded }));
			expect(io.responses()[0]).toMatchObject({ type: "card_loaded", name: "PNG角色" });
		} finally {
			faux.unregister();
		}
	});

	it("registers memory tools and injects relevant memories into the system prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const store = new MemoryStore(join(dir, "memory.json"));
			store.add("阿琳养了一只叫煤球的猫，猫很粘人", ["pet"]);
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: {
						model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl },
						memoryDir: dir,
					},
				}),
			);
			io.lines.length = 0;

			let seenSystemPrompt = "";
			let toolNames: string[] = [];
			faux.setResponses([
				(context) => {
					seenSystemPrompt = context.systemPrompt ?? "";
					toolNames = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage("好的。");
				},
			]);
			await server.handleLine(JSON.stringify({ type: "prompt", text: "你的猫呢？" }));
			expect(io.responses().at(-1)).toEqual({ type: "result" });
			expect(toolNames).toContain("memory_search");
			expect(toolNames).toContain("memory_remember");
			expect(seenSystemPrompt).toContain("## Relevant memories");
			expect(seenSystemPrompt).toContain("煤球");
		} finally {
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes a memory_search tool call during the agent loop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const store = new MemoryStore(join(dir, "memory.json"));
			store.add("客人的名字叫叶轻舟", ["user"]);
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: {
						model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl },
						memoryDir: dir,
					},
				}),
			);
			io.lines.length = 0;

			let recalledText = "";
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("memory_search", { query: "客人名字" })]),
				(context) => {
					const toolResults = context.messages.filter((message) => message.role === "toolResult");
					recalledText = toolResults.map((message) => JSON.stringify(message.content)).join("");
					return fauxAssistantMessage("我记得你叫叶轻舟。");
				},
			]);
			await server.handleLine(JSON.stringify({ type: "prompt", text: "你还记得我叫什么吗？" }));
			expect(io.responses().at(-1)).toEqual({ type: "result" });
			expect(recalledText).toContain("叶轻舟");
		} finally {
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("summarizes the conversation into memory every summaryInterval turns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: {
						model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl },
						memoryDir: dir,
						summaryInterval: 1,
					},
				}),
			);
			io.lines.length = 0;

			faux.setResponses([fauxAssistantMessage("回复一"), fauxAssistantMessage("摘要：聊到了天气。")]);
			await server.handleLine(JSON.stringify({ type: "prompt", text: "今天天气不错" }));
			expect(io.responses().at(-1)).toEqual({ type: "result" });

			const reloaded = new MemoryStore(join(dir, "memory.json"));
			expect(reloaded.findByTag(SUMMARY_TAG)?.text).toBe("摘要：聊到了天气。");
		} finally {
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("emits a narrative event stream instead of raw agent events", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			const store = new MemoryStore(join(dir, "memory.json"));
			store.add("阿琳记得客人的名字是叶轻舟", ["user"]);
			const { server, io } = createTestServer();
			const model = faux.getModel();
			await server.handleLine(
				JSON.stringify({
					type: "init",
					config: {
						model: { id: model.id, api: faux.api, provider: model.provider, baseUrl: model.baseUrl },
						memoryDir: dir,
						narrative: true,
					},
				}),
			);
			io.lines.length = 0;

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("memory_search", { query: "客人名字" })]),
				fauxAssistantMessage("我记得，他叫叶轻舟。"),
			]);
			await server.handleLine(JSON.stringify({ type: "prompt", text: "你还记得我吗？" }));

			const responses = io.responses();
			expect(responses.at(-1)).toEqual({ type: "result" });
			expect(responses.some((response) => response.type === "event")).toBe(false);

			const narrative = responses.filter((response) => response.type === "narrative");
			const kinds = narrative.map((response) => (response.type === "narrative" ? response.event.kind : ""));
			expect(kinds[0]).toBe("reply_start");
			expect(kinds).toContain("thinking");
			expect(kinds).toContain("text");
			const text = narrative
				.filter(
					(response): response is Extract<ServerResponse, { type: "narrative" }> => response.type === "narrative",
				)
				.filter((response) => response.event.kind === "text")
				.map((response) => (response.event.kind === "text" ? response.event.text : ""))
				.join("");
			expect(text).toContain("叶轻舟");
		} finally {
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
