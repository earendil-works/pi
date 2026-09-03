import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT,
	type Entry,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	laneConfig,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export async function createExperimentalSessions(
	sessionsRoot: string,
	ids: readonly string[],
	cwd = process.cwd(),
): Promise<JsonlSessionMetadata[]> {
	const fileSystem = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	const metadata: JsonlSessionMetadata[] = [];
	try {
		for (const id of ids) {
			const session = await repo.create({ id, cwd }, BACKGROUND_CONTEXT);
			metadata.push(session.metadata);
			await session.close(BACKGROUND_CONTEXT);
		}
		return metadata;
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

export async function configureExperimentalWorkerModel(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
}

export async function readExperimentalSessionState(
	sessionsRoot: string,
	sessionId: string,
): Promise<{
	branch: Entry[];
	model: { provider: string; modelId: string } | undefined;
	activeTools: string[];
}> {
	const fileSystem = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	let session: Awaited<ReturnType<JsonlSessionRepo["open"]>> | undefined;
	try {
		const matches = (await repo.list(undefined, BACKGROUND_CONTEXT)).filter((metadata) => metadata.id === sessionId);
		if (matches.length !== 1) throw new Error(`Expected one Session ${sessionId}, found ${matches.length}`);
		session = await repo.open(matches[0]!, BACKGROUND_CONTEXT);
		const main = await session.branch("main", BACKGROUND_CONTEXT);
		if (main === undefined) throw new Error("Expected Session main Branch");
		const [branch, configuration] = await Promise.all([
			main.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			session.getValue(laneConfig("main"), BACKGROUND_CONTEXT),
		]);
		return { branch, model: configuration?.value.model, activeTools: configuration?.value.activeToolNames ?? [] };
	} finally {
		await session?.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}
