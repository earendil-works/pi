/**
 * Session worker: one process per session.
 *
 * It owns every live object — storage, harness, lane, model runtime — and publishes them only as the
 * `Lane` and `Models` services. It speaks JSON over its stdio pipes to the server that spawned it,
 * and can call server services (`Sessions`) over the same peer.
 */

import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	type Context,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { findInitialModel } from "../../../core/model-resolver.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { Lane, Models, Worker } from "../shared/protocol.ts";
import { createPeer } from "../shared/rpc.ts";
import { parentConnection } from "../shared/transport.ts";
import { LaneService } from "./lane-service.ts";
import { ModelsService } from "./models-service.ts";

function systemPrompt(cwd: string): string {
	return [
		"You are a coding agent working in a terminal.",
		`Working directory: ${cwd}`,
		"Use the read, write, edit, and bash tools to inspect and change files.",
		"Keep answers short and technical.",
	].join("\n");
}

async function openSession(
	repo: JsonlSessionRepo,
	sessionId: string | undefined,
	cwd: string,
	context: Context,
): Promise<Session<JsonlSessionMetadata>> {
	if (sessionId === undefined) return repo.create({ cwd }, context);
	const metadata = (await repo.list(undefined, context)).find((candidate) => candidate.id === sessionId);
	if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
	return repo.open(metadata, context);
}

/** Run one session worker until its stdio closes. `sessionId` undefined creates a new session. */
export async function runSessionWorker(options: {
	sessionsRoot: string;
	sessionId?: string;
	cwd: string;
}): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const { cwd } = options;
	const modelRuntime = await ModelRuntime.create();
	const { model, thinkingLevel } = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime });
	if (!model) throw new Error("No model available. Configure credentials with `pi` first.");

	const executionEnv = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: options.sessionsRoot });
	const session = await openSession(repo, options.sessionId, cwd, context);
	const { harness, open } = await AgentHarness.create(
		{
			session,
			models: modelRuntime,
			model,
			thinkingLevel,
			tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
			toolContext: { env: executionEnv },
			systemPrompt: systemPrompt(cwd),
		},
		context,
	);
	const lane = await harness.lane("main", context);
	const connection = parentConnection();
	const peer = createPeer(connection);

	const models = new ModelsService(modelRuntime, (event) => peer.emit(Models, event));
	const laneService = new LaneService({
		lane,
		models: modelRuntime,
		context,
		session: { id: session.metadata.id, cwd, path: session.metadata.path },
		modelsState: () => models.state,
		publish: (subscriptionId, to, event) => peer.emitTo(Lane, { subscriptionId, event }, to),
	});
	peer.provide(Lane, laneService);
	peer.provide(Models, models);
	peer.provide(Worker, { describe: async () => ({ sessionId: session.metadata.id }) });

	// Creation restores durable operation state without starting effects. Once services are reachable,
	// install a new process-local drive for every operation left open by the previous worker.
	const recoveries = open.map(async (operation) => {
		try {
			const restoredLane = operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
			const result = await restoredLane.resume(context);
			if (!result.ok) throw result.error;
		} catch (error) {
			console.error(`Failed to resume ${operation.lane}/${operation.operationId}:`, error);
		}
	});

	await new Promise<void>((resolve) => connection.onClose(resolve));
	laneService.close();
	await harness.close(context).catch(() => {});
	await Promise.all(recoveries);
	await repo.close(context).catch(() => {});
	await executionEnv.cleanup(context).catch(() => {});
}
