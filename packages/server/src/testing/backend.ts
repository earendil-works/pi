import type {
	ModelMetadata,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import type {
	CreateSessionOptions,
	PiSessionBackend,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
} from "../types.ts";

export const TEST_TOKEN = "server-conformance-token";
export const TEST_MODEL: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off", "medium", "high"],
	authenticated: true,
};

export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

interface StoredSession {
	snapshot: SessionSnapshot;
}

export class TestSessionRuntime implements PiSessionRuntime {
	readonly disposed = new Deferred<void>();
	disposeCount = 0;
	readonly steers: PromptInput[] = [];
	private readonly stored: StoredSession;
	private readonly onDispose: () => void;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private pendingPrompt?: { input: PromptInput; done: Deferred<"complete" | "aborted"> };

	constructor(stored: StoredSession, onDispose: () => void) {
		this.stored = stored;
		this.onDispose = onDispose;
	}

	snapshot(): SessionSnapshot {
		return structuredClone(this.stored.snapshot);
	}

	getPhase(): SessionPhase {
		return this.stored.snapshot.phase;
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "A prompt is already running");
		const done = new Deferred<"complete" | "aborted">();
		this.pendingPrompt = { input, done };
		this.update({
			phase: "turn",
			transcript: [
				...this.stored.snapshot.transcript,
				{
					id: `user-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
		const outcome = await done.promise;
		const assistant =
			outcome === "complete"
				? {
						id: `assistant-${this.stored.snapshot.revision + 1}`,
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `reply:${input.text}` }],
						status: "complete" as const,
						model: this.stored.snapshot.model,
						stopReason: "stop" as const,
						timestamp: this.stored.snapshot.revision + 1,
					}
				: {
						id: `assistant-${this.stored.snapshot.revision + 1}`,
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "" }],
						status: "aborted" as const,
						model: this.stored.snapshot.model,
						stopReason: "aborted" as const,
						timestamp: this.stored.snapshot.revision + 1,
					};
		this.update({
			phase: "idle",
			transcript: [...this.stored.snapshot.transcript, assistant],
		});
		this.pendingPrompt = undefined;
	}

	async steer(input: PromptInput): Promise<void> {
		if (this.getPhase() === "idle") throw new PiServerError("busy", "There is no active prompt to steer");
		this.steers.push(input);
		this.update({
			queuedSteerCount: this.stored.snapshot.queuedSteerCount + 1,
			queuedSteer: [
				...this.stored.snapshot.queuedSteer,
				{
					id: `steer-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
	}

	async abort(): Promise<void> {
		if (!this.pendingPrompt) throw new PiServerError("busy", "There is no active prompt to abort");
		this.pendingPrompt.done.resolve("aborted");
	}

	async setModel(model: ModelRef): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ model });
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ thinkingLevel });
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposeCount += 1;
		this.onDispose();
		this.disposed.resolve(undefined);
	}

	setPhase(phase: SessionPhase): void {
		this.stored.snapshot = { ...this.stored.snapshot, phase };
	}

	finishPrompt(): void {
		if (!this.pendingPrompt) throw new Error("No prompt is pending");
		this.pendingPrompt.done.resolve("complete");
	}

	emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}

	emitError(error: PiServerError): void {
		for (const listener of this.listeners) listener({ type: "error", error });
	}

	emitSnapshot(): void {
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}

	private update(updates: Partial<SessionSnapshot>): void {
		this.stored.snapshot = {
			...this.stored.snapshot,
			...updates,
			revision: this.stored.snapshot.revision + 1,
			updatedAt: this.stored.snapshot.updatedAt + 1,
		};
		this.emitSnapshot();
	}
}

interface ListDelay {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestSessionBackend implements PiSessionBackend {
	readonly sessions = new Map<string, StoredSession>();
	readonly runtimes = new Map<string, TestSessionRuntime[]>();
	readonly locked = new Set<string>();
	lastCreatedId?: string;
	private nextListDelay?: ListDelay;

	async listSessions(): Promise<SessionSummary[]> {
		const delay = this.nextListDelay;
		if (delay) {
			this.nextListDelay = undefined;
			delay.entered.resolve(undefined);
			await delay.release.promise;
		}
		return [...this.sessions.values()].map(({ snapshot }) => ({
			id: snapshot.id,
			name: snapshot.name,
			cwd: snapshot.cwd,
			createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt,
			phase: snapshot.phase,
			model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel,
			attached: false,
			locked: this.locked.has(snapshot.id),
		}));
	}

	async listModels(): Promise<ModelMetadata[]> {
		return [TEST_MODEL];
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		this.lastCreatedId = options.id;
		if (this.sessions.has(options.id)) throw new PiServerError("session_locked", "Session already exists");
		this.seed(options.id, options.name, options.cwd, options.model, options.thinkingLevel);
		return this.acquire(options.id);
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		if (!this.sessions.has(sessionId)) throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
		if (this.locked.has(sessionId)) throw new PiServerError("session_locked", `Session is locked: ${sessionId}`);
		return this.acquire(sessionId);
	}

	seed(
		id = "session-1",
		name = `Session ${id}`,
		cwd = "/tmp/pi-server-conformance",
		model: ModelRef = { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
		thinkingLevel: ThinkingLevel = "off",
	): void {
		this.sessions.set(id, {
			snapshot: {
				id,
				name,
				cwd,
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model,
				thinkingLevel,
				attached: false,
				locked: false,
				revision: 0,
				transcript: [],
				queuedSteer: [],
				queuedSteerCount: 0,
			},
		});
	}

	delayNextList(): ListDelay {
		const delay = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextListDelay = delay;
		return delay;
	}

	latestRuntime(id: string): TestSessionRuntime {
		const runtimes = this.runtimes.get(id);
		if (!runtimes?.length) throw new Error(`No runtime for ${id}`);
		return runtimes.at(-1)!;
	}

	private acquire(id: string): TestSessionRuntime {
		const stored = this.sessions.get(id);
		if (!stored) throw new Error(`Unknown session: ${id}`);
		this.locked.add(id);
		const runtime = new TestSessionRuntime(stored, () => this.locked.delete(id));
		const runtimes = this.runtimes.get(id) ?? [];
		runtimes.push(runtime);
		this.runtimes.set(id, runtimes);
		return runtime;
	}
}
