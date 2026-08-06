import { join } from "node:path";
import { createInterface } from "node:readline";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { buildPersonaAnchor, extractCharacterCardFromPng, parseCharacterCard } from "./character-card/index.ts";
import { buildMemorySection, SUMMARY_TAG, summarizeConversation } from "./memory/index.ts";
import { MemoryStore } from "./memory/store.ts";
import { createMemoryRememberTool, createMemorySearchTool } from "./memory/tools.ts";
import { createRpModel } from "./model.ts";
import { decodeRequest, encodeResponse, type RpConfig, type ServerRequest, type ServerResponse } from "./protocol.ts";
import { createStreamFn, installStreamFn } from "./stream-fn.ts";

export interface ServerIO {
	write(line: string): void;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_SUMMARY_INTERVAL = 8;

export class RpServer {
	private readonly io: ServerIO;
	private readonly streamFn: StreamFn;
	private agent: Agent | undefined;
	private memoryStore: MemoryStore | undefined;
	private summaryInterval = DEFAULT_SUMMARY_INTERVAL;
	private turnCount = 0;
	private apiKey: string | undefined;
	private persona = "";
	private characterName = "";
	private pendingPersona: string | undefined;

	constructor(io: ServerIO) {
		this.io = io;
		this.streamFn = createStreamFn();
		installStreamFn();
	}

	async handleLine(line: string): Promise<void> {
		let request: ServerRequest;
		try {
			request = decodeRequest(line);
		} catch (error) {
			this.emit({ type: "error", error: toErrorMessage(error) });
			return;
		}
		await this.handleRequest(request);
	}

	async handleRequest(request: ServerRequest): Promise<void> {
		switch (request.type) {
			case "init": {
				this.memoryStore = request.config.memoryDir
					? new MemoryStore(join(request.config.memoryDir, "memory.json"))
					: undefined;
				this.summaryInterval = request.config.summaryInterval ?? DEFAULT_SUMMARY_INTERVAL;
				this.apiKey = request.config.model.apiKey;
				this.persona = request.config.systemPrompt ?? "";
				this.agent = this.createAgent(request.config);
				if (this.pendingPersona) {
					this.persona = this.pendingPersona;
					this.pendingPersona = undefined;
				}
				this.agent.state.systemPrompt = this.persona;
				this.turnCount = 0;
				this.emit({ type: "ready" });
				return;
			}
			case "card": {
				const result = this.loadCard(request.format, request.data);
				if (!result.ok) {
					this.emit({ type: "error", error: result.error });
					return;
				}
				this.emit({ type: "card_loaded", name: result.name, greeting: result.greeting });
				return;
			}
			case "prompt": {
				if (!this.agent) {
					this.emit({ type: "error", error: "Server not initialized; send init first" });
					return;
				}
				try {
					this.agent.state.systemPrompt = this.buildSystemPrompt(request.text);
					await this.agent.prompt(request.text);
					await this.maybeSummarize();
					this.emit({ type: "result" });
				} catch (error) {
					this.emit({ type: "result", error: toErrorMessage(error) });
				}
				return;
			}
			case "abort":
				this.agent?.abort();
				return;
			case "ping":
				this.emit({ type: "pong" });
				return;
		}
	}

	private createAgent(config: RpConfig): Agent {
		const model = createRpModel(config.model);
		const tools = this.memoryStore
			? [createMemorySearchTool(this.memoryStore), createMemoryRememberTool(this.memoryStore)]
			: [];
		const agent = new Agent({
			initialState: {
				systemPrompt: config.systemPrompt ?? "",
				model,
				thinkingLevel: config.thinkingLevel ?? "off",
				tools,
			},
			streamFn: this.streamFn,
			getApiKey: () => config.model.apiKey,
		});
		agent.subscribe((event) => {
			this.emit({ type: "event", event });
		});
		return agent;
	}

	private loadCard(
		format: "json" | "png",
		data: string,
	): { ok: true; name: string; greeting: string } | { ok: false; error: string } {
		try {
			const text = format === "png" ? extractCharacterCardFromPng(base64ToBytes(data)) : data;
			if (!text) {
				return { ok: false, error: "No character card found in PNG" };
			}
			const card = parseCharacterCard(text);
			const persona = buildPersonaAnchor(card);
			const greeting = card.firstMes ?? card.alternateGreetings[0] ?? "";
			this.persona = persona;
			this.characterName = card.name;
			if (this.agent) {
				this.agent.state.systemPrompt = persona;
				if (greeting) {
					const message = this.buildAssistantMessage(greeting);
					this.agent.state.messages = [message];
				}
			} else {
				this.pendingPersona = persona;
			}
			return { ok: true, name: card.name, greeting };
		} catch (error) {
			return { ok: false, error: toErrorMessage(error) };
		}
	}

	private buildSystemPrompt(query: string): string {
		const parts = [this.persona];
		if (this.memoryStore) {
			parts.push(buildMemorySection(this.memoryStore, query));
		}
		return parts.filter(Boolean).join("\n\n");
	}

	private async maybeSummarize(): Promise<void> {
		if (!this.memoryStore || !this.agent || this.summaryInterval <= 0) {
			return;
		}
		this.turnCount++;
		if (this.turnCount % this.summaryInterval !== 0) {
			return;
		}
		try {
			const summary = await summarizeConversation(this.agent.state.model, this.streamFn, this.agent.state.messages, {
				apiKey: this.apiKey,
				characterName: this.characterName || undefined,
			});
			this.memoryStore.upsertByTag(SUMMARY_TAG, summary);
		} catch (error) {
			console.error("[rp-server] conversation summarization failed:", toErrorMessage(error));
		}
	}

	private buildAssistantMessage(text: string): AssistantMessage {
		const model = this.agent?.state.model;
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model?.api ?? "openai-completions",
			provider: model?.provider ?? "custom",
			model: model?.id ?? "unknown",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	private emit(response: ServerResponse): void {
		this.io.write(encodeResponse(response));
	}
}

export function startStdioServer(): RpServer {
	const server = new RpServer({
		write(line) {
			process.stdout.write(line);
		},
	});
	const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
	readline.on("line", (line) => {
		if (line.trim().length > 0) {
			void server.handleLine(line);
		}
	});
	readline.on("close", () => {
		process.exit(0);
	});
	return server;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function base64ToBytes(data: string): Uint8Array {
	return Buffer.from(data, "base64");
}
