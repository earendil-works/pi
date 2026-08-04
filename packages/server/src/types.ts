import type {
	Command,
	ModelMetadata,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { PiServerError } from "./errors.ts";
import type { PiServerListener } from "./listener.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

export type PromptInput = Omit<Extract<Command, { command: "prompt" }>, "command" | "sessionId">;
export type SteerInput = Omit<Extract<Command, { command: "steer" }>, "command" | "sessionId">;

export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by PiServer. The backend must persist this exact ID. */
	id: string;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export type PiSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "error"; error: PiServerError };

/** One acquired durable session. Conflicting operations must reject rather than queue. */
export interface PiSessionRuntime {
	snapshot(): MaybePromise<SessionSnapshot>;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/** Durable storage and exclusively acquired runtime boundary. */
export interface PiSessionBackend {
	listSessions(): Promise<SessionSummary[]>;
	listModels(): Promise<ModelMetadata[]>;
	createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
	openSession(sessionId: string): Promise<PiSessionRuntime>;
}

export type SessionRuntime = PiSessionRuntime;
export type SessionBackend = PiSessionBackend;
export type SessionRuntimeEvent = PiSessionRuntimeEvent;
