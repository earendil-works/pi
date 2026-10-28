import type { Context } from "@earendil-works/chord";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { defineDoc } from "../documents.ts";
import type { TaskRuntime } from "../types.ts";

/** Stable provider-facing identity of one conversation. */
export type ProviderState = {
	sessionId: string;
};

/** Built-in provider state; every fork starts with a fresh identity instead of copying its parent. */
export const ProviderDoc = defineDoc<ProviderState>({
	kind: "pi.provider",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ sessionId: uuidv7() }),
	checkpointWhen: () => true,
});

/**
 * Return the persisted identity without writing in the normal path. A legacy conversation without `pi.provider` gets
 * one migration commit whose `tx.doc()` runs `initial()` before the provider request starts.
 */
export async function ensureProviderSessionId<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
): Promise<string> {
	const existing = await runtime.snapshot(ProviderDoc, runtime.conversationId, context);
	if (existing !== undefined) return existing.sessionId;
	let created: string | undefined;
	await runtime.commit(async (tx) => {
		created = (await tx.doc(ProviderDoc, runtime.conversationId)).sessionId;
		return undefined;
	}, context);
	if (created === undefined) throw new Error(`Conversation ${runtime.conversationId} has no provider session ID`);
	return created;
}
