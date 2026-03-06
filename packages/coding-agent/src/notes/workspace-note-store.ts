import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "../utils/find-repo-root.js";

const WORKSPACE_NOTES_FILENAME = "workspace-notes.json";

interface WorkspaceNoteEntry {
	cwd: string;
	note: string;
	updatedAt: string;
}

interface WorkspaceNotesFile {
	version: 1;
	workspaces: Record<string, WorkspaceNoteEntry>;
}

export interface WorkspaceNoteStoreOptions {
	cwd?: string;
	baseDir?: string;
	now?: () => Date;
}

export interface WorkspaceNoteAppendResult {
	anchor: string;
}

export interface WorkspaceNoteSaveResult {
	deleted: boolean;
	note: string;
	workspaceKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getDefaultConfigDir(): string {
	return resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu", "agent"));
}

function normalizeWorkspaceNoteEntry(value: unknown): WorkspaceNoteEntry | null {
	if (!isRecord(value)) return null;
	const cwd = value.cwd;
	const note = value.note;
	const updatedAt = value.updatedAt;
	if (typeof cwd !== "string" || typeof note !== "string" || typeof updatedAt !== "string") {
		return null;
	}
	return { cwd, note, updatedAt };
}

function readWorkspaceNotesFile(filePath: string): WorkspaceNotesFile {
	if (!existsSync(filePath)) {
		return { version: 1, workspaces: {} };
	}

	let raw = "";
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return { version: 1, workspaces: {} };
	}

	if (!raw.trim()) {
		return { version: 1, workspaces: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { version: 1, workspaces: {} };
	}

	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.workspaces)) {
		return { version: 1, workspaces: {} };
	}

	const workspaces: Record<string, WorkspaceNoteEntry> = {};
	for (const [key, value] of Object.entries(parsed.workspaces)) {
		const entry = normalizeWorkspaceNoteEntry(value);
		if (entry) {
			workspaces[key] = entry;
		}
	}

	return { version: 1, workspaces };
}

function writeWorkspaceNotesFile(filePath: string, data: WorkspaceNotesFile): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmpPath, filePath);
}

function normalizeNoteForSave(note: string): string {
	return note.replace(/\r\n/g, "\n").trim();
}

export function getWorkspaceNoteAnchor(text: string): string {
	const normalized = text.trim();
	return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function getWorkspaceNoteKey(cwd: string = process.cwd()): string {
	const resolvedCwd = resolve(cwd);
	return findRepoRoot(resolvedCwd) ?? resolvedCwd;
}

export function getWorkspaceNotesFilePath(_cwd?: string): string {
	return join(getDefaultConfigDir(), WORKSPACE_NOTES_FILENAME);
}

export class WorkspaceNoteStore {
	private readonly cwd: string;
	private readonly filePath: string;
	private readonly now: () => Date;

	constructor(options: WorkspaceNoteStoreOptions = {}) {
		this.cwd = resolve(options.cwd ?? process.cwd());
		const configDir = resolve(options.baseDir ?? getDefaultConfigDir());
		this.filePath = join(configDir, WORKSPACE_NOTES_FILENAME);
		this.now = options.now ?? (() => new Date());
	}

	getWorkspaceKey(): string {
		return getWorkspaceNoteKey(this.cwd);
	}

	getNote(): string {
		const file = readWorkspaceNotesFile(this.filePath);
		return file.workspaces[this.getWorkspaceKey()]?.note ?? "";
	}

	saveNote(note: string): WorkspaceNoteSaveResult {
		const normalizedNote = normalizeNoteForSave(note);
		const workspaceKey = this.getWorkspaceKey();
		const file = readWorkspaceNotesFile(this.filePath);

		if (!normalizedNote) {
			delete file.workspaces[workspaceKey];
			writeWorkspaceNotesFile(this.filePath, file);
			return {
				deleted: true,
				note: "",
				workspaceKey,
			};
		}

		file.workspaces[workspaceKey] = {
			cwd: workspaceKey,
			note: normalizedNote,
			updatedAt: this.now().toISOString(),
		};
		writeWorkspaceNotesFile(this.filePath, file);

		return {
			deleted: false,
			note: normalizedNote,
			workspaceKey,
		};
	}

	appendNote(text: string): WorkspaceNoteAppendResult {
		const normalizedText = normalizeNoteForSave(text);
		if (!normalizedText) {
			this.saveNote("");
			return { anchor: getWorkspaceNoteAnchor("") };
		}

		const existingNote = this.getNote();
		const nextNote = existingNote ? `${existingNote.trimEnd()}\n${normalizedText}` : normalizedText;
		this.saveNote(nextNote);
		return { anchor: getWorkspaceNoteAnchor(normalizedText) };
	}
}
