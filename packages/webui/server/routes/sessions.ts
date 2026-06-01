import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPool, SessionHeader } from "../session-pool";
import type { LLMClient } from "../llm-client";
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

			res.json(sessions);
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
				deps.memoryStore.writeAtom({
					id: atom.id ?? randomUUID(),
					type: atom.type,
					title: atom.title,
					summary: atom.summary,
					content: atom.content,
					tags: atom.tags,
					importance: atom.importance,
					strength: atom.strength,
					access_count: 0,
					last_access: now,
					created_at: now,
					updated_at: now,
					version: 1,
					archived: false,
					file_path: "",
					content_hash: createHash("sha256").update(atom.content).digest("hex"),
				});
			}
		}
		return atoms.length;
	} catch (llmErr) {
		console.warn("Memory extraction failed, proceeding with deletion:", llmErr);
		return 0;
	}
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
