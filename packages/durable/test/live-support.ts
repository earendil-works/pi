// What tests of renderers' state read: every `pi.live` value of a conversation, and the results of nested calls.
import {
	type ConversationId,
	type ConversationView,
	type Harness,
	type LiveState,
	NestedCallDoc,
	type NestedCallState,
	type NestedToolExecutionResult,
	type NestedToolSlot,
	type TaskGraph,
	type TaskGraphNode,
	type TaskId,
	type ToolSlot,
} from "@earendil-works/pi-durable";
import { context, documentChanges, followCommits } from "./session-support.ts";

/**
 * Every view of `conversationId` from now on, one per commit that changes it, unfolded: a synchronous observer, so no
 * transition is skipped. `live()` lists their `pi.live` values.
 */
export async function viewHistory(harness: Harness, conversationId: ConversationId) {
	const views: ConversationView[] = [];
	const observation = await harness.observeConversation(
		conversationId,
		{ advance: (call) => call.kind === "value" && views.push(call.value), end: () => {} },
		context,
	);
	views.push(observation.value);
	return {
		views,
		live: (): LiveState[] => views.map((view) => (view.docs["pi.live"] ?? {}) as LiveState),
		detach: () => observation.detach(),
	};
}

/** A model-issued or nested slot, read through the fields of both. */
type Slot = ToolSlot & Partial<Pick<NestedToolSlot, "parentCallId" | "parentTaskId" | "arguments" | "summary">>;

/** The slots of tool call `callId`, model-issued or nested, in each `pi.live` value; `undefined` where it is absent. */
export function slotsOf(history: readonly LiveState[], callId: string): (Slot | undefined)[] {
	return history.map(
		(live) => [...(live.tools ?? []), ...(live.nestedTools ?? [])].find((slot) => slot.callId === callId) as Slot,
	);
}

/** The index of the first value where call `callId` ended: its slot is done, or gone after it was listed. */
export function endedAt(history: readonly LiveState[], callId: string): number {
	const slots = slotsOf(history, callId);
	const listed = slots.findIndex((slot) => slot !== undefined);
	if (listed < 0) return -1;
	return slots.findIndex((slot, index) => index >= listed && (slot === undefined || slot.status === "done"));
}

/** The calls whose slot went `running`, in the order they started. */
export function startOrder(history: readonly LiveState[]): string[] {
	const started: string[] = [];
	for (const live of history) {
		for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
			if (slot.status === "running" && !started.includes(slot.callId)) started.push(slot.callId);
		}
	}
	return started;
}

/**
 * The result of every nested call from now on, by its tool task, read from the `NestedCallDoc` its terminal commit
 * writes (spec §7.3), the place a client reads a live caller's nested results from.
 */
export function nestedResults(harness: Harness): Map<TaskId, NestedToolExecutionResult> {
	const results = new Map<TaskId, NestedToolExecutionResult>();
	followCommits(harness, (publication) => {
		for (const change of documentChanges(publication)) {
			if (change.record.kind !== NestedCallDoc.definition.kind || change.kind === "retire") continue;
			const state = change.value as NestedCallState;
			if (state.taskId !== undefined && state.result !== undefined) {
				results.set(state.taskId, state.result as unknown as NestedToolExecutionResult);
			}
		}
	});
	return results;
}

/** The result of nested call `callId`, found by the task its slot names. */
export function nestedResultOf(
	history: readonly LiveState[],
	results: ReadonlyMap<TaskId, NestedToolExecutionResult>,
	callId: string,
): NestedToolExecutionResult | undefined {
	const slot = slotsOf(history, callId).find((each) => each?.taskId !== undefined);
	return slot?.taskId === undefined ? undefined : results.get(slot.taskId);
}

/** Every task graph from now on, one per change, unfolded. */
export async function graphHistory(harness: Harness) {
	const graphs: TaskGraph[] = [];
	const observation = await harness.observeTaskGraph(
		{ advance: (call) => call.kind === "value" && graphs.push(call.value), end: () => {} },
		context,
	);
	graphs.push(observation.value);
	return { graphs, detach: () => observation.detach() };
}

/** The live `pi.generation` nodes of `graph`, in task ID order. */
export function generations(graph: TaskGraph): TaskGraphNode[] {
	return Object.values(graph.tasks)
		.filter((node) => node.kind === "pi.generation")
		.sort((a, b) => a.id - b.id);
}
