// Session-owned execution checkpoints and safe-boundary pause; child transcripts never enter a parent checkpoint.
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { raceWithAbortSignal } from "../utils/abort.ts";
import type { CustomMessage } from "./messages.ts";
import type { ReadonlySessionManager, SessionManager } from "./session-manager.ts";

export type RecoveryInput = UserMessage | CustomMessage;
export type RecoveryQueueMode = "start" | "steer" | "followUp" | "nextTurn" | "context";
export interface RecoveryQueuedInput {
	id: string;
	mode: RecoveryQueueMode;
	message: RecoveryInput;
}
export interface RecoveryPeer {
	pause(): Promise<void>;
	resume(): void;
	pending(): { id: string; label: string }[];
	recover(): Promise<void>;
	discard(): Promise<void>;
}
export interface RecoveryHost {
	isRunning(): boolean;
	abort(): void;
	restoreInputs(inputs: readonly RecoveryQueuedInput[]): void;
	clearInputs(): void;
	continueWork(): Promise<void>;
	refreshContext(): void;
}
export interface SessionRecoveryInfo {
	status: "running" | "pausing" | "paused" | "interrupted";
	main: boolean;
	tools: { id: string; name: string; outcome: "completed" | "unknown" | "not_started" }[];
	children: { id: string; label: string }[];
	queuedInputs: number;
	activeTools: number;
	modelActive: boolean;
	checkpointPath?: string;
	branchMatches: boolean;
}

const text = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const content = Type.Union([Type.String(), Type.Array(Type.Union([text, image]))]);
// Session input is extensible; only the user/custom content boundary is reconstructed here.
const inputSchema = Type.Unsafe<RecoveryInput>(
	Type.Union([
		Type.Object({ role: Type.Literal("user"), content, timestamp: Type.Number() }),
		Type.Object({
			role: Type.Literal("custom"),
			customType: Type.String(),
			content,
			display: Type.Boolean(),
			timestamp: Type.Number(),
			details: Type.Optional(Type.Unknown()),
		}),
	]),
);
const resultSchema = Type.Unsafe<ToolResultMessage>(
	Type.Object({
		role: Type.Literal("toolResult"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		content: Type.Array(Type.Union([text, image])),
		isError: Type.Boolean(),
		timestamp: Type.Number(),
	}),
);
const checkpointSchema = Type.Object({
	version: Type.Literal(1),
	revision: Type.String(),
	sessionFile: Type.String(),
	sessionTimestamp: Type.String(),
	phase: Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("pausing"), Type.Literal("paused")]),
	pendingMain: Type.Boolean(),
	anchor: Type.Union([Type.String(), Type.Null()]),
	tools: Type.Array(
		Type.Union([
			Type.Object({ id: Type.String(), name: Type.String(), status: Type.Literal("started") }),
			Type.Object({
				id: Type.String(),
				name: Type.String(),
				status: Type.Literal("completed"),
				result: resultSchema,
			}),
		]),
	),
	inputs: Type.Array(
		Type.Object({
			id: Type.String(),
			mode: Type.Union([
				Type.Literal("start"),
				Type.Literal("steer"),
				Type.Literal("followUp"),
				Type.Literal("nextTurn"),
				Type.Literal("context"),
			]),
			message: inputSchema,
		}),
	),
});
type Checkpoint = Static<typeof checkpointSchema>;
const checkpointValidator = Compile(checkpointSchema);
const controllers = new WeakMap<ReadonlySessionManager, SessionRecovery>();

/** Configure execution recovery for one concrete main or child session owner. */
export function configureSessionRecovery(
	session: SessionManager,
	agentDir: string,
	host: RecoveryHost,
): SessionRecovery {
	const controller = new SessionRecovery(session, agentDir, host);
	controllers.set(session, controller);
	return controller;
}

/** Retrieve the recovery controller belonging to this exact session manager. */
export function getSessionRecovery(session: ReadonlySessionManager): SessionRecovery {
	const controller = controllers.get(session);
	if (!controller) throw new Error("Session recovery is not configured for this owner");
	return controller;
}

/** Retain recoverable execution state and park new operations without interrupting running tools. */
export class SessionRecovery {
	readonly checkpointPath: string | undefined;
	private readonly session: SessionManager;
	private readonly host: RecoveryHost;
	private value: Checkpoint;
	private restored: boolean;
	private paused = false;
	private modelActive = false;
	private readonly activeTools = new Set<string>();
	private readonly peers = new Set<RecoveryPeer>();
	private readonly listeners = new Set<() => void>();
	private readonly guardedTools = new WeakMap<AgentTool, AgentTool>();
	private gate = Promise.withResolvers<void>();
	private quiet = Promise.withResolvers<void>();
	private pauseRequest: AbortController | undefined;
	private release: (() => void) | undefined;
	private leaseError: Error | undefined;
	private closed = false;
	private persistedRevision: string | undefined;
	private pauseSettled: Promise<void> | undefined;
	private readonly loadedInputs = new Set<string>();

	constructor(session: SessionManager, agentDir: string, host: RecoveryHost) {
		this.session = session;
		this.host = host;
		const path = session.getSessionFile();
		// Canonicalize the existing directory even before a new session's JSONL has been created.
		const file = path ? join(realpathSync(dirname(path)), basename(path)) : undefined;
		let ownerFile = file;
		if (file) {
			try {
				ownerFile = realpathSync(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const timestamp = session.getHeader()?.timestamp ?? "";
		if (ownerFile) {
			const owner = createHash("sha256").update(ownerFile).update("\0").update(timestamp).digest("hex");
			this.checkpointPath = join(agentDir, "recovery", owner, "state.json");
		}
		const saved = this.read();
		this.persistedRevision = saved?.revision;
		this.value = saved ?? {
			version: 1,
			revision: randomUUID(),
			sessionFile: ownerFile ?? "",
			sessionTimestamp: timestamp,
			phase: "idle",
			pendingMain: false,
			anchor: null,
			tools: [],
			inputs: [],
		};
		if (this.value.sessionFile !== (ownerFile ?? "") || this.value.sessionTimestamp !== timestamp)
			throw new Error("Recovery checkpoint belongs to another session");
		this.value.inputs = this.value.inputs.filter((input) => !session.getEntry(input.id));
		for (const input of this.value.inputs) this.loadedInputs.add(input.id);
		this.restored = this.value.phase !== "idle" || this.value.inputs.length > 0;
		this.paused = this.restored;
		this.gate.resolve();
		if (this.paused) this.gate = Promise.withResolvers<void>();
	}

	/** Whether new model requests and top-level tool executions are parked. */
	get isPaused(): boolean {
		return this.paused;
	}

	/** Whether this owner needs explicit recovery approval before starting work. */
	get needsRecovery(): boolean {
		return this.restored || [...this.peers].some((peer) => peer.pending().length > 0);
	}

	/** Inspect bounded execution metadata, never another agent's message arrays. */
	info(): SessionRecoveryInfo {
		const pending = this.pendingCalls();
		return {
			status: this.restored
				? "interrupted"
				: this.paused
					? this.value.phase === "paused"
						? "paused"
						: "pausing"
					: "running",
			main: this.value.pendingMain,
			tools: pending.map((call) => {
				const receipt = this.value.tools.find((entry) => entry.id === call.id);
				return {
					id: call.id,
					name: call.name,
					outcome: receipt?.status === "completed" ? "completed" : receipt ? "unknown" : "not_started",
				};
			}),
			children: [...this.peers].flatMap((peer) => peer.pending()),
			queuedInputs: this.value.inputs.length,
			activeTools: this.activeTools.size,
			modelActive: this.modelActive,
			checkpointPath: this.checkpointPath,
			branchMatches: this.branchMatches(),
		};
	}

	/** Register child controls without storing their transcripts or duplicating their state. */
	registerPeer(peer: RecoveryPeer): () => void {
		this.peers.add(peer);
		return () => {
			this.peers.delete(peer);
		};
	}

	/** Observe pause/menu state changes for this owner's lifetime. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Claim this session's execution lease before native UI work can produce parent messages. */
	claim(): void {
		this.acquire();
	}

	/** Acquire execution ownership before a conversational run can modify history. */
	begin(): void {
		if (this.needsRecovery)
			throw new Error("Interrupted work needs review. Open /pause to recover or discard it first.");
		this.acquire();
		this.value.pendingMain = true;
		if (!this.paused) this.value.phase = "running";
		this.save();
	}

	/** Admit one provider request only while the execution gate is open. */
	async beforeRequest(signal?: AbortSignal): Promise<void> {
		if (!this.modelActive) await this.admit({ kind: "model" }, signal);
	}

	/** Mark the current provider response durable before allowing a pause to settle. */
	modelFinished(): void {
		this.modelActive = false;
		this.changed();
	}

	/** Guard top-level calls; nested calls remain part of their already-running parent tool. */
	guard(tool: AgentTool): AgentTool {
		let guarded = this.guardedTools.get(tool);
		if (!guarded) {
			guarded = {
				...tool,
				execute: async (id, args, signal, onUpdate) => {
					await this.admit({ kind: "tool", id, name: tool.name }, signal);
					return tool.execute(id, args, signal, onUpdate);
				},
			};
			this.guardedTools.set(tool, guarded);
		}
		return guarded;
	}

	/** Publish a completed result before parallel batching can delay its normal chat entry. */
	completed(result: ToolResultMessage): void {
		this.value.tools = this.value.tools.filter((entry) => entry.id !== result.toolCallId);
		this.value.tools.push({ id: result.toolCallId, name: result.toolName, status: "completed", result });
		this.activeTools.delete(result.toolCallId);
		this.save();
	}

	/** Read an uncommitted receipt, including nested-call accounting, for canonical persistence. */
	receipt(id: string): ToolResultMessage | undefined {
		const entry = this.value.tools.find((entry) => entry.id === id);
		return entry?.status === "completed" ? entry.result : undefined;
	}

	/** Forget a receipt only after its canonical result has reached the session log. */
	committedTool(id: string): void {
		if (!this.value.tools.some((entry) => entry.id === id)) return;
		this.value.tools = this.value.tools.filter((entry) => entry.id !== id);
		this.save();
	}

	/** Persist accepted queued input once, reserving the eventual canonical entry ID. */
	queue(mode: RecoveryQueueMode, message: RecoveryInput): void {
		this.acquire();
		this.value.inputs.push({ id: randomUUID(), mode, message });
		this.save();
		this.session.ensurePersisted();
	}

	/** Recover the reserved entry ID using the same-host message identity. */
	inputId(message: RecoveryInput): string | undefined {
		return this.value.inputs.find((input) => input.message === message)?.id;
	}

	/** Forget queued input only after its reserved canonical entry exists. */
	committedInput(message: RecoveryInput): void {
		if (!this.value.inputs.some((input) => input.message === message)) return;
		for (const input of this.value.inputs) if (input.message === message) this.loadedInputs.delete(input.id);
		this.value.inputs = this.value.inputs.filter((input) => input.message !== message);
		this.save();
	}

	/** Explicitly discard pending inputs, not entries that already reached chat history. */
	clearInputs(): void {
		this.value.inputs = this.value.inputs.filter(
			(input) => input.mode === "start" || input.mode === "nextTurn" || input.mode === "context",
		);
		this.save();
	}

	/** Park the parent first so a synchronous child-wait tool cannot deadlock group pause. */
	pause(): Promise<void> {
		if (this.paused) return this.pauseSettled ?? Promise.resolve();
		this.acquire();
		const request = new AbortController();
		this.pauseRequest = request;
		this.paused = true;
		this.gate = Promise.withResolvers<void>();
		this.value.phase = "pausing";
		this.save();
		this.pauseSettled = this.settlePause(request);
		return this.pauseSettled;
	}

	private async settlePause(request: AbortController): Promise<void> {
		try {
			while (this.modelActive || this.activeTools.size > 0) {
				this.quiet = Promise.withResolvers<void>();
				await raceWithAbortSignal(this.quiet.promise, request.signal);
			}
			if (request.signal.aborted) return;
			await Promise.all([...this.peers].map((peer) => peer.pause()));
			if (request.signal.aborted) return;
			this.value.phase = "paused";
			this.save();
		} catch (error) {
			if (!request.signal.aborted) throw error;
		}
	}

	/** Continue a live paused loop without adding another prompt or reissuing its finished tools. */
	resume(): void {
		if (this.restored) throw new Error("Use recovery approval before continuing interrupted work");
		this.pauseRequest?.abort();
		this.pauseSettled = undefined;
		for (const peer of this.peers) peer.resume();
		this.paused = false;
		this.value.phase = this.host.isRunning() ? "running" : "idle";
		this.gate.resolve();
		this.save();
	}

	/** Restore durable results and pending input only after the user has reviewed recovery. */
	async recover(): Promise<void> {
		const continueMain = await this.restore();
		if (continueMain) await this.host.continueWork();
	}

	/** Reconcile interrupted execution before an explicitly supplied continuation replaces its old task. */
	async restore(): Promise<boolean> {
		if (this.host.isRunning()) throw new Error("Continue or stop the live run before recovering saved work");
		this.acquire();
		if (!this.branchMatches())
			throw new Error(
				"Pending recovery belongs to another branch. Return to that branch, or discard its pending work.",
			);
		const continueMain = this.value.pendingMain || this.value.inputs.some((input) => input.mode !== "context");
		this.repairResults();
		await Promise.all([...this.peers].map((peer) => peer.recover()));
		this.host.restoreInputs(this.value.inputs.filter((input) => this.loadedInputs.has(input.id)));
		this.loadedInputs.clear();
		this.restored = false;
		this.resume();
		return continueMain;
	}

	/** Retain history but abandon pending work; unknown tool outcomes remain explicitly recorded. */
	async discard(): Promise<void> {
		if (this.host.isRunning()) throw new Error("Continue or stop the live run before discarding saved work");
		this.acquire();
		if (this.branchMatches()) this.repairResults();
		else this.value.tools = [];
		await Promise.all([...this.peers].map((peer) => peer.discard()));
		this.host.clearInputs();
		this.value.inputs = [];
		this.loadedInputs.clear();
		this.value.pendingMain = false;
		this.restored = false;
		this.resume();
	}

	/** Complete a normal run; a paused shutdown retains its unfinished-work marker. */
	finish(completed: boolean): void {
		this.modelActive = false;
		this.activeTools.clear();
		if (!this.paused || completed) this.value.pendingMain = false;
		if (!this.paused) this.value.phase = "idle";
		this.save();
	}

	/** Release the execution lease only after the owning agent has drained. */
	dispose(): void {
		this.closed = true;
		this.pauseRequest?.abort();
		this.gate.resolve();
		this.listeners.clear();
		this.release?.();
		this.release = undefined;
	}

	private async admit(
		operation: { kind: "model" } | { kind: "tool"; id: string; name: string },
		signal?: AbortSignal,
	): Promise<void> {
		while (this.paused && !this.closed) {
			if (!signal) await this.gate.promise;
			else await raceWithAbortSignal(this.gate.promise, signal);
		}
		signal?.throwIfAborted();
		if (this.closed) throw new Error("Session recovery owner is disposed");
		if (this.leaseError) throw this.leaseError;
		// Reserve before resolving admission: pause must see a call already admitted in this microtask.
		if (operation.kind === "model") {
			this.modelActive = true;
			this.changed();
		} else {
			this.activeTools.add(operation.id);
			this.value.tools.push({ id: operation.id, name: operation.name, status: "started" });
			this.save();
		}
	}
	private pendingCalls() {
		const branch = this.session.getBranch();
		const results = new Set(
			branch.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
			),
		);
		return branch
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? entry.message.content.filter((block) => block.type === "toolCall" && !results.has(block.id))
					: [],
			)
			.filter((block) => block.type === "toolCall");
	}
	private branchMatches(): boolean {
		return this.value.anchor === null || this.session.getBranch().some((entry) => entry.id === this.value.anchor);
	}
	private repairResults(): void {
		for (const call of this.pendingCalls()) {
			const receipt = this.value.tools.find((entry) => entry.id === call.id);
			if (receipt?.name !== undefined && receipt.name !== call.name)
				throw new Error("Recovery receipt does not match its original tool call");
			const result: ToolResultMessage =
				receipt?.status === "completed"
					? receipt.result
					: {
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [
								{
									type: "text",
									text: receipt
										? "Execution was interrupted. This tool may already have caused side effects; its outcome is unknown. Inspect the actual state before repeating it."
										: "This tool was not started before execution was interrupted.",
								},
							],
							isError: true,
							timestamp: Date.now(),
						};
			this.session.appendMessage(result);
		}
		this.value.tools = [];
		this.host.refreshContext();
		this.save();
	}
	private acquire(): void {
		if (this.closed) throw new Error("Session recovery owner is disposed");
		if (this.leaseError) throw this.leaseError;
		if (this.release || !this.checkpointPath) return;
		const directory = dirname(this.checkpointPath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		try {
			this.release = lockfile.lockSync(directory, {
				retries: 0,
				onCompromised: (error) => {
					this.leaseError = error;
					this.host.abort();
					this.changed();
				},
			});
		} catch (error) {
			throw new Error(
				"This session still has an execution owner. Close the other pi instance, or wait for its stale lease to expire after a crash.",
				{ cause: error },
			);
		}
		try {
			if (this.read()?.revision !== this.persistedRevision)
				throw new Error("Recovery changed since this session was opened. Reopen the session before continuing.");
		} catch (error) {
			this.release();
			this.release = undefined;
			throw error;
		}
	}
	private save(): void {
		if (this.checkpointPath && !this.closed) {
			this.acquire();
			if (!this.restored) this.value.anchor = this.session.getLeafId();
			this.value.revision = randomUUID();
			const temporary = `${this.checkpointPath}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, JSON.stringify(this.value), { flag: "wx", mode: 0o600 });
				renameSync(temporary, this.checkpointPath);
				this.persistedRevision = this.value.revision;
			} finally {
				rmSync(temporary, { force: true });
			}
		}
		this.changed();
	}
	private read(): Checkpoint | undefined {
		if (!this.checkpointPath) return;
		let fd: number;
		try {
			fd = openSync(this.checkpointPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
				throw new Error("Invalid or oversized recovery checkpoint");
			const bytes = Buffer.allocUnsafe(stat.size + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, null);
				if (count === 0) break;
				length += count;
			}
			if (length > stat.size) throw new Error("Recovery checkpoint changed while being read");
			const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
			if (!checkpointValidator.Check(value)) throw new Error("Invalid recovery checkpoint");
			return value;
		} finally {
			closeSync(fd);
		}
	}
	private changed(): void {
		if (!this.modelActive && this.activeTools.size === 0) this.quiet.resolve();
		for (const listener of this.listeners) listener();
	}
}
