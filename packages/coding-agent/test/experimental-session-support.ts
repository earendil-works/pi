import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, createSession, type ModelRef, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createSession as createCatalogSession,
	readSession,
	type SessionCatalogMetadata,
	sessionStoragePath,
} from "../src/experimental/session-catalog.ts";

export async function createExperimentalSessions(
	sessionsRoot: string,
	ids: readonly string[],
	cwd = process.cwd(),
): Promise<SessionCatalogMetadata[]> {
	const metadata: SessionCatalogMetadata[] = [];
	for (const id of ids) metadata.push(await createCatalogSession(sessionsRoot, { id, cwd }));
	return metadata;
}

export async function configureExperimentalWorkerModel(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
}

/** The root conversation's model, read from the Session's durable storage while no worker owns it. */
export async function readExperimentalSessionState(
	sessionsRoot: string,
	sessionId: string,
): Promise<{ model: ModelRef | undefined }> {
	const metadata = await readSession(sessionsRoot, sessionId);
	if (metadata === undefined) throw new Error(`Expected Session ${sessionId}`);
	const session = createSession(await openNodeSqliteStorage(sessionStoragePath(metadata)));
	try {
		const agent = await session.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		return { model: agent?.model };
	} finally {
		await session.close(BACKGROUND_CONTEXT);
	}
}
