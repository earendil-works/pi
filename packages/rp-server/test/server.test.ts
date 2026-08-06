import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ServerResponse } from "../src/protocol.ts";
import { RpServer } from "../src/server.ts";

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
});
