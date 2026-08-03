import { randomUUID } from "node:crypto";
import type { Command, EventEnvelope, SessionSnapshot, SessionSummary } from "@earendil-works/pi-protocol";
import type { ByteConnection, ConnectionState } from "./connection.ts";
import { PiServerError } from "./errors.ts";
import type { CreateSessionOptions, PiSessionBackend, PiSessionRuntime, PiSessionRuntimeEvent } from "./types.ts";

interface LiveSession {
	id: string;
	runtime: PiSessionRuntime;
	connections: Set<ConnectionState>;
	unsubscribe: () => void;
	operationCount: number;
	ready: boolean;
	terminal: boolean;
	disposing?: Promise<void>;
}

interface LiveSessionManagerOptions {
	backend: PiSessionBackend;
	isClosing: () => boolean;
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	closeConnection: (connection: ByteConnection) => Promise<void>;
	disconnect: (connection: ConnectionState) => Promise<void>;
	broadcastServerSnapshot: () => void;
	reportError: (error: unknown) => void;
}

function toSummary(snapshot: SessionSnapshot): SessionSummary {
	return {
		id: snapshot.id,
		name: snapshot.name,
		cwd: snapshot.cwd,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		phase: snapshot.phase,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		attached: snapshot.attached,
		locked: snapshot.locked,
	};
}

export class LiveSessionManager {
	private readonly options: LiveSessionManagerOptions;
	private readonly liveSessions = new Map<string, LiveSession>();
	private readonly openingSessions = new Map<string, Promise<LiveSession>>();

	constructor(options: LiveSessionManagerOptions) {
		this.options = options;
	}

	async executeCommand(connection: ConnectionState, command: Command) {
		switch (command.command) {
			case "list":
				return { command: "list" as const, sessions: await this.listSummaries(connection) };
			case "create": {
				const id = randomUUID();
				const options: CreateSessionOptions = {
					id,
					cwd: command.cwd,
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				};
				const live = await this.acquire(id, () => this.options.backend.createSession(options));
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "create" as const, session };
			}
			case "attach": {
				const live = await this.acquire(command.sessionId, () =>
					this.options.backend.openSession(command.sessionId),
				);
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "attach" as const, session };
			}
			case "detach": {
				const live = this.liveSessions.get(command.sessionId);
				if (connection.sessionIds.has(command.sessionId)) {
					connection.sessionIds.delete(command.sessionId);
					if (live) {
						live.connections.delete(connection);
						if (live.connections.size > 0 && !live.terminal && !live.disposing) {
							await this.broadcastSnapshot(live);
						}
						await this.maybeDispose(live);
					}
					this.options.broadcastServerSnapshot();
				}
				return { command: "detach" as const, sessionId: command.sessionId };
			}
			case "prompt": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.prompt({ text: command.text }),
				);
				return { command: "prompt" as const, session };
			}
			case "steer": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.steer({ text: command.text }));
				return { command: "steer" as const, session };
			}
			case "abort": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.abort());
				return { command: "abort" as const, session };
			}
			case "set_model": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.setModel(command.model));
				return { command: "set_model" as const, session };
			}
			case "set_thinking": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.setThinking(command.thinkingLevel),
				);
				return { command: "set_thinking" as const, session };
			}
		}
	}

	async disconnect(connection: ConnectionState): Promise<void> {
		const sessions = [...connection.sessionIds]
			.map((id) => this.liveSessions.get(id))
			.filter((live): live is LiveSession => live !== undefined);
		connection.sessionIds.clear();
		for (const live of sessions) live.connections.delete(connection);
		const results = await Promise.allSettled(sessions.map((live) => this.maybeDispose(live)));
		for (const result of results) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
	}

	async listSummaries(connection?: ConnectionState): Promise<SessionSummary[]> {
		const stored = await this.options.backend.listSessions();
		const liveSnapshots = await Promise.all(
			[...this.liveSessions.values()]
				.filter((live) => !live.disposing)
				.map(async (live) => [live.id, await this.normalizedSnapshot(live)] as const),
		);
		const liveById = new Map(liveSnapshots);
		const summaries = stored.map((summary) => {
			const snapshot = liveById.get(summary.id);
			if (!snapshot) return { ...summary, attached: false };
			liveById.delete(summary.id);
			return { ...toSummary(snapshot), attached: connection?.sessionIds.has(summary.id) ?? false };
		});
		for (const snapshot of liveById.values()) {
			summaries.push({ ...toSummary(snapshot), attached: connection?.sessionIds.has(snapshot.id) ?? false });
		}
		return summaries;
	}

	async close(): Promise<void> {
		const openingResults = await Promise.allSettled([...this.openingSessions.values()]);
		for (const result of openingResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
		const sessions = [...this.liveSessions.values()];
		this.liveSessions.clear();
		await Promise.all(
			sessions.map(async (live) => {
				if (live.disposing) {
					await live.disposing;
					return;
				}
				live.unsubscribe();
				await live.runtime.dispose();
			}),
		);
	}

	private async runOperation(
		connection: ConnectionState,
		live: LiveSession,
		operation: () => Promise<void>,
	): Promise<SessionSnapshot> {
		live.operationCount += 1;
		try {
			await operation();
			return this.forConnection(await this.broadcastSnapshot(live), connection);
		} finally {
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	private async acquire(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		for (;;) {
			const existing = this.liveSessions.get(id);
			if (existing) {
				if (existing.terminal) throw new PiServerError("session_locked", `Session runtime is terminating: ${id}`);
				if (existing.disposing) {
					await existing.disposing;
					continue;
				}
				return existing;
			}
			const opening = this.openingSessions.get(id);
			if (opening) return opening;
			const pending = this.create(id, acquireRuntime);
			this.openingSessions.set(id, pending);
			try {
				return await pending;
			} finally {
				if (this.openingSessions.get(id) === pending) this.openingSessions.delete(id);
			}
		}
	}

	private async create(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		const runtime = await acquireRuntime();
		if (this.options.isClosing()) {
			await runtime.dispose();
			throw new Error("PiServer closed while acquiring a session runtime");
		}
		let live: LiveSession | undefined;
		try {
			const snapshot = await runtime.snapshot();
			if (snapshot.id !== id) {
				throw new PiServerError(
					"invalid_request",
					`Backend returned session ${snapshot.id} for server-assigned session ${id}`,
				);
			}
			live = {
				id,
				runtime,
				connections: new Set(),
				unsubscribe: () => {},
				operationCount: 0,
				ready: false,
				terminal: false,
			};
			live.unsubscribe = runtime.subscribe((event) => this.handleRuntimeEvent(live!, event));
			this.liveSessions.set(id, live);
			live.ready = true;
			return live;
		} catch (error) {
			if (live) live.unsubscribe();
			try {
				await runtime.dispose();
			} catch (disposeError) {
				this.options.reportError(disposeError);
			}
			throw error;
		}
	}

	private handleRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): void {
		if (event.type === "error") {
			void this.terminate(live, event.error).catch((error: unknown) => this.options.reportError(error));
			return;
		}
		if (event.type === "progress") {
			const envelope: EventEnvelope = {
				type: "event",
				event: { type: "session_progress", sessionId: live.id, progress: event.progress },
			};
			for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		} else {
			void this.broadcastSnapshot(live).catch((error: unknown) => this.options.reportError(error));
		}
		this.scheduleMaybeDispose(live);
	}

	private async terminate(live: LiveSession, error: PiServerError): Promise<void> {
		if (live.terminal) return;
		live.terminal = true;
		this.options.reportError(error);
		live.unsubscribe();
		const connections = [...live.connections];
		await Promise.all(connections.map((connection) => this.options.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.options.disconnect(connection)));
		await this.maybeDispose(live);
	}

	private async normalizedSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await live.runtime.snapshot();
		if (snapshot.id !== live.id) {
			throw new PiServerError("invalid_request", `Runtime session ID changed from ${live.id} to ${snapshot.id}`);
		}
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
		};
	}

	private forConnection(snapshot: SessionSnapshot, connection: ConnectionState): SessionSnapshot {
		return { ...snapshot, attached: connection.sessionIds.has(snapshot.id) };
	}

	private async broadcastSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await this.normalizedSnapshot(live);
		const envelope: EventEnvelope = { type: "event", event: { type: "session_snapshot", snapshot } };
		for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		return snapshot;
	}

	private async attach(connection: ConnectionState, live: LiveSession): Promise<void> {
		if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
			await this.maybeDispose(live);
			throw new PiServerError("invalid_request", "Connection closed while attaching to a session");
		}
		connection.sessionIds.add(live.id);
		live.connections.add(connection);
	}

	private requireAttached(connection: ConnectionState, sessionId: string): LiveSession {
		if (!connection.sessionIds.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.terminal || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		return live;
	}

	private scheduleMaybeDispose(live: LiveSession): void {
		void this.maybeDispose(live).catch((error: unknown) => this.options.reportError(error));
	}

	private async maybeDispose(live: LiveSession): Promise<void> {
		if (
			this.options.isClosing() ||
			!live.ready ||
			live.disposing ||
			live.connections.size > 0 ||
			live.operationCount > 0 ||
			(!live.terminal && live.runtime.getPhase() !== "idle")
		) {
			return live.disposing;
		}
		live.unsubscribe();
		live.disposing = (async () => {
			try {
				await live.runtime.dispose();
			} finally {
				if (this.liveSessions.get(live.id) === live) this.liveSessions.delete(live.id);
			}
		})();
		await live.disposing;
		if (!this.options.isClosing()) this.options.broadcastServerSnapshot();
	}
}
