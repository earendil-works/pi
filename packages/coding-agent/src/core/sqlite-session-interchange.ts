import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Session } from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "@earendil-works/pi-session-backend-sqlite-node";
import { BackendSessionManager } from "./backend-session-manager.ts";
import {
	CURRENT_SESSION_VERSION,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager.ts";
import type { CodingAgentSqliteSessionRepository } from "./sqlite-session-repository.ts";

const CUSTOM_MESSAGE_TYPE = "coding-agent:custom-message";
const COMPACTION_DETAILS_KEY = "__codingAgentCompaction";

async function appendImportedEntry(session: Session<SqliteSessionMetadata>, entry: SessionEntry): Promise<void> {
	if (entry.parentId !== (await session.getLeafId())) await session.moveLane("main", entry.parentId);
	switch (entry.type) {
		case "label":
			await session.setLabel(entry.targetId, entry.label);
			return;
		case "session_info":
			await session.setName(entry.name);
			return;
		case "custom_message":
			await session.appendEntry(
				{
					id: entry.id,
					type: "custom",
					customType: CUSTOM_MESSAGE_TYPE,
					data: {
						customType: entry.customType,
						content: entry.content,
						display: entry.display,
						details: entry.details,
					},
				},
				"main",
			);
			return;
		case "compaction":
			await session.appendEntry(
				{
					id: entry.id,
					type: "compaction",
					summary: entry.summary,
					retainedTail: [],
					tokensBefore: entry.tokensBefore,
					details: {
						[COMPACTION_DETAILS_KEY]: {
							firstKeptEntryId: entry.firstKeptEntryId,
							fromHook: entry.fromHook,
						},
						details: entry.details,
					},
					usage: entry.usage,
				},
				"main",
			);
			return;
		case "message":
			await session.appendEntry({ id: entry.id, type: "message", message: entry.message }, "main");
			return;
		case "thinking_level_change":
			await session.appendEntry(
				{ id: entry.id, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel },
				"main",
			);
			return;
		case "model_change":
			await session.appendEntry(
				{ id: entry.id, type: "model_change", provider: entry.provider, modelId: entry.modelId },
				"main",
			);
			return;
		case "branch_summary":
			await session.appendEntry(
				{
					id: entry.id,
					type: "branch_summary",
					fromId: entry.fromId,
					summary: entry.summary,
					details: entry.details,
					usage: entry.usage,
				},
				"main",
			);
			return;
		case "custom":
			await session.appendEntry(
				{ id: entry.id, type: "custom", customType: entry.customType, data: entry.data },
				"main",
			);
			return;
		default:
			throw new Error(`Unsupported session entry type: ${String((entry as { type?: unknown }).type)}`);
	}
}

export async function importJsonlIntoSqlite(options: {
	repository: CodingAgentSqliteSessionRepository;
	inputPath: string;
	cwdOverride?: string;
	id?: string;
}): Promise<Session<SqliteSessionMetadata>> {
	const inputPath = resolve(options.inputPath);
	const entries = parseSessionEntries(await readFile(inputPath, "utf8"));
	migrateSessionEntries(entries);
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header) throw new Error(`Session file is not a valid pi session: ${inputPath}`);
	const id = options.id ?? header.id;
	const session = await options.repository.create({
		cwd: resolve(options.cwdOverride ?? header.cwd),
		id,
		metadata: { importedFrom: inputPath },
	});
	try {
		for (const entry of entries) {
			if (entry.type !== "session") await appendImportedEntry(session, entry);
		}
		return session;
	} catch (error) {
		await options.repository.release(session);
		try {
			await options.repository.deleteById(id);
		} catch {
			// Preserve the import error; cleanup is best effort.
		}
		throw error;
	}
}

export async function exportSqliteSessionToJsonl(options: {
	session: Session<SqliteSessionMetadata>;
	outputPath: string;
}): Promise<string> {
	const metadata = await options.session.getMetadata();
	const outputPath = resolve(options.outputPath);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: metadata.id,
		timestamp: new Date(metadata.createdAt).toISOString(),
		cwd: metadata.cwd,
	};
	const manager = await BackendSessionManager.hydrate(options.session, "sqlite");
	const lines = [JSON.stringify(header)];
	let parentId: string | null = null;
	for (const entry of manager.getBranch()) {
		const linear = { ...entry, parentId };
		lines.push(JSON.stringify(linear));
		parentId = entry.id;
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${lines.join("\n")}\n`, { flag: "wx" });
	return outputPath;
}
