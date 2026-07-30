import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "@earendil-works/pi-storage-sqlite-node";
import {
	CURRENT_SESSION_VERSION,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager.ts";
import type { CodingAgentSqliteSessionRepository } from "./sqlite-session-repository.ts";

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
			if (entry.type !== "session") {
				await session.getStorage().appendEntry(entry as SessionTreeEntry);
			}
		}
		return session;
	} catch (error) {
		await session.close();
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
		timestamp: metadata.createdAt,
		cwd: metadata.cwd,
	};
	const lines = [JSON.stringify(header)];
	let parentId: string | null = null;
	for (const entry of await options.session.getBranch()) {
		if (entry.type === "leaf") continue;
		const linear = { ...(entry as SessionEntry), parentId };
		lines.push(JSON.stringify(linear));
		parentId = entry.id;
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${lines.join("\n")}\n`, { flag: "wx" });
	return outputPath;
}
