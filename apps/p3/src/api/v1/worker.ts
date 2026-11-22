// p3's API v1 for worker facets (`@earendil-works/p3/v1/worker`): the worker's process values (`WorkerRuntime`) and
// what keeps it alive (`WorkerBusy`), both served by the base; the built-in plugins' worker contracts p3 promises; and
// the parts of Durable and pi-ai worker plugins build on (one instance per worker, the versions p3 ships: a plugin
// inlines neither). `Harness`, `StoreStorage`, `createRegistry` and `createModels` are for p3's own harness plugin and
// outside v1's promise: a plugin gives the agent tools only through a thing (`ThingExtensions`).

import { type ChordStore, defineRegistry, type Host } from "@earendil-works/chord";
import type { P3Principal } from "../../app.ts";

export {
	createModels,
	createProvider,
	// pi-ai's faux provider, for plugins' tests: a model login that answers what the test scripts.
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
// Until real provider logins (ERNDL-705): a deployment's own login plugin builds on it. Outside v1's promise.
export { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
export {
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	Harness,
	hook,
	LiveDoc,
	type LiveState,
	type Registry,
	ROOT_CONVERSATION_ID,
	section,
	type TaskGraph,
} from "@earendil-works/pi-durable";
export type { ExecutionEnv } from "@earendil-works/pi-durable/env";
export { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
export { StoreStorage } from "@earendil-works/pi-durable/storage/store";
export { createCodingTools } from "@earendil-works/pi-durable/tools";
export * from "../../../plugins/environments/contract.worker.ts";
export * from "../../../plugins/harness/contract.worker.ts";

/** A session worker's process values, for plugins: what only the base has. */
export type WorkerRuntime = {
	/** The session's id. */
	readonly session: string;
	readonly host: Host<P3Principal>;
	readonly store: ChordStore;
	/** The worker's private directory (its store lives in it). */
	readonly dir: string;
	/** How long the worker may idle before it stops itself (the runner's choice, from its start). */
	readonly idleMs: number;
	/**
	 * Stops the worker: it tells the server it leaves, closes its host, then its store (which settles the queued
	 * commits), and exits (a clean exit once both closed).
	 */
	close(): void;
};

/** The worker's process values (`WorkerRuntime`), served by the base. */
export const WorkerRuntime = defineRegistry<never, WorkerRuntime>("p3.worker-runtime", { version: 1 });

/**
 * Work that keeps the worker alive besides holds, calls and jobs: each plugin contributes a count, fixed or a
 * watchable (the harness: 1 while a run is active). The runner's worker facet stops the worker once every count and
 * its host's activity stayed 0 for its idle time. The composed value is the sum.
 */
export const WorkerBusy = defineRegistry<number, number>("p3.worker-busy", { version: 1 });
