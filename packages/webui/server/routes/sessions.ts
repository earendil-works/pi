import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPool, SessionHeader } from "../session-pool";
import type { LLMClient, ExtractedAtom } from "../llm-client";
import { MemoryStore } from "../memory-store";

function toIsoTs(date: Date): string {
	return date.toISOString().replace(/:/g, "-");
}

function sessionFilePath(sessionsDir: string, id: string, timestamp: string): string {
	return join(sessionsDir, `${timestamp}_${id}.jsonl`);
}

export interface SessionsDeps {
	llmClient?: LLMClient;
	memoryStore?: MemoryStore;
}

export function mountSessionsRoutes(app: express.Express, sessionPool: SessionPool, deps?: SessionsDeps): void {
	// GET /api/sessions - list all sessions from pool
	app.get("/api/sessions", async (_req, res) => {
		try {
			const sessionsDir = sessionPool.sessionsDir;
			const sessions: Array<SessionHeader & { sessionFile: string }> = [];

			try {
				const entries = await readdir(sessionsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
						continue;
					}
					const filePath = join(sessionsDir, entry.name);
					try {
						const header = await parseSessionHeader(filePath);
						if (header?.id) {
							sessions.push({
								...header,
								sessionFile: filePath,
							});
						}
					} catch {
						// Skip files that can't be parsed
					}
				}
			} catch {
				// Directory doesn't exist yet — return empty list
			}

			// Enrich with client-friendly fields: title, lastActive, status, messageCount
			const enriched = await Promise.all(
				sessions.map(async (s) => {
					const isRunning = sessionPool.isRunning(s.id);
					const msgCount = await countMessages(s.sessionFile);
					return {
						...s,
						title: deriveTitle(s),
						lastActive: s.timestamp,
						status: isRunning ? ("running" as const) : ("idle" as const),
						messageCount: msgCount,
					};
				}),
			);
			// Sort by lastActive descending
			enriched.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());

			res.json(enriched);
		} catch (err) {
			console.error("Error listing sessions:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	// POST /api/sessions - create new session
	app.post("/api/sessions", async (req, res) => {
		try {
			const { initialPrompt } = req.body as { initialPrompt?: string };
			const cwd = process.cwd();
			const sessionsDir = sessionPool.sessionsDir;

			// Ensure directory exists
			await mkdir(sessionsDir, { recursive: true });

			const sessionId = randomUUID();
			const timestamp = toIsoTs(new Date());
			const filePath = sessionFilePath(sessionsDir, sessionId, timestamp);

			const header: SessionHeader = {
				type: "session",
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd,
			};

			// Write header line to JSONL file
			await writeJsonlLine(filePath, header);

			res.status(200).json({
				id: sessionId,
				sessionFile: filePath,
			});
		} catch (err) {
			console.error("Error creating session:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	// GET /api/sessions/:id/messages - get paginated messages
	app.get("/api/sessions/:id/messages", async (req, res) => {
		try {
			const { id } = req.params;
			const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 1000);
			const offset = parseInt(req.query.offset as string, 10) || 0;

			const sessionsDir = sessionPool.sessionsDir;
			const filePath = await findSessionFile(sessionsDir, id);

			if (!filePath) {
				res.status(404).json({ error: "Session not found" });
				return;
			}

			const messages = await readMessages(filePath, limit, offset);
			res.json(messages);
		} catch (err) {
			console.error("Error reading messages:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	// DELETE /api/sessions/:id - delete session after extracting memory atoms
	app.delete("/api/sessions/:id", async (req, res) => {
		try {
			const { id } = req.params;
			const sessionsDir = sessionPool.sessionsDir;
			const filePath = await findSessionFile(sessionsDir, id);

			if (!filePath) {
				res.status(404).json({ error: "Session not found" });
				return;
			}

			// Read session content for extraction
			const jsonlContent = await readFile(filePath, "utf-8");
			const atomsExtracted = await extractAtomsSafely(jsonlContent, deps);

			// Delete the session file
			await unlink(filePath);

			res.json({ ok: true, atomsExtracted });
		} catch (err) {
			console.error("Error deleting session:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	});
}

/**
 * Attempt memory extraction. Returns the number of atoms extracted, or 0
 * if extraction failed or no LLM client is available. Errors are logged
 * but never thrown so deletion can proceed.
 */
async function extractAtomsSafely(jsonlContent: string, deps?: SessionsDeps): Promise<number> {
	if (!deps?.llmClient) return 0;
	try {
		const atoms = await deps.llmClient.extractAtoms(jsonlContent);
		if (atoms.length > 0 && deps.memoryStore) {
			const now = new Date().toISOString();
			for (const atom of atoms) {
				// Sanitize atom fields before writing
				const sanitized = sanitizeAtom(atom);
				if (!sanitized) continue; // Skip invalid atoms
				deps.memoryStore.writeAtom({
					id: sanitized.id ?? randomUUID(),
					type: sanitized.type,
					title: sanitized.title,
					summary: sanitized.summary,
					content: sanitized.content,
					tags: sanitized.tags,
					importance: sanitized.importance,
					strength: sanitized.strength,
					access_count: 0,
					last_access: now,
					created_at: now,
					updated_at: now,
					version: 1,
					archived: false,
					file_path: "",
					content_hash: createHash("sha256").update(sanitized.content).digest("hex"),
				});
			}
		}
		return atoms.length;
	} catch (llmErr) {
		console.warn("Memory extraction failed, proceeding with deletion:", llmErr);
		return 0;
	}
}

/**
 * Sanitize an extracted atom to enforce length and range constraints.
 * Returns null if the atom is invalid and should be skipped.
 */
function sanitizeAtom(atom: ExtractedAtom): { id: string; title: string; summary: string; content: string; tags: string[]; importance: number; strength: number; type: string } | null {
	// title/summary max 500 chars
	const title = typeof atom.title === "string" ? atom.title.slice(0, 500) : "";
	const summary = typeof atom.summary === "string" ? atom.summary.slice(0, 500) : "";

	// content max 32KB
	const content = typeof atom.content === "string" ? atom.content.slice(0, 32 * 1024) : "";

	// tags: max 20, each < 50 chars
	const rawTags = Array.isArray(atom.tags) ? atom.tags : [];
	const tags = rawTags
		.filter((t): t is string => typeof t === "string")
		.slice(0, 20)
		.map((t) => t.slice(0, 50));

	// importance and strength must be in [0, 1]
	let importance = typeof atom.importance === "number" ? atom.importance : 0.5;
	let strength = typeof atom.strength === "number" ? atom.strength : 1.0;
	importance = Math.max(0, Math.min(1, importance));
	strength = Math.max(0, Math.min(1, strength));

	// Require valid type
	if (!atom.type || typeof atom.type !== "string") return null;

	// Require non-empty title
	if (title.length === 0) return null;

	return { id: atom.id ?? randomUUID(), title, summary, content, tags, importance, strength, type: atom.type };
}

async function parseSessionHeader(filePath: string): Promise<SessionHeader | undefined> {
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

async function findSessionFile(sessionsDir: string, sessionId: string): Promise<string | undefined> {
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
				continue;
			}
			const filePath = join(sessionsDir, entry.name);
			const header = await parseSessionHeader(filePath);
			if (header?.id === sessionId) {
				return filePath;
			}
		}
	} catch {
		// Directory doesn't exist
	}
	return undefined;
}

async function writeJsonlLine(filePath: string, data: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const stream = createWriteStream(filePath, { flags: "w" });
		stream.write(JSON.stringify(data) + "\n", (err) => {
			if (err) {
				reject(err);
			}
		});
		stream.end(() => resolve());
	});
}

async function readMessages(
	filePath: string,
	limit: number,
	offset: number,
): Promise<unknown[]> {
	const content = await readFile(filePath, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim());

	// Skip header (first line)
	const messageLines = lines.slice(1);

	// Apply pagination
	const paginatedLines = messageLines.slice(offset, offset + limit);

	const messages: unknown[] = [];
	for (const line of paginatedLines) {
		try {
			messages.push(JSON.parse(line));
		} catch {
			// Skip invalid JSON lines
		}
	}

	return messages;
}

/**
 * Derive a human-friendly session title from the JSONL header.
 * Falls back to "session <id-prefix>" if no cwd is available.
 */
function deriveTitle(s: SessionHeader & { sessionFile: string }): string {
	const cwd = s.cwd ?? "";
	if (cwd) {
		const parts = cwd.split("/").filter((p) => p.length > 0);
		const last = parts[parts.length - 1];
		if (last) return `${last} (${s.id.slice(0, 8)})`;
	}
	return `session ${s.id.slice(0, 8)}`;
}

/**
 * Count the number of message entries in a session JSONL file.
 * Returns 0 on error.
 */
async function countMessages(sessionFile: string): Promise<number> {
	try {
		const content = await readFile(sessionFile, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());
		// Subtract 1 for the header line; clamp to 0
		return Math.max(0, lines.length - 1);
	} catch {
		return 0;
	}
}
