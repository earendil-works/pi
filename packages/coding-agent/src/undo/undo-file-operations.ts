import type { AssistantMessage, Message, ToolResultMessage } from "@kennyfrc/mu-ai";

import { createHash } from "crypto";
import { readFile, unlink, writeFile } from "fs/promises";
import { relative } from "path";

import type { SessionManager } from "../session-manager.js";
import type { ApplyPatchToolDetails, ApplyPatchUndoEntry } from "../tools/apply-patch.js";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readToolResultDetails(sessionManager: SessionManager, toolCallId: string): unknown {
	// SessionManager.findToolResultDetails() is intentionally typed as `any`.
	// We treat it as unknown here and validate/parse what we need.
	return sessionManager.findToolResultDetails(toolCallId) as unknown;
}

interface EditUndoDetails {
	path: string;
	oldText?: string;
	newText?: string;
	index?: number;
	newContentHash?: string;
}

interface WriteUndoDetails {
	path: string;
	created: boolean;
	previousContent?: string | null;
	newContentHash?: string;
}

function parseEditUndoDetails(details: unknown): EditUndoDetails | null {
	if (!isRecord(details)) return null;
	if (typeof details.path !== "string") return null;

	const out: EditUndoDetails = { path: details.path };
	if (typeof details.oldText === "string") out.oldText = details.oldText;
	if (typeof details.newText === "string") out.newText = details.newText;
	if (typeof details.index === "number") out.index = details.index;
	if (typeof details.newContentHash === "string") out.newContentHash = details.newContentHash;
	return out;
}

function parseWriteUndoDetails(details: unknown): WriteUndoDetails | null {
	if (!isRecord(details)) return null;
	if (typeof details.path !== "string") return null;
	if (typeof details.created !== "boolean") return null;

	const out: WriteUndoDetails = { path: details.path, created: details.created };
	if (typeof details.previousContent === "string" || details.previousContent === null) {
		out.previousContent = details.previousContent;
	}
	if (typeof details.newContentHash === "string") out.newContentHash = details.newContentHash;
	return out;
}

function parseApplyPatchUndoEntries(details: unknown): ApplyPatchUndoEntry[] | null {
	const maybe = details as ApplyPatchToolDetails;
	if (!isRecord(maybe)) return null;
	if (!isRecord((maybe as Record<string, unknown>).undo)) return null;
	const undo = (maybe as { undo: unknown }).undo;
	if (!isRecord(undo)) return null;
	const entries = (undo as Record<string, unknown>).entries;
	if (!Array.isArray(entries)) return null;

	const parsed: ApplyPatchUndoEntry[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) return null;
		if (typeof entry.path !== "string") return null;
		if (typeof entry.beforeExists !== "boolean") return null;
		if (typeof entry.afterExists !== "boolean") return null;
		if (entry.beforeExists) {
			const beforeContent = (entry as Record<string, unknown>).beforeContent;
			if (typeof beforeContent !== "string" && beforeContent !== null) return null;
		}
		if (entry.afterExists) {
			const afterHash = (entry as Record<string, unknown>).afterContentHash;
			if (typeof afterHash !== "string") return null;
		}
		parsed.push(entry as ApplyPatchUndoEntry);
	}

	return parsed;
}

export interface UndoFileOperationsResult {
	plannedCount: number;
	revertedCount: number;
	revertedDetails: string[];
	warnings: string[];
}

type UndoOperation =
	| {
			type: "edit";
			toolCallId: string;
			path?: string;
			index?: number;
			oldText?: string;
			newText?: string;
			newContentHash?: string;
	  }
	| {
			type: "write";
			toolCallId: string;
			path?: string;
			created?: boolean;
			previousContent?: string | null;
			newContentHash?: string;
	  }
	| {
			type: "applyPatch";
			toolCallId: string;
			undoEntries?: ApplyPatchUndoEntry[];
	  };

export async function undoFileOperations(params: {
	cwd: string;
	sessionManager: SessionManager;
	messagesToUndo: Message[];
}): Promise<UndoFileOperationsResult> {
	const { cwd, sessionManager, messagesToUndo } = params;

	const toolCallNames = new Map<string, string>();
	for (const msg of messagesToUndo) {
		if (msg.role !== "assistant") continue;
		const assistantMsg = msg as AssistantMessage;
		for (const content of assistantMsg.content) {
			if (content.type === "toolCall") {
				toolCallNames.set(content.id, content.name);
			}
		}
	}

	const undoOperations: UndoOperation[] = [];
	for (const msg of messagesToUndo) {
		if (msg.role !== "toolResult") continue;
		const toolResult = msg as ToolResultMessage;
		const toolName = toolCallNames.get(toolResult.toolCallId);
		if (!toolName) continue;

		if (toolName === "Edit") {
			const parsed = parseEditUndoDetails(toolResult.details);
			if (parsed) {
				undoOperations.push({
					type: "edit",
					toolCallId: toolResult.toolCallId,
					...parsed,
				});
			}
			continue;
		}

		if (toolName === "Write") {
			const parsed = parseWriteUndoDetails(toolResult.details);
			if (parsed) {
				undoOperations.push({
					type: "write",
					toolCallId: toolResult.toolCallId,
					...parsed,
				});
			}
			continue;
		}

		if (toolName === "ApplyPatch" || toolName === "apply_patch") {
			const inMemoryEntries = parseApplyPatchUndoEntries(toolResult.details);
			undoOperations.push({
				type: "applyPatch",
				toolCallId: toolResult.toolCallId,
				undoEntries: inMemoryEntries ?? undefined,
			});
		}
	}

	let revertedCount = 0;
	const warnings: string[] = [];
	const revertedDetails: string[] = [];

	for (let i = undoOperations.length - 1; i >= 0; i--) {
		const op = undoOperations[i];

		if (op.type === "edit") {
			let { path, oldText, newText, newContentHash } = op;
			const relPath = path ? relative(cwd, path) : "<unknown>";

			if (!path || oldText === undefined || newText === undefined || newContentHash === undefined) {
				const stored = readToolResultDetails(sessionManager, op.toolCallId);
				const storedParsed = parseEditUndoDetails(stored);
				path = storedParsed?.path;
				oldText = storedParsed?.oldText;
				newText = storedParsed?.newText;
				newContentHash = storedParsed?.newContentHash;
			}

			if (!path || oldText === undefined || newText === undefined || newContentHash === undefined) {
				warnings.push(`${relPath}: undo data not available`);
				continue;
			}

			const currentContent = await readFile(path, "utf8");
			if (hashContent(currentContent) !== newContentHash) {
				warnings.push(`${relative(cwd, path)}: content has changed, cannot safely undo`);
				continue;
			}

			let revertIndex: number;
			if (op.index !== undefined) {
				const atIndex = currentContent.substring(op.index, op.index + newText.length);
				revertIndex = atIndex === newText ? op.index : currentContent.indexOf(newText);
			} else {
				revertIndex = currentContent.indexOf(newText);
			}

			if (revertIndex === -1) {
				warnings.push(`${relative(cwd, path)}: content has changed, cannot revert edit`);
				continue;
			}

			const revertedContent =
				currentContent.substring(0, revertIndex) + oldText + currentContent.substring(revertIndex + newText.length);
			await writeFile(path, revertedContent, "utf8");
			revertedCount++;

			const linesRemoved = (newText.match(/\n/g) || []).length + 1;
			const linesAdded = (oldText.match(/\n/g) || []).length + 1;
			revertedDetails.push(`${relative(cwd, path)} (-${linesRemoved}/+${linesAdded})`);
			continue;
		}

		if (op.type === "write") {
			let { path, created, previousContent, newContentHash } = op;
			const relPath = path ? relative(cwd, path) : "<unknown>";

			if (!path || created === undefined || newContentHash === undefined) {
				const stored = readToolResultDetails(sessionManager, op.toolCallId);
				const storedParsed = parseWriteUndoDetails(stored);
				path = storedParsed?.path;
				created = storedParsed?.created;
				previousContent = storedParsed?.previousContent;
				newContentHash = storedParsed?.newContentHash;
			}

			if (!path || created === undefined || newContentHash === undefined) {
				warnings.push(`${relPath}: undo data not available`);
				continue;
			}

			let currentContent: string;
			try {
				currentContent = await readFile(path, "utf8");
			} catch (error) {
				const nodeError = error as NodeJS.ErrnoException;
				if (nodeError.code === "ENOENT") {
					warnings.push(`${relative(cwd, path)}: file missing, cannot safely undo`);
					continue;
				}
				throw error;
			}

			if (hashContent(currentContent) !== newContentHash) {
				warnings.push(`${relative(cwd, path)}: content has changed, cannot safely undo`);
				continue;
			}

			if (created) {
				await unlink(path);
				revertedCount++;
				revertedDetails.push(`${relative(cwd, path)} (deleted)`);
				continue;
			}

			if (previousContent !== null && previousContent !== undefined) {
				await writeFile(path, previousContent, "utf8");
				revertedCount++;
				revertedDetails.push(`${relative(cwd, path)} (restored)`);
				continue;
			}

			warnings.push(`${relative(cwd, path)}: cannot undo overwrite (original content not captured)`);
			continue;
		}

		// applyPatch
		let undoEntries = op.undoEntries;
		if (!undoEntries) {
			const stored = readToolResultDetails(sessionManager, op.toolCallId);
			undoEntries = parseApplyPatchUndoEntries(stored) ?? undefined;
		}

		if (!undoEntries) {
			warnings.push(`apply_patch: undo data not available`);
			continue;
		}

		for (let j = undoEntries.length - 1; j >= 0; j--) {
			const entry = undoEntries[j];
			const relPath = relative(cwd, entry.path);

			if (entry.afterExists) {
				let currentContent: string;
				try {
					currentContent = await readFile(entry.path, "utf8");
				} catch (error) {
					const nodeError = error as NodeJS.ErrnoException;
					if (nodeError.code === "ENOENT") {
						warnings.push(`${relPath}: file missing, cannot safely undo`);
						continue;
					}
					throw error;
				}

				if (hashContent(currentContent) !== entry.afterContentHash) {
					warnings.push(`${relPath}: content has changed, cannot safely undo`);
					continue;
				}

				if (!entry.beforeExists) {
					await unlink(entry.path);
					revertedCount++;
					revertedDetails.push(`${relPath} (deleted)`);
					continue;
				}

				if (entry.beforeContent !== null) {
					await writeFile(entry.path, entry.beforeContent, "utf8");
					revertedCount++;
					revertedDetails.push(`${relPath} (restored)`);
					continue;
				}

				warnings.push(`${relPath}: cannot undo overwrite (original content not captured)`);
				continue;
			}

			// afterExists === false
			try {
				await readFile(entry.path, "utf8");
				warnings.push(`${relPath}: file exists, cannot safely undo`);
				continue;
			} catch (error) {
				const nodeError = error as NodeJS.ErrnoException;
				if (nodeError.code !== "ENOENT") {
					throw error;
				}
			}

			if (entry.beforeExists && entry.beforeContent !== null) {
				await writeFile(entry.path, entry.beforeContent, "utf8");
				revertedCount++;
				revertedDetails.push(`${relPath} (restored)`);
				continue;
			}
			if (entry.beforeExists) {
				warnings.push(`${relPath}: cannot restore deleted file (original content not captured)`);
			}
		}
	}

	return { plannedCount: undoOperations.length, revertedCount, revertedDetails, warnings };
}
