import type { AgentState } from "@kennyfrc/mu-agent-core";
import { randomBytes } from "crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { StringDecoder } from "string_decoder";

import { recordModelUsage } from "./model-usage.js";

function uuidv4(): string {
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	title?: string; // Auto-generated conversation title
	branchedFrom?: string; // Path to the session file this was branched from
	handoffFrom?: string; // UUID of parent session (for handoff feature)
}

export interface SessionMessageEntry {
	type: "message";
	timestamp: string;
	message: any; // AppMessage from agent state
}

export interface SessionCustomEntry {
	type: "custom";
	timestamp: string;
	customType: string;
	data: unknown;
}

export type SessionCustomMessageDisplay = "visible" | "hidden";

export interface SessionCustomMessageEntry {
	type: "custom_message";
	timestamp: string;
	customType: string;
	message: unknown; // AppMessage from agent state
	display?: SessionCustomMessageDisplay;
}

export interface ThinkingLevelChangeEntry {
	type: "thinking_level_change";
	timestamp: string;
	thinkingLevel: string;
}

export interface ModelChangeEntry {
	type: "model_change";
	timestamp: string;
	provider: string;
	modelId: string;
}

export interface TitleChangeEntry {
	type: "title_change";
	timestamp: string;
	title: string;
}

export interface PreviewChangeEntry {
	type: "preview_change";
	timestamp: string;
	preview: string;
}

export class SessionManager {
	private sessionId!: string;
	private sessionFile!: string;
	private sessionDir: string;
	private enabled: boolean = true;
	private sessionInitialized: boolean = false;
	private pendingMessages: any[] = [];
	private readOnly: boolean = false;

	constructor(
		continueSession: boolean = false,
		customSessionPath?: string,
		readOnly: boolean = false,
		projectPath?: string,
	) {
		this.readOnly = readOnly;
		this.sessionDir = this.getSessionDirectory(projectPath);

		if (customSessionPath) {
			// Use custom session file path
			this.sessionFile = resolve(customSessionPath);
			this.loadSessionId();
			// Mark as initialized since we're loading an existing session
			this.sessionInitialized = existsSync(this.sessionFile);
		} else if (continueSession) {
			const mostRecent = this.findMostRecentlyModifiedSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				this.loadSessionId();
				// Mark as initialized since we're loading an existing session
				this.sessionInitialized = true;
			} else if (!readOnly) {
				this.initNewSession();
			}
		} else if (!readOnly) {
			this.initNewSession();
		}
	}

	/** Disable session saving (for --no-session mode) */
	disable() {
		this.enabled = false;
	}

	private getSessionDirectory(projectPath?: string): string {
		const cwd = projectPath ? resolve(projectPath) : process.cwd();
		// Replace all path separators and colons (for Windows drive letters) with dashes
		const safePath = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";

		const configDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/"));
		const sessionDir = join(configDir, "sessions", safePath);
		if (!existsSync(sessionDir) && !this.readOnly) {
			mkdirSync(sessionDir, { recursive: true });
		}
		return sessionDir;
	}

	/** Get the root sessions directory (~/.mu/agent/sessions/) */
	private getSessionsRootDir(): string {
		const configDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/"));
		return join(configDir, "sessions");
	}

	private initNewSession(): void {
		this.sessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(this.sessionDir, `${timestamp}_${this.sessionId}.jsonl`);
		this.exportSessionIdToEnv();
	}

	private exportSessionIdToEnv(): void {
		if (this.sessionId) {
			process.env.MU_SESSION_ID = this.sessionId;
		}
	}

	/** Reset to a fresh session. Clears pending messages and starts a new session file. */
	reset(): void {
		this.pendingMessages = [];
		this.sessionInitialized = false;
		this.initNewSession();
	}

	private findMostRecentlyModifiedSession(): string | null {
		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({
					name: f,
					path: join(this.sessionDir, f),
					mtime: statSync(join(this.sessionDir, f)).mtime,
				}))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			return null;
		}
	}

	private loadSessionId(): void {
		if (!existsSync(this.sessionFile)) {
			this.sessionId = uuidv4();
			this.exportSessionIdToEnv();
			return;
		}

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					this.sessionId = entry.id;
					this.exportSessionIdToEnv();
					return;
				}
			} catch {
				// Skip malformed lines
			}
		}
		this.sessionId = uuidv4();
		this.exportSessionIdToEnv();
	}

	startSession(state: AgentState): void {
		if (!this.enabled || this.sessionInitialized) return;
		this.sessionInitialized = true;

		const entry: SessionHeader = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			provider: state.model.provider,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");

		// Update model usage snapshot (best-effort)
		if (!this.readOnly) {
			recordModelUsage(this.sessionDir, state.model.provider, state.model.id, Date.now());
		}

		// Write any queued messages
		for (const msg of this.pendingMessages) {
			appendFileSync(this.sessionFile, JSON.stringify(msg) + "\n");
		}
		this.pendingMessages = [];
	}

	saveMessage(message: any): void {
		if (!this.enabled) return;
		const entry: SessionMessageEntry = {
			type: "message",
			timestamp: new Date().toISOString(),
			message,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	appendCustomEntry(customType: string, data: unknown): void {
		if (!this.enabled) return;
		const entry: SessionCustomEntry = {
			type: "custom",
			timestamp: new Date().toISOString(),
			customType,
			data,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	appendCustomMessage(
		customType: string,
		message: unknown,
		options?: { display?: SessionCustomMessageDisplay },
	): void {
		if (!this.enabled) return;
		const entry: SessionCustomMessageEntry = {
			type: "custom_message",
			timestamp: new Date().toISOString(),
			customType,
			message,
			display: options?.display,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	saveThinkingLevelChange(thinkingLevel: string): void {
		if (!this.enabled) return;
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	saveModelChange(provider: string, modelId: string): void {
		if (!this.enabled) return;

		// Update model usage snapshot (best-effort)
		if (!this.readOnly) {
			recordModelUsage(this.sessionDir, provider, modelId, Date.now());
		}

		const entry: ModelChangeEntry = {
			type: "model_change",
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	loadMessages(): any[] {
		if (!existsSync(this.sessionFile)) return [];

		const messages: any[] = [];
		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" || entry.type === "custom_message") {
					// Both entry types contain an AppMessage payload in `message`.
					messages.push(entry.message as { role: string; content: unknown });
				}
			} catch {
				// Skip malformed lines
			}
		}

		return messages;
	}

	loadThinkingLevel(): string {
		if (!existsSync(this.sessionFile)) return "off";

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		// Find the most recent thinking level (from session header or change event)
		let lastThinkingLevel = "off";
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.thinkingLevel) {
					lastThinkingLevel = entry.thinkingLevel;
				} else if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
					lastThinkingLevel = entry.thinkingLevel;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return lastThinkingLevel;
	}

	loadModel(): { provider: string; modelId: string } | null {
		if (!existsSync(this.sessionFile)) return null;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");

		// Find the most recent model (from session header or change event)
		let lastProvider: string | null = null;
		let lastModelId: string | null = null;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.provider && entry.modelId) {
					lastProvider = entry.provider;
					lastModelId = entry.modelId;
				} else if (entry.type === "model_change" && entry.provider && entry.modelId) {
					lastProvider = entry.provider;
					lastModelId = entry.modelId;
				}
			} catch {
				// Skip malformed lines
			}
		}

		if (lastProvider && lastModelId) {
			return { provider: lastProvider, modelId: lastModelId };
		}
		return null;
	}

	saveTitle(title: string): void {
		if (!this.enabled) return;
		const entry: TitleChangeEntry = {
			type: "title_change",
			timestamp: new Date().toISOString(),
			title,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	savePreview(preview: string): void {
		if (!this.enabled) return;
		const entry: PreviewChangeEntry = {
			type: "preview_change",
			timestamp: new Date().toISOString(),
			preview,
		};

		if (!this.sessionInitialized) {
			this.pendingMessages.push(entry);
		} else {
			appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
		}
	}

	loadTitle(): string | null {
		if (!existsSync(this.sessionFile)) return null;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		let lastTitle: string | null = null;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session" && entry.title) {
					lastTitle = entry.title;
				} else if (entry.type === "title_change" && entry.title) {
					lastTitle = entry.title;
				}
			} catch {
				// Skip malformed lines
			}
		}
		return lastTitle;
	}

	loadPreview(): string | null {
		if (!existsSync(this.sessionFile)) return null;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		let lastPreview: string | null = null;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "preview_change" && entry.preview) {
					lastPreview = entry.preview;
				}
			} catch {
				// Skip malformed lines
			}
		}
		return lastPreview;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}

	isInitialized(): boolean {
		return this.sessionInitialized;
	}

	/** Helper to find a session by UUID in a specific directory */
	private findSessionInDir(dir: string, uuid: string): string | null {
		try {
			if (!existsSync(dir)) return null;
			const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

			// First try filename match (faster)
			for (const file of files) {
				if (file.includes(uuid)) {
					const fullPath = join(dir, file);
					// Verify by checking session header
					if (this.verifySessionUuid(fullPath, uuid)) {
						return fullPath;
					}
				}
			}

			// Fallback: scan all files and check headers (slower but handles edge cases)
			for (const file of files) {
				const fullPath = join(dir, file);
				if (this.verifySessionUuid(fullPath, uuid)) {
					return fullPath;
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	/** Find a session by UUID in the current workspace directory */
	findSessionByUuid(uuid: string): string | null {
		return this.findSessionInDir(this.sessionDir, uuid);
	}

	/** Find a session by UUID across ALL workspace directories */
	findSessionByUuidGlobal(uuid: string): string | null {
		// First check current workspace (optimization for common case)
		const inCurrent = this.findSessionInDir(this.sessionDir, uuid);
		if (inCurrent) return inCurrent;

		// Search all workspace directories
		const rootDir = this.getSessionsRootDir();
		if (!existsSync(rootDir)) return null;

		try {
			const entries = readdirSync(rootDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.startsWith("--")) {
					const workspaceDir = join(rootDir, entry.name);
					// Skip current workspace (already checked)
					if (workspaceDir === this.sessionDir) continue;

					const found = this.findSessionInDir(workspaceDir, uuid);
					if (found) return found;
				}
			}
		} catch {
			// Root directory access failed
		}

		return null;
	}

	/**
	 * Get formatted thread content as markdown for a given session/thread ID.
	 *
	 * @param options.maxMessages Max messages to return (default: 50)
	 * @param options.startIndex Message index to start from (default: 0)
	 * @param options.detailed If false (default), returns a "clean transcript" containing only
	 *                         User and Assistant text, omitting all tool calls and outputs.
	 * @param options.globalSearch If true, search across all workspaces (default: false)
	 */
	getThreadContent(
		sessionId: string,
		options: {
			maxMessages?: number;
			startIndex?: number;
			detailed?: boolean;
			globalSearch?: boolean;
		} = {},
	): { content: string; totalMessages: number; returnedMessages: number } | null {
		const sessionPath = options.globalSearch
			? this.findSessionByUuidGlobal(sessionId)
			: this.findSessionByUuid(sessionId);
		if (!sessionPath) return null;

		const { maxMessages = 50, startIndex = 0, detailed = true } = options;

		try {
			const content = readFileSync(sessionPath, "utf8");
			const lines = content.trim().split("\n");
			const output: string[] = [];
			const messages: Array<{ role: string; content: unknown }> = [];

			const isMessageLike = (value: unknown): value is { role: string; content: unknown } => {
				if (!value || typeof value !== "object") return false;
				const v = value as Record<string, unknown>;
				return typeof v.role === "string" && "content" in v;
			};

			// 1. Parse all message entries
			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" || entry.type === "custom_message") {
						// Both entry types contain an AppMessage payload in `message`.
						const message = (entry as { message?: unknown }).message;
						if (isMessageLike(message)) {
							messages.push(message);
						}
					}
				} catch {
					// Skip malformed lines
				}
			}

			const totalMessages = messages.length;

			// 2. Apply pagination
			const slicedMessages = messages.slice(startIndex, startIndex + maxMessages);
			const returnedMessages = slicedMessages.length;

			// 3. Format messages
			for (const msg of slicedMessages) {
				const role = msg.role;

				if (role === "user") {
					let text = "";
					if (Array.isArray(msg.content)) {
						text = (msg.content as Array<{ type: string; text?: string }>)
							.map((c) => c.text || (c.type === "image" ? "[Image]" : ""))
							.join("\n");
					} else {
						text = msg.content as string;
					}
					output.push(`## User\n${text}`);
				} else if (role === "assistant") {
					let text = "";
					let hasToolCalls = false;

					if (Array.isArray(msg.content)) {
						for (const part of msg.content as Array<{
							type: string;
							text?: string;
							name?: string;
							arguments?: Record<string, unknown>;
						}>) {
							if (part.type === "text") {
								text += part.text + "\n";
							} else if (part.type === "toolCall") {
								hasToolCalls = true;
								if (detailed) {
									// Detailed mode: Show tool call with simplified args
									text += `\n> Used tool \`${part.name}\``;
									if (part.arguments && Object.keys(part.arguments).length > 0) {
										const argsStr = JSON.stringify(part.arguments, null, 2);
										const MAX_ARGS_LEN = 500;
										if (argsStr.length > MAX_ARGS_LEN) {
											text += ` with arguments: ${argsStr.substring(0, MAX_ARGS_LEN)}... (truncated)\n`;
										} else {
											text += ` with arguments: ${argsStr}\n`;
										}
									} else {
										text += "\n";
									}
								}
								// Non-detailed mode: completely omit tool calls
							}
						}
					} else {
						text = msg.content as string;
					}

					// Only output if there is text, or if detailed mode shows tool calls
					if (text.trim() || (detailed && hasToolCalls)) {
						output.push(`## Assistant\n${text.trim()}`);
					}
				} else if (role === "toolResult" && detailed) {
					// Only show tool results in detailed mode
					const toolMsg = msg as { content: unknown; toolName?: string };
					let resultContent = "";
					if (Array.isArray(toolMsg.content)) {
						resultContent = (toolMsg.content as Array<{ type: string; text?: string }>)
							.map((c) => c.text || "")
							.join("\n");
					} else {
						resultContent = (toolMsg.content as string) || "";
					}

					const name = toolMsg.toolName || "unknown";
					const limit = 2048;

					if (resultContent.length > limit) {
						resultContent =
							resultContent.substring(0, limit) +
							`\n... (output truncated, total length: ${resultContent.length} chars)`;
					}
					output.push(`> Output from \`${name}\`:\n${resultContent}`);
				}
			}

			return {
				content: output.join("\n\n"),
				totalMessages,
				returnedMessages,
			};
		} catch {
			return null;
		}
	}

	private verifySessionUuid(filePath: string, uuid: string): boolean {
		try {
			if (!existsSync(filePath)) return false;

			// Read only the first 1KB to get the header line
			const buffer = Buffer.alloc(1024);
			const fd = openSync(filePath, "r");
			let firstLine = "";

			try {
				const bytesRead = readSync(fd, buffer, 0, 1024, 0);
				const content = buffer.toString("utf8", 0, bytesRead);
				firstLine = content.split("\n")[0];
			} finally {
				closeSync(fd);
			}

			if (!firstLine) return false;

			const entry = JSON.parse(firstLine);
			return entry.type === "session" && entry.id === uuid;
		} catch {
			return false;
		}
	}

	/** Helper to load sessions from a specific directory */
	private loadSessionsFromDir(dir: string): Array<{
		path: string;
		id: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		title?: string;
		allMessagesText: string;
		cwd: string;
	}> {
		const sessions: Array<{
			path: string;
			id: string;
			created: Date;
			modified: Date;
			messageCount: number;
			firstMessage: string;
			title?: string;
			allMessagesText: string;
			cwd: string;
		}> = [];

		try {
			if (!existsSync(dir)) {
				return sessions;
			}
			const files = readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => join(dir, f));

			for (const file of files) {
				try {
					const stats = statSync(file);
					const content = readFileSync(file, "utf8");
					const lines = content.trim().split("\n");

					let sessionId = "";
					let created = stats.birthtime;
					let messageCount = 0;
					let firstMessage = "";
					let lastTitle = "";
					let cwd = "";
					const allMessages: string[] = [];

					for (const line of lines) {
						try {
							const entry = JSON.parse(line);

							// Extract session ID, cwd, and title from session entry
							if (entry.type === "session") {
								if (!sessionId) {
									sessionId = entry.id;
									created = new Date(entry.timestamp);
									cwd = entry.cwd || "";
								}
								if (typeof entry.title === "string" && entry.title.trim()) {
									lastTitle = entry.title;
								}
							}

							if (entry.type === "title_change" && typeof entry.title === "string" && entry.title.trim()) {
								lastTitle = entry.title;
							}

							// Count messages and collect all text
							if (entry.type === "message" || entry.type === "custom_message") {
								messageCount++;

								// Extract text from user and assistant messages
								if (entry.message.role === "user" || entry.message.role === "assistant") {
									const msgContent = entry.message.content;
									const textContent = Array.isArray(msgContent)
										? msgContent
												.filter((c: any) => c.type === "text")
												.map((c: any) => c.text)
												.join(" ")
										: typeof msgContent === "string"
											? msgContent
											: "";

									if (textContent) {
										allMessages.push(textContent);

										// Get first user message for display
										if (!firstMessage && entry.message.role === "user") {
											firstMessage = textContent;
										}
									}
								}
							}
						} catch {
							// Skip malformed lines
						}
					}

					sessions.push({
						path: file,
						id: sessionId || "unknown",
						created,
						modified: stats.mtime,
						messageCount,
						firstMessage: firstMessage || "(no messages)",
						title: lastTitle || undefined,
						allMessagesText: allMessages.join(" "),
						cwd,
					});
				} catch {
					// Skip files that can't be read
				}
			}
		} catch {
			// Directory access failed
		}

		return sessions;
	}

	/** Load sessions from the current workspace directory */
	loadAllSessions(): Array<{
		path: string;
		id: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		title?: string;
		allMessagesText: string;
		cwd: string;
	}> {
		const sessions = this.loadSessionsFromDir(this.sessionDir);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/** Load sessions from ALL workspace directories */
	loadAllSessionsGlobal(): Array<{
		path: string;
		id: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		title?: string;
		allMessagesText: string;
		cwd: string;
	}> {
		const allSessions: Array<{
			path: string;
			id: string;
			created: Date;
			modified: Date;
			messageCount: number;
			firstMessage: string;
			title?: string;
			allMessagesText: string;
			cwd: string;
		}> = [];

		const rootDir = this.getSessionsRootDir();
		if (!existsSync(rootDir)) {
			return allSessions;
		}

		try {
			const entries = readdirSync(rootDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.startsWith("--")) {
					const workspaceDir = join(rootDir, entry.name);
					const sessions = this.loadSessionsFromDir(workspaceDir);
					allSessions.push(...sessions);
				}
			}
		} catch {
			// Root directory access failed
		}

		// Sort all sessions by modified date (most recent first)
		allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return allSessions;
	}

	setSessionFile(path: string): void {
		this.sessionFile = path;
		this.loadSessionId();
		this.sessionInitialized = existsSync(path);
		this.exportSessionIdToEnv();
	}

	/** Lazily load undo data from session file (chunked to avoid memory spike) */
	findToolResultDetails(toolCallId: string): any | null {
		if (!this.enabled || !existsSync(this.sessionFile)) return null;

		const fd = openSync(this.sessionFile, "r");
		const CHUNK_SIZE = 64 * 1024; // 64KB chunks
		const buffer = Buffer.alloc(CHUNK_SIZE);
		const decoder = new StringDecoder("utf8");
		let remainder = "";

		try {
			for (;;) {
				const bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, null);
				if (bytesRead === 0) {
					const final = decoder.end();
					if (final) remainder += final;
					break;
				}
				// StringDecoder handles multi-byte UTF-8 chars split across chunk boundaries
				const chunk = remainder + decoder.write(buffer.subarray(0, bytesRead));
				const lines = chunk.split("\n");
				remainder = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry.type === "message" && entry.message?.role === "toolResult") {
							if (entry.message.toolCallId === toolCallId) {
								return entry.message.details;
							}
						}
					} catch {
						// Skip malformed lines
					}
				}
			}

			if (remainder.trim()) {
				try {
					const entry = JSON.parse(remainder);
					if (entry.type === "message" && entry.message?.role === "toolResult") {
						if (entry.message.toolCallId === toolCallId) {
							return entry.message.details;
						}
					}
				} catch {
					// Skip malformed line
				}
			}
		} finally {
			closeSync(fd);
		}

		return null;
	}

	isEnabled(): boolean {
		return this.enabled;
	}
	shouldInitializeSession(messages: any[]): boolean {
		if (this.sessionInitialized) return false;

		const userMessages = messages.filter((m) => m.role === "user");
		const assistantMessages = messages.filter((m) => m.role === "assistant");

		return userMessages.length >= 1 && assistantMessages.length >= 1;
	}

	/** Streams messages from session file to preserve full undo data (stripped from memory) */
	createBranchedSession(state: any, branchFromIndex: number): string {
		const newSessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const newSessionFile = join(this.sessionDir, `${timestamp}_${newSessionId}.jsonl`);

		const entry: SessionHeader = {
			type: "session",
			id: newSessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			provider: state.model.provider,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			branchedFrom: this.sessionFile,
		};
		appendFileSync(newSessionFile, JSON.stringify(entry) + "\n");

		if (branchFromIndex >= 0 && existsSync(this.sessionFile)) {
			this.streamMessagesToFile(this.sessionFile, newSessionFile, branchFromIndex);
		} else if (branchFromIndex >= 0) {
			const messagesToWrite = state.messages.slice(0, branchFromIndex + 1);
			for (const message of messagesToWrite) {
				const messageEntry: SessionMessageEntry = {
					type: "message",
					timestamp: new Date().toISOString(),
					message,
				};
				appendFileSync(newSessionFile, JSON.stringify(messageEntry) + "\n");
			}
		}

		return newSessionFile;
	}

	private streamMessagesToFile(sourceFile: string, destFile: string, maxMessageIndex: number): void {
		const fd = openSync(sourceFile, "r");
		const CHUNK_SIZE = 64 * 1024;
		const buffer = Buffer.alloc(CHUNK_SIZE);
		const decoder = new StringDecoder("utf8");
		let remainder = "";
		let messageCount = 0;

		const append = (entry: unknown): void => {
			appendFileSync(destFile, JSON.stringify(entry) + "\n");
		};

		const copyEntry = (entry: unknown): boolean => {
			if (messageCount > maxMessageIndex) return true;
			if (typeof entry !== "object" || entry === null) return false;
			const rec = entry as Record<string, unknown>;
			const type = rec.type;

			if (type === "custom") {
				append({
					type: "custom",
					timestamp: new Date().toISOString(),
					customType: typeof rec.customType === "string" ? rec.customType : "unknown",
					data: rec.data,
				} satisfies SessionCustomEntry);
				return false;
			}

			if (type === "message") {
				append({
					type: "message",
					timestamp: new Date().toISOString(),
					message: rec.message,
				} satisfies SessionMessageEntry);
				messageCount++;
				return messageCount > maxMessageIndex;
			}

			if (type === "custom_message") {
				append({
					type: "custom_message",
					timestamp: new Date().toISOString(),
					customType: typeof rec.customType === "string" ? rec.customType : "unknown",
					message: rec.message,
					display: rec.display === "hidden" || rec.display === "visible" ? rec.display : undefined,
				} satisfies SessionCustomMessageEntry);
				messageCount++;
				return messageCount > maxMessageIndex;
			}

			return false;
		};

		try {
			for (;;) {
				const bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, null);
				if (bytesRead === 0) {
					const final = decoder.end();
					if (final) remainder += final;
					break;
				}

				const chunk = remainder + decoder.write(buffer.subarray(0, bytesRead));
				const lines = chunk.split("\n");
				remainder = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const entry: unknown = JSON.parse(line);
						if (copyEntry(entry)) return;
					} catch {
						// Skip malformed lines
					}
				}

				if (messageCount > maxMessageIndex) return;
			}

			if (remainder.trim() && messageCount <= maxMessageIndex) {
				try {
					const entry: unknown = JSON.parse(remainder);
					copyEntry(entry);
				} catch {
					// Skip malformed line
				}
			}
		} finally {
			closeSync(fd);
		}
	}

	/** Create a new session for handoff with reference to parent session. No messages are copied. */
	createHandoffSession(state: AgentState, handoffFromId?: string): string {
		const newSessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const newSessionFile = join(this.sessionDir, `${timestamp}_${newSessionId}.jsonl`);

		const entry: SessionHeader = {
			type: "session",
			id: newSessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			provider: state.model.provider,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			handoffFrom: handoffFromId,
		};
		appendFileSync(newSessionFile, JSON.stringify(entry) + "\n");

		return newSessionFile;
	}
}
