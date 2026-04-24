import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentMessage, AgentEvent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebServerConfig {
	port: number;
	host: string;
}

interface Session {
	id: string;
	agent: any;
	unsubscribe?: () => void;
}

interface SessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	messages: AgentMessage[];
}

function getSessionState(session: any): SessionState {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		messages: session.messages,
	};
}

export function createWebServer(config: WebServerConfig) {
	const app = express();
	const httpServer = createServer(app);
	const wss = new WebSocketServer({ server: httpServer });

	const sessions = new Map<string, Session>();

	app.use(cors());
	app.use(express.json());

	const staticPath = join(__dirname, "..", "public");
	app.use(express.static(staticPath));

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	wss.on("connection", (ws) => {
		let currentSessionId: string | null = null;

		const send = (message: any) => {
			if (ws.readyState === 1) {
				ws.send(JSON.stringify(message));
			}
		};

		const handleEvent = (sessionId: string, event: AgentEvent) => {
			send({
				type: "event",
				sessionId,
				event,
			});
		};

		ws.on("message", async (data) => {
			try {
				const message = JSON.parse(data.toString());

				switch (message.type) {
					case "create_session": {
						const result = await createAgentSession({
							cwd: message.cwd,
						});

						const sessionId = result.session.sessionId;
						currentSessionId = sessionId;

						sessions.set(sessionId, {
							id: sessionId,
							agent: result.session,
						});

						const unsubscribe = result.session.agent.subscribe((event) => {
							handleEvent(sessionId, event);
						});

						sessions.get(sessionId)!.unsubscribe = unsubscribe;

						send({
							type: "session_created",
							sessionId,
							state: getSessionState(result.session),
						});
						break;
					}

					case "send_message": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						await session.agent.prompt(message.message);
						send({
							type: "ack",
							sessionId: message.sessionId,
							command: "send_message",
						});
						break;
					}

					case "abort": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						session.agent.abort();
						send({
							type: "ack",
							sessionId: message.sessionId,
							command: "abort",
						});
						break;
					}

					case "get_state": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						send({
							type: "state",
							sessionId: message.sessionId,
							state: getSessionState(session.agent),
						});
						break;
					}

					case "get_available_models": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						const models = await session.agent.modelRegistry.getAvailable();
						send({
							type: "models",
							sessionId: message.sessionId,
							models,
						});
						break;
					}

					case "set_model": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						const models = await session.agent.modelRegistry.getAvailable();
						const model = models.find((m: any) => m.provider === message.provider && m.id === message.modelId);
						if (!model) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: `Model not found: ${message.provider}/${message.modelId}`,
							});
							break;
						}
						await session.agent.setModel(model);
						send({
							type: "model_set",
							sessionId: message.sessionId,
							model,
						});
						break;
					}

					case "set_thinking_level": {
						const session = sessions.get(message.sessionId);
						if (!session) {
							send({
								type: "error",
								sessionId: message.sessionId,
								message: "Session not found",
							});
							break;
						}
						session.agent.setThinkingLevel(message.level);
						send({
							type: "ack",
							sessionId: message.sessionId,
							command: "set_thinking_level",
						});
						break;
					}
				}
			} catch (error: unknown) {
				send({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});

		ws.on("close", () => {
			if (currentSessionId) {
				const session = sessions.get(currentSessionId);
				if (session?.unsubscribe) {
					session.unsubscribe();
				}
				sessions.delete(currentSessionId);
			}
		});
	});

	const start = async () => {
		return new Promise<void>((resolve) => {
			httpServer.listen(config.port, config.host, () => {
				console.log(`Pi Web Server running at http://${config.host}:${config.port}`);
				resolve();
			});
		});
	};

	const stop = async () => {
		return new Promise<void>((resolve, reject) => {
			for (const session of sessions.values()) {
				if (session.unsubscribe) {
					session.unsubscribe();
				}
			}
			sessions.clear();
			httpServer.close((err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	};

	return {
		app,
		httpServer,
		wss,
		sessions,
		start,
		stop,
	};
}

export type WebServer = ReturnType<typeof createWebServer>;
