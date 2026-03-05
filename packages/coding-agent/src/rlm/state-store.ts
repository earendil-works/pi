/**
 * StateStore - Content-addressed blob store + SQLite index for session state
 *
 * Architecture:
 * - Blobs stored in ~/.mu/rlm/blobs/{sha256}
 * - Index stored in ~/.mu/rlm/index.db (SQLite)
 * - Session variables point to blob refs with metadata
 *
 * This decouples state from worker lifecycle - workers can crash/restart
 * without losing loaded data.
 */

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { copyFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import Database = require("better-sqlite3");

export interface VarMeta {
	variable: string;
	blobRef: string;
	size: number;
	lines?: number;
	/**
	 * Content type stored in the blob.
	 * Keep this wide (string) so we can add new types without migrations.
	 * Examples: "text", "json", "pdf_text", "pdf_scanned", "binary".
	 */
	type: string;
	encoding: string;
	createdAt: number;
}

export interface SearchResult {
	variable: string;
	line: number;
	content: string;
}

export interface StateStoreOptions {
	/** Base directory for blobs and index */
	baseDir?: string;
}

const DEFAULT_BASE_DIR = join(homedir(), ".mu", "rlm");

export class StateStore {
	private baseDir: string;
	private blobsDir: string;
	private db: Database.Database;

	constructor(opts: StateStoreOptions = {}) {
		this.baseDir = opts.baseDir || DEFAULT_BASE_DIR;
		this.blobsDir = join(this.baseDir, "blobs");

		// Ensure directories exist
		mkdirSync(this.baseDir, { recursive: true });
		mkdirSync(this.blobsDir, { recursive: true });

		// Initialize SQLite index
		const dbPath = join(this.baseDir, "index.db");
		this.db = new Database(dbPath);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER,
        last_accessed INTEGER
      );

      CREATE TABLE IF NOT EXISTS variables (
        session_id TEXT,
        variable TEXT,
        blob_ref TEXT,
        size INTEGER,
        lines INTEGER,
        type TEXT,
        encoding TEXT,
        created_at INTEGER,
        PRIMARY KEY (session_id, variable)
      );

      CREATE INDEX IF NOT EXISTS idx_variables_session ON variables(session_id);
    `);
	}

	/**
	 * Store blob, return content hash (sha256)
	 */
	putBlob(data: string | Buffer): string {
		const content = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
		const hash = createHash("sha256").update(content).digest("hex");

		const blobPath = this.getBlobPath(hash);
		if (!existsSync(blobPath)) {
			writeFileSync(blobPath, content);
		}

		return hash;
	}

	/**
	 * Store a file as a blob without loading it all into memory.
	 */
	async putBlobFromFile(filePath: string): Promise<{ hash: string; size: number }> {
		const h = createHash("sha256");
		let size = 0;
		await new Promise<void>((resolve, reject) => {
			const s = createReadStream(filePath);
			s.on("data", (chunk) => {
				const b = chunk as Buffer;
				size += b.length;
				h.update(b);
			});
			s.on("error", reject);
			s.on("end", () => resolve());
		});

		const hash = h.digest("hex");
		const blobPath = this.getBlobPath(hash);
		if (!existsSync(blobPath)) {
			await copyFile(filePath, blobPath);
		}

		return { hash, size };
	}

	getBlobPath(hash: string): string {
		return join(this.blobsDir, hash);
	}

	/**
	 * Get blob content by hash
	 */
	getBlob(hash: string): Buffer | null {
		const blobPath = this.getBlobPath(hash);
		if (!existsSync(blobPath)) {
			return null;
		}
		return readFileSync(blobPath);
	}

	/**
	 * Bind variable to blob ref with metadata
	 */
	bindVar(sessionId: string, variable: string, blobRef: string, meta: Partial<VarMeta>): void {
		const now = Date.now();

		// Ensure session exists
		const sessionStmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, created_at, last_accessed)
      VALUES (?, ?, ?)
    `);
		sessionStmt.run(sessionId, now, now);

		// Insert/update variable
		const varStmt = this.db.prepare(`
      INSERT OR REPLACE INTO variables
      (session_id, variable, blob_ref, size, lines, type, encoding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

		varStmt.run(
			sessionId,
			variable,
			blobRef,
			meta.size || 0,
			meta.lines || 0,
			meta.type || "text",
			meta.encoding || "utf-8",
			now,
		);

		// Update session last accessed
		this.db.prepare(`UPDATE sessions SET last_accessed = ? WHERE session_id = ?`).run(now, sessionId);
	}

	/**
	 * Get variable metadata (doesn't load content)
	 */
	getVarMeta(sessionId: string, variable: string): VarMeta | null {
		const stmt = this.db.prepare(`
      SELECT variable, blob_ref, size, lines, type, encoding, created_at
      FROM variables
      WHERE session_id = ? AND variable = ?
    `);

		const row = stmt.get(sessionId, variable) as any;
		if (!row) return null;

		return {
			variable: row.variable,
			blobRef: row.blob_ref,
			size: row.size,
			lines: row.lines,
			type: row.type,
			encoding: row.encoding,
			createdAt: row.created_at,
		};
	}

	/**
	 * Get variable content (loads blob)
	 */
	getVarContent(sessionId: string, variable: string): Buffer | null {
		const meta = this.getVarMeta(sessionId, variable);
		if (!meta) return null;
		return this.getBlob(meta.blobRef);
	}

	/**
	 * List all variables for session
	 */
	listVars(sessionId: string): VarMeta[] {
		const stmt = this.db.prepare(`
      SELECT variable, blob_ref, size, lines, type, encoding, created_at
      FROM variables
      WHERE session_id = ?
    `);

		const rows = stmt.all(sessionId) as any[];
		return rows.map((row) => ({
			variable: row.variable,
			blobRef: row.blob_ref,
			size: row.size,
			lines: row.lines,
			type: row.type,
			encoding: row.encoding,
			createdAt: row.created_at,
		}));
	}

	/**
	 * Search for text in variables (simple grep)
	 */
	search(sessionId: string, query: string, limit = 20): SearchResult[] {
		const vars = this.listVars(sessionId);
		const results: SearchResult[] = [];

		const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

		for (const v of vars) {
			if (results.length >= limit) break;
			const blobPath = this.getBlobPath(v.blobRef);
			if (!existsSync(blobPath)) continue;

			if (hasRg) {
				const maxCount = String(Math.max(1, limit - results.length));
				const rg = spawnSync(
					"rg",
					["-n", "--no-heading", "--color", "never", "--max-count", maxCount, query, blobPath],
					{ encoding: "utf-8" },
				);
				if (!rg.error && (rg.status === 0 || rg.status === 1)) {
					// status=0 match, status=1 no match
					const out = (rg.stdout || "").trim();
					if (out) {
						for (const line of out.split("\n")) {
							const m = line.match(/^(\d+):(.*)$/);
							if (!m) continue;
							results.push({ variable: v.variable, line: Number(m[1]), content: m[2].slice(0, 200) });
							if (results.length >= limit) break;
						}
					}
				}
				continue;
			}

			// Fallback: load and scan
			const queryLower = query.toLowerCase();
			const text = readFileSync(blobPath, "utf-8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length && results.length < limit; i++) {
				if (lines[i].toLowerCase().includes(queryLower)) {
					results.push({ variable: v.variable, line: i + 1, content: lines[i].slice(0, 200) });
				}
			}
		}

		return results;
	}

	/**
	 * Slice content from variable
	 */
	slice(sessionId: string, variable: string, start: number, end: number): string | null {
		const meta = this.getVarMeta(sessionId, variable);
		if (!meta) return null;
		const blobPath = this.getBlobPath(meta.blobRef);
		if (!existsSync(blobPath)) return null;

		// Prefer sed for large files
		const from = start + 1;
		const to = end;
		const sed = spawnSync("sed", ["-n", `${from},${to}p`, blobPath], { encoding: "utf-8" });
		if (!sed.error && sed.status === 0) {
			return sed.stdout;
		}

		// Fallback: load
		const text = readFileSync(blobPath, "utf-8");
		return text.split("\n").slice(start, end).join("\n");
	}

	/**
	 * Count occurrences of term in variable
	 */
	count(sessionId: string, variable: string, term: string): number {
		const meta = this.getVarMeta(sessionId, variable);
		if (!meta) return 0;
		const blobPath = this.getBlobPath(meta.blobRef);
		if (!existsSync(blobPath)) return 0;

		const rg = spawnSync("rg", ["-o", "--no-filename", "--color", "never", term, blobPath], {
			encoding: "utf-8",
		});
		if (!rg.error && (rg.status === 0 || rg.status === 1)) {
			const out = (rg.stdout || "").trim();
			if (!out) return 0;
			return out.split("\n").length;
		}

		const text = readFileSync(blobPath, "utf-8").toLowerCase();
		const termLower = term.toLowerCase();
		let count = 0;
		let pos = 0;
		while (true) {
			const nextPos = text.indexOf(termLower, pos);
			if (nextPos === -1) break;
			count++;
			pos = nextPos + termLower.length;
		}
		return count;
	}

	/**
	 * Delete all variables for session
	 */
	deleteSession(sessionId: string): void {
		// Delete variables
		this.db.prepare(`DELETE FROM variables WHERE session_id = ?`).run(sessionId);

		// Delete session
		this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);

		// Note: We don't delete blobs - they might be shared across sessions
		// GC should be done separately based on refcount
	}

	/**
	 * Close database connection
	 */
	close(): void {
		this.db.close();
	}
}
