import { createInterface } from "node:readline";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createRpModel } from "./model.ts";
import { decodeRequest, encodeResponse, type RpConfig, type ServerRequest, type ServerResponse } from "./protocol.ts";
import { createStreamFn, installStreamFn } from "./stream-fn.ts";

export interface ServerIO {
	write(line: string): void;
}

export class RpServer {
	private readonly io: ServerIO;
	private readonly streamFn: StreamFn;
	private agent: Agent | undefined;

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
				this.agent = this.createAgent(request.config);
				this.emit({ type: "ready" });
				return;
			}
			case "prompt": {
				if (!this.agent) {
					this.emit({ type: "error", error: "Server not initialized; send init first" });
					return;
				}
				try {
					await this.agent.prompt(request.text);
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
		const agent = new Agent({
			initialState: {
				systemPrompt: config.systemPrompt ?? "",
				model,
				thinkingLevel: config.thinkingLevel ?? "off",
				tools: [],
			},
			streamFn: this.streamFn,
			getApiKey: () => config.model.apiKey,
		});
		agent.subscribe((event) => {
			this.emit({ type: "event", event });
		});
		return agent;
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
