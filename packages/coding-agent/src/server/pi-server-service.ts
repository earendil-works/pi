/**
 * PiServerService adapter backed by coding-agent's AgentSession.
 *
 * Turns `pi server` into a real persistent coding-agent service: sessions are
 * created/opened via the standard SessionManager (JSONL), each acquired
 * session runs a full AgentSession (prompt/steer/abort/setModel/setThinking),
 * and snapshots/events are translated to the wire protocol.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptProgress,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import type {
	CreateSessionOptions,
	PiServerService,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	SteerInput,
} from "@earendil-works/pi-server";
import {
	PiServerError,
	SessionBusyError,
	SessionNotFoundError,
	toProtocolAssistantMessage,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-server";
import { getAgentDir } from "../config.ts";
import { getDefaultSessionDir } from "../core/session-manager.ts";

/** Map an AgentMessage[] transcript into protocol transcript items. */
function toProtocolTranscript(messages: AgentMessage[]): SessionSnapshot["transcript"] {
	const items: SessionSnapshot["transcript"] = [];
	let sequence = 0;
	for (const message of messages) {
		const id = `m-${sequence++}-${randomUUID().slice(0, 8)}`;
		switch (message.role) {
			case "user":
				items.push(toProtocolUserMessage(message, { id }));
				break;
			case "assistant":
				items.push(toProtocolAssistantMessage(message, { id }));
				break;
			case "toolResult": {
				const call = findToolCall(items, message.toolCallId);
				if (!call) continue;
				items.push(toProtocolToolResultMessage(message, { id, call }));
				break;
			}
			default:
				// Custom/skill messages do not map to the protocol transcript.
				break;
		}
	}
	return items;
}

function findToolCall(items: SessionSnapshot["transcript"], toolCallId: string): ToolCall | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.role !== "assistant") continue;
		for (const part of item.content) {
			if (part.type === "toolCall" && part.toolCallId === toolCallId) {
				return {
					type: "toolCall",
					id: part.toolCallId,
					name: part.toolName,
					arguments: part.input as ToolCall["arguments"],
				};
			}
		}
	}
	return undefined;
}

function sessionPhase(session: AgentSession): SessionSnapshot["phase"] {
	if (session.isCompacting) return "compaction";
	if (session.isStreaming) return "turn";
	return "idle";
}

function toSessionSnapshot(session: AgentSession, revision: number): SessionSnapshot {
	const model = session.model;
	return {
		id: session.sessionId,
		...(session.sessionName === undefined ? {} : { name: session.sessionName }),
		cwd: session.sessionManager.getCwd(),
		createdAt: 0,
		updatedAt: Date.now(),
		phase: sessionPhase(session),
		model: model ? { provider: model.provider, id: model.id } : { provider: "unknown", id: "unknown" },
		thinkingLevel: session.thinkingLevel,
		attached: true,
		locked: session.isStreaming || session.isCompacting,
		revision,
		transcript: toProtocolTranscript(session.messages),
		queuedSteer: [] as UserTranscriptItem[],
		queuedSteerCount: 0,
	};
}

export class CodingAgentPiSessionRuntime implements PiSessionRuntime {
	private readonly session: AgentSession;
	private revision = 0;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private readonly unsubscribe: () => void;

	constructor(session: AgentSession) {
		this.session = session;
		this.unsubscribe = session.subscribe(() => this.emitSnapshot());
	}

	snapshot(): SessionSnapshot {
		return toSessionSnapshot(this.session, this.revision);
	}

	getPhase(): SessionSnapshot["phase"] {
		return sessionPhase(this.session);
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.session.isStreaming) throw new SessionBusyError();
		await this.session.prompt(input.text, { source: "rpc" });
		this.emitSnapshot();
	}

	async steer(input: SteerInput): Promise<void> {
		if (!this.session.isStreaming) throw new SessionBusyError("There is no active prompt to steer");
		await this.session.steer(input.text);
		this.emitSnapshot();
	}

	async abort(): Promise<void> {
		if (!this.session.isStreaming) throw new SessionBusyError("There is no active prompt to abort");
		this.session.abort();
		this.emitSnapshot();
	}

	async setModel(model: ModelRef): Promise<void> {
		if (this.session.isStreaming) throw new SessionBusyError();
		const next = this.session.modelRuntime.getModel(model.provider, model.id);
		if (!next) throw new PiServerError("not_found", `Unknown model: ${model.provider}/${model.id}`);
		await this.session.setModel(next);
		this.emitSnapshot();
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (this.session.isStreaming) throw new SessionBusyError();
		this.session.setThinkingLevel(thinkingLevel);
		this.emitSnapshot();
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.unsubscribe();
		this.session.dispose();
	}

	private emitSnapshot(): void {
		this.revision += 1;
		for (const listener of this.listeners) listener({ type: "snapshot" });
		const snapshot = this.snapshot();
		const last = snapshot.transcript.at(-1);
		if (last && last.role === "assistant") {
			const progress: TranscriptProgress =
				last.status === "streaming" ? { type: "item_updated", item: last } : { type: "item_finished", item: last };
			for (const listener of this.listeners) listener({ type: "progress", progress });
		}
	}
}

/** PiServerService that hosts coding-agent sessions in a shared agentDir. */
export class CodingAgentPiServerService implements PiServerService {
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly sessionDir: string;
	private readonly runtimes = new Map<string, CodingAgentPiSessionRuntime>();
	private readonly locked = new Set<string>();

	constructor(options: { agentDir: string; modelRuntime: ModelRuntime }, sessionDir?: string) {
		this.agentDir = options.agentDir;
		this.modelRuntime = options.modelRuntime;
		this.sessionDir = sessionDir ?? getDefaultSessionDir(process.cwd(), this.agentDir);
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const sessions = await SessionManager.listAll(this.sessionDir);
		return sessions.map((info) => ({
			id: info.id,
			createdAt: Math.floor(info.created.getTime()),
			...(info.name === undefined ? {} : { sessionName: info.name }),
			...(info.cwd === undefined || info.cwd === "" ? {} : { cwd: info.cwd }),
			updatedAt: Math.floor(info.modified.getTime()),
		}));
	}

	async listModels(): Promise<ModelMetadata[]> {
		const models = this.modelRuntime.getModels();
		return models.map(toProtocolModelMetadata);
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		if (this.locked.has(options.id)) throw new SessionBusyError(`Session is locked: ${options.id}`);
		this.locked.add(options.id);
		try {
			const cwd = options.cwd ?? process.cwd();
			const sessionManager = SessionManager.create(cwd, this.sessionDir, { id: options.id });
			if (options.name !== undefined) sessionManager.appendSessionInfo(options.name);
			const { session } = await createAgentSession({
				cwd,
				agentDir: this.agentDir,
				sessionManager,
				modelRuntime: this.modelRuntime,
				...(options.model === undefined ? {} : { model: resolveModel(this.modelRuntime, options.model) }),
				...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
			});
			const runtime = new CodingAgentPiSessionRuntime(session);
			this.runtimes.set(options.id, runtime);
			return runtime;
		} finally {
			this.locked.delete(options.id);
		}
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const existing = this.runtimes.get(sessionId);
		if (existing) {
			if (this.locked.has(sessionId)) throw new SessionBusyError(`Session is locked: ${sessionId}`);
			return existing;
		}
		const sessions = await SessionManager.listAll(this.sessionDir);
		const info = sessions.find((candidate) => candidate.id === sessionId);
		if (!info) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		const sessionManager = SessionManager.open(info.path, this.sessionDir);
		const { session } = await createAgentSession({
			cwd: info.cwd || sessionManager.getCwd(),
			agentDir: this.agentDir,
			sessionManager,
			modelRuntime: this.modelRuntime,
		});
		const runtime = new CodingAgentPiSessionRuntime(session);
		this.runtimes.set(sessionId, runtime);
		return runtime;
	}
}

function resolveModel(modelRuntime: ModelRuntime, ref: ModelRef) {
	const model = modelRuntime.getModel(ref.provider, ref.id);
	if (!model) throw new PiServerError("not_found", `Unknown model: ${ref.provider}/${ref.id}`);
	return model;
}

function toProtocolModelMetadata(model: ReturnType<ModelRuntime["getModels"]>[number]): ModelMetadata {
	const clampCost = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: clampCost(model.cost.input),
			output: clampCost(model.cost.output),
			cacheRead: clampCost(model.cost.cacheRead),
			cacheWrite: clampCost(model.cost.cacheWrite),
		},
		supportedThinkingLevels: model.reasoning ? ["off", "low", "medium", "high"] : ["off"],
		authenticated: true,
	};
}

export async function createCodingAgentPiServerService(sessionDir?: string): Promise<CodingAgentPiServerService> {
	const agentDir = getAgentDir();
	const modelRuntime = await ModelRuntime.create();
	return new CodingAgentPiServerService({ agentDir, modelRuntime }, sessionDir);
}
