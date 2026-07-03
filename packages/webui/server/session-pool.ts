import { ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";

/**
 * Find a session file by session ID in the sessions directory.
 * Session files are named: <date-timestamp>_<sessionId>.jsonl
 */
async function findSessionFile(sessionsDir: string, sessionId: string): Promise<string | undefined> {
	try {
		const entries = await readdir(sessionsDir);
		// Files are named like: 2026-06-02T04-18-22-483Z_<sessionId>.jsonl
		const match = entries.find((name) => name.endsWith(`${sessionId}.jsonl`));
		return match ? join(sessionsDir, match) : undefined;
	} catch {
		return undefined;
	}
}

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	name?: string;
}

export interface WSClient {
	send(data: string): void;
}

/** Raw stdout line from a pi RPC process */
export interface PiEvent {
	sessionId: string;
	event: unknown;
}

interface SessionState {
	proc: ChildProcess;
	subscribers: Set<WSClient>;
	titlesSeen: Set<string>;
	// Set to true after prompt() is called and cleared on agent_end.
	// Used to emit session_status_changed("running" | "idle") so the
	// webui can show a real "thinking" indicator tied to actual model
	// activity (not a fake timer).
	isResponding: boolean;
}

/**
 * Manages a pool of pi RPC processes.
 *
 * Each session maps to a running `pi --mode rpc --resume <id> --cwd <cwd>` process.
 * Events from stdout are emitted via the `event` EventEmitter.
 */
export class SessionPool extends EventEmitter {
	readonly sessionsDir: string;
	readonly cwd: string;
	private readonly maxSessions: number;
	private readonly spawnFn: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => ChildProcess;

	/** sessionId -> SessionState */
	private readonly sessions = new Map<string, SessionState>();

	/** sessionId -> name (updated from session_info_changed events) */
	private readonly sessionNames = new Map<string, string>();

	/** Session IDs that webui has spawned pi processes for (owned by webui) */
	private readonly ownedSessions = new Set<string>();

	constructor(opts?: {
		cwd?: string;
		maxSessions?: number;
		spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	}) {
		super();
		const cwd = opts?.cwd ?? process.cwd();
		this.cwd = cwd;
		this.maxSessions = opts?.maxSessions ?? parseInt(process.env.PI_WEB_MAX_SESSIONS || "16", 10);
		this.spawnFn = opts?.spawnFn ?? spawn;

		// Session directory path: ~/.pi/agent/sessions/--<cwd-safe-->--
		// Encoding must match pi core's getDefaultSessionDirPath:
		// resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
		const sessionsBase = join(homedir(), ".pi", "agent", "sessions");
		const resolvedCwd = resolvePath(cwd);
		const safeCwd = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		this.sessionsDir = join(sessionsBase, safeCwd);

		// Load persisted webui-owned sessions so the ownership flag survives
		// server restarts. Without this, sessions created via the webui get
		// demoted to "managed by TUI" every time the server restarts, and
		// the user can no longer type into them.
		void this.loadOwnedSessions();
	}

	private get ownedSessionsPath(): string {
		return join(this.sessionsDir, "..", ".webui-owned.json");
	}

	private async loadOwnedSessions(): Promise<void> {
		try {
			const raw = await readFile(this.ownedSessionsPath, "utf-8");
			const ids = JSON.parse(raw) as unknown;
			if (Array.isArray(ids)) {
				for (const id of ids) {
					if (typeof id === "string") this.ownedSessions.add(id);
				}
			}
		} catch {
			// File missing or malformed — start empty
		}
	}

	private async persistOwnedSessions(): Promise<void> {
		try {
			await writeFile(
				this.ownedSessionsPath,
				JSON.stringify([...this.ownedSessions], null, 2),
				"utf-8",
			);
		} catch (err) {
			console.error("[session-pool] failed to persist ownedSessions:", err);
		}
	}

	/**
	 * Scan existing sessions from the sessions directory.
	 * Populates internal session list (but does NOT spawn processes).
	 */
	async init(): Promise<string[]> {
		const sessionIds: string[] = [];

		try {
			const entries = await readdir(this.sessionsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
					continue;
				}
				const filePath = join(this.sessionsDir, entry.name);
				try {
					const header = await this.parseSessionHeader(filePath);
					if (header?.id) {
						sessionIds.push(header.id);
					}
				} catch {
					// Skip files that can't be parsed
				}
			}
		} catch {
			// Directory doesn't exist yet — no sessions
		}

		return sessionIds;
	}

	/**
	 * Parse the JSONL header from a session file.
	 * Returns undefined if the file can't be read or parsed.
	 */
	private async parseSessionHeader(filePath: string): Promise<SessionHeader | undefined> {
		return new Promise((resolve) => {
			const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 });
			let settled = false;

			stream.on("data", (chunk: string) => {
				if (settled) return;
				const lineEnd = chunk.indexOf("\n");
				if (lineEnd === -1) return;

				settled = true;
				stream.destroy();
				try {
					const header = JSON.parse(chunk.slice(0, lineEnd)) as SessionHeader;
					resolve(header.type === "session" ? header : undefined);
				} catch {
					resolve(undefined);
				}
			});

			stream.on("error", () => {
				if (!settled) {
					settled = true;
					resolve(undefined);
				}
			});

			stream.on("end", () => {
				if (!settled) {
					settled = true;
					resolve(undefined);
				}
			});
		});
	}

	/**
	 * Spawn a pi RPC process for the given session if not already running.
	 * Lazy — only spawns when first called for a session.
	 *
	 * @throws Error if max sessions reached
	 */
	async spawnIfNeeded(sessionId: string): Promise<void> {
		if (this.sessions.has(sessionId)) {
			return; // Already running
		}

		if (this.sessions.size >= this.maxSessions) {
			throw new Error(`Max sessions (${this.maxSessions}) reached, delete one to create new`);
		}

		// Use the cwd stored in the pool, not the sessionsDir (decode is lossy:
		// pi's encoding replaces `/` and `:` with `-`, but the original path
		// may also contain real `-` characters, so we cannot reliably reverse it).
		const cwdFromDir = this.cwd;

		// Look up the session file to pass the full path to pi.
		// pi's resolveSessionPath treats a path with "/" or ".jsonl" as a direct file path,
		// avoiding the "fork prompt" when a session is found in global but cwd differs.
		const sessionFile = await findSessionFile(this.sessionsDir, sessionId);
		const sessionArg = sessionFile ?? sessionId;

		const newPath = `${process.env.HOME}/.npm-global/bin:${process.env.PATH ?? ""}`;
		const proc = this.spawnFn("pi", ["--mode", "rpc", "--session", sessionArg], {
			stdio: ["pipe", "pipe", "inherit"],
			cwd: cwdFromDir,
			env: { ...process.env, PATH: newPath },
			detached: false,
		});

		const state: SessionState = { proc, subscribers: new Set(), titlesSeen: new Set(), isResponding: false };

		// Handle stdout JSON-line output.
		//
		// BUFFER ACROSS CHUNKS: Node's `data` event does NOT guarantee
		// line-aligned chunks. A single JSON line from pi can arrive in 2+
		// pieces. Without buffering, each half fails JSON.parse and the
		// event is silently dropped (the catch below would swallow it), so
		// the webui never sees the streaming update and the user has to wait
		// for the 3-second polling fallback (or switch chats) to see the
		// response. See test (m2) for the reproducer.
		let stdoutBuffer = "";
		const handleStdoutLine = (line: string) => {
			try {
				const event = JSON.parse(line);
				// Track session name from session_info_changed events
				if (typeof event === "object" && event !== null && (event as any).type === "session_info_changed") {
					const name = (event as any).name;
					if (typeof name === "string") {
						this.sessionNames.set(sessionId, name);
					}
				}
				// Emit session_status_changed("idle") when the agent finishes
				// a turn (after all message_end, turn_end, agent_end). This
				// is the source of truth for "the model is done" — the
				// webui uses it to clear its "thinking" indicator.
				if (typeof event === "object" && event !== null) {
					const t = (event as any).type;
					if (t === "agent_end" && state.isResponding) {
						state.isResponding = false;
						this.emit("event", {
							sessionId,
							event: { type: "session_status_changed", status: "idle" },
						} as PiEvent);
					}
				}
				// Emit on the pool for external listeners (e.g. WS handler)
				// The WS handler is responsible for forwarding to subscribers
				// with the proper {type:"session_event",sessionId,event} wrapper
				this.emit("event", { sessionId, event } as PiEvent);
			} catch {
				// Ignore non-JSON output
			}
		};
		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newlineIndex: number;
			while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (line) handleStdoutLine(line);
			}
		});
		// Drain any trailing buffered content (e.g. proc closed without a
		// final newline).
		const drainStdout = () => {
			if (!stdoutBuffer) return;
			const line = stdoutBuffer;
			stdoutBuffer = "";
			handleStdoutLine(line);
		};
		// stdout's "end" event fires when pi closes the pipe cleanly. Also
		// drain on proc "exit" as a safety net for stdio streams that never
		// emit "end" (e.g. crash / SIGKILL).
		proc.stdout?.on("end", drainStdout);

		proc.on("exit", (code, signal) => {
			drainStdout();
			// If pi exited mid-turn (crash / SIGKILL / OOM), the "idle" event
			// was never emitted by the agent_end path. Emit it here so the
			// client transitions the Stop button → Send and the user isn't
			// stuck with a non-functional Stop button that points at a dead
			// process (clicking it would send abort to nothing).
			if (state.isResponding) {
				state.isResponding = false;
				this.emit("event", {
					sessionId,
					event: { type: "session_status_changed", status: "idle" },
				} as PiEvent);
			}
			this.sessions.delete(sessionId);
			this.emit("exit", { sessionId, code, signal });
		});

		proc.on("error", (err) => {
			this.emit("error", { sessionId, error: err });
		});

		this.sessions.set(sessionId, state);
		this.ownedSessions.add(sessionId);
		void this.persistOwnedSessions();
	}

	/**
	 * Check if a session is managed by webui (has a webui-spawned pi process).
	 * Returns false for TUI-managed sessions.
	 */
	isSessionManaged(sessionId: string): boolean {
		return this.ownedSessions.has(sessionId);
	}

	/**
	 * Mark a session as webui-owned without spawning a process. Called when
	 * webui creates a new session via POST /api/sessions so the UI knows
	 * the input is enabled before the first prompt arrives. The flag is
	 * persisted to disk so it survives server restarts.
	 */
	markSessionOwned(sessionId: string): void {
		this.ownedSessions.add(sessionId);
		void this.persistOwnedSessions();
	}

	/**
	 * Remove a session from the webui-owned set. Called when the session file
	 * is deleted so the persisted state stays in sync with disk.
	 */
	unmarkSessionOwned(sessionId: string): void {
		this.ownedSessions.delete(sessionId);
		void this.persistOwnedSessions();
	}

	/**
	 * Subscribe a WebSocket client to a session's events.
	 * The client will receive all stdout events from the pi process.
	 */
	subscribe(sessionId: string, client: WSClient): void {
		const state = this.sessions.get(sessionId);
		if (state) {
			state.subscribers.add(client);
		}
	}

	/**
	 * Unsubscribe a WebSocket client from a session.
	 */
	unsubscribe(sessionId: string, client: WSClient): void {
		const state = this.sessions.get(sessionId);
		if (state) {
			state.subscribers.delete(client);
		}
	}

	/**
	 * Broadcast an event to all WS clients of a session.
	 */
	broadcast(sessionId: string, event: unknown): void {
		const state = this.sessions.get(sessionId);
		if (!state) return;

		const msg = JSON.stringify(event);
		state.subscribers.forEach((ws) => {
			ws.send(msg);
		});
	}

	/**
	 * Write a JSON-line message to a session's pi process stdin.
	 * Spawns the process if not running.
	 */
	async prompt(
		sessionId: string,
		text: string,
		images?: Array<{ mediaType: string; data: string }>,
	): Promise<void> {
		await this.spawnIfNeeded(sessionId);
		const state = this.sessions.get(sessionId);
		if (!state) return;
		const content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string }> = [
			{ type: "text", text },
		];
		if (images) {
			for (const img of images) {
				content.push({ type: "image", mediaType: img.mediaType, data: img.data });
			}
		}
		const msg = JSON.stringify({ type: "prompt", sessionId, content, message: text }) + "\n";
		state.proc.stdin?.write(msg);
		// Emit running BEFORE the model has even started, so the webui can
		// immediately show a "thinking..." indicator. The next agent_end
		// from the JSONL stream will clear it.
		if (!state.isResponding) {
			state.isResponding = true;
			this.emit("event", {
				sessionId,
				event: { type: "session_status_changed", status: "running" },
			} as PiEvent);
		}
	}

	/**
	 * Send set_session_name to the pi RPC process.
	 * Idempotent — subsequent calls for the same sessionId are no-ops.
	 */
	async setSessionName(sessionId: string, name: string): Promise<void> {
		await this.spawnIfNeeded(sessionId);
		const state = this.sessions.get(sessionId);
		if (!state) throw new Error(`Session ${sessionId} not found`);
		if (state.titlesSeen.has(sessionId)) return; // idempotent
		state.titlesSeen.add(sessionId);
		const corrId = crypto.randomUUID();
		const msg = JSON.stringify({ type: "set_session_name", id: corrId, name }) + "\n";

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				state.proc.stdout?.off("data", onData);
				reject(new Error("setSessionName timed out after 5s"));
			}, 5000);

			const onData = (chunk: Buffer | string) => {
				const lines = chunk.toString().split("\n").filter((l) => l.trim());
				for (const line of lines) {
					try {
						const evt = JSON.parse(line);
						if (evt.type === "response" && evt.command === "set_session_name" && evt.id === corrId) {
							clearTimeout(timeout);
							state.proc.stdout?.off("data", onData);
							if (evt.success) resolve();
							else reject(new Error(evt.error || "setSessionName failed"));
							return;
						}
					} catch {}
				}
			};
			state.proc.stdout?.on("data", onData);
			state.proc.stdin?.write(msg);
		});
	}

	/**
	 * Send an abort signal to a session's pi process stdin.
	 */
	abort(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) return;
		const msg = JSON.stringify({ type: "abort", sessionId }) + "\n";
		state.proc.stdin?.write(msg);
	}

	/**
	 * Send a `compact` RPC to the pi process and resolve when the matching
	 * `response` line arrives on stdout. The pi process emits
	 * `compaction_start` / `compaction_end` events on its own bus, which the
	 * existing event proxy forwards to subscribed WS clients — the caller
	 * does not need to interpret them.
	 *
	 * 30s timeout: compaction calls the model to summarize the branch, so
	 * it can take noticeably longer than `setSessionName`. The pi session
	 * aborts any in-flight agent loop before compacting, so this is safe to
	 * call regardless of session_status.
	 */
	async compact(sessionId: string, customInstructions?: string): Promise<void> {
		await this.spawnIfNeeded(sessionId);
		const state = this.sessions.get(sessionId);
		if (!state) throw new Error(`Session ${sessionId} not found`);
		const corrId = crypto.randomUUID();
		const msg =
			JSON.stringify({
				type: "compact",
				id: corrId,
				...(customInstructions ? { customInstructions } : {}),
			}) + "\n";

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				state.proc.stdout?.off("data", onData);
				reject(new Error("compact timed out after 30s"));
			}, 30_000);

			const onData = (chunk: Buffer | string) => {
				const lines = chunk.toString().split("\n").filter((l) => l.trim());
				for (const line of lines) {
					try {
						const evt = JSON.parse(line);
						if (
							evt.type === "response" &&
							evt.command === "compact" &&
							evt.id === corrId
						) {
							clearTimeout(timeout);
							state.proc.stdout?.off("data", onData);
							if (evt.success) resolve();
							else reject(new Error(evt.error || "compact failed"));
							return;
						}
					} catch {}
				}
			};
			state.proc.stdout?.on("data", onData);
			state.proc.stdin?.write(msg);
		});
	}

	/**
	 * Write an extension_ui_response message to a session's pi process stdin.
	 * Used to forward user choices from webui modal back to the extension.
	 * Silent no-op if session/proc is missing.
	 */
	sendExtensionUIResponse(
		sessionId: string,
		response: { id: string; value?: string; confirmed?: boolean; cancelled?: true },
	): void {
		const state = this.sessions.get(sessionId);
		if (!state || !state.proc) return;
		const msg = JSON.stringify({ type: "extension_ui_response", ...response }) + "\n";
		state.proc.stdin?.write(msg);
	}

	/**
	 * Set the model for a session. If the session's pi process is already
	 * running, send a `set_model` RPC; if not, the next prompt will use
	 * the in-memory model (the JSONL model_change will be appended by
	 * the process once it spawns and applies the change).
	 */
	async setModel(sessionId: string, provider: string, model: string): Promise<void> {
		await this.spawnIfNeeded(sessionId);
		const state = this.sessions.get(sessionId);
		if (!state) return;
		const corrId = crypto.randomUUID();
		const msg = JSON.stringify({ type: "set_model", id: corrId, provider, modelId: model }) + "\n";
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				state.proc.stdout?.off("data", onData);
				reject(new Error("set_model timed out after 5s"));
			}, 5_000);
			const onData = (chunk: Buffer | string) => {
				const lines = chunk.toString().split("\n").filter((l) => l.trim());
				for (const line of lines) {
					try {
						const evt = JSON.parse(line);
						if (evt.id === corrId && evt.type === "response" && evt.command === "set_model") {
							clearTimeout(timeout);
							state.proc.stdout?.off("data", onData);
							if (evt.success) resolve();
							else reject(new Error(evt.error || "set_model failed"));
							return;
						}
					} catch {
						// ignore non-JSON
					}
				}
			};
			state.proc.stdout?.on("data", onData);
			state.proc.stdin?.write(msg);
		});
	}

	/**
	 * Kill a pi process for a session.
	 * Sends SIGTERM, waits up to 5s, then SIGKILL if still alive.
	 */
	async kill(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state) return;

		return new Promise((resolve) => {
			const proc = state.proc;

			const killTimeout = setTimeout(() => {
				// Force kill after 5s
				if (!proc.killed) {
					proc.kill("SIGKILL");
				}
			}, 5000);

			proc.once("exit", () => {
				clearTimeout(killTimeout);
				this.sessions.delete(sessionId);
				resolve();
			});

			proc.kill(signal);
		});
	}

	/**
	 * Cleanup all pi processes on exit. Best-effort — SIGTERM only, no wait.
	 */
	cleanupOnExit(): void {
		this.sessions.forEach((state) => {
			try {
				state.proc.kill("SIGTERM");
			} catch {
				// Best effort
			}
		});
		this.sessions.clear();
	}

	/**
	 * Get number of active sessions.
	 */
	get size(): number {
		return this.sessions.size;
	}

	/**
	 * Check if a session is currently running.
	 */
	isRunning(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/**
	 * Get the set of sessionIds that have already received setSessionName.
	 */
	getTitlesSeen(sessionId: string): Set<string> | undefined {
		return this.sessions.get(sessionId)?.titlesSeen;
	}

	/**
	 * Get the session name for a session, if set via session_info_changed event.
	 */
	getSessionName(sessionId: string): string | undefined {
		return this.sessionNames.get(sessionId);
	}
}
