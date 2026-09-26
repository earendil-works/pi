import type { Draft } from "@earendil-works/chord";
import {
	type ConversationId,
	createSession,
	defineDoc,
	defineDocFamily,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type Session,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { describe, expect, expectTypeOf, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { context } from "./session-support.ts";

type State = { value: number };
const initial = (): State => ({ value: 0 });

const SessionDoc = defineDoc<State>({ kind: "t.session", version: 1, scope: "session", initial });
const LatestDoc = defineDoc<State>({
	kind: "t.latest",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial,
});
const RewindableDoc = defineDoc<State>({
	kind: "t.rewindable",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial,
});
const TaskDoc = defineDoc<State>({ kind: "t.task", version: 1, scope: "task", initial });
const SessionFamily = defineDocFamily<State, number>({
	kind: "t.session-family",
	version: 1,
	family: true,
	scope: "session",
	initial: (seed) => ({ value: seed }),
});
const ConversationFamily = defineDocFamily<State, number>({
	kind: "t.conversation-family",
	version: 1,
	family: true,
	scope: "conversation",
	history: "rewindable",
	fork: "initial",
	initial: (seed) => ({ value: seed }),
});
const TaskFamily = defineDocFamily<State, number>({
	kind: "t.task-family",
	version: 1,
	family: true,
	scope: "task",
	initial: (seed) => ({ value: seed }),
});

describe("document definitions", () => {
	it("validates persisted version semantics", () => {
		expect(() => defineDoc<State>({ kind: "k", version: 0, scope: "session", initial })).toThrow("positive integer");
		expect(() => defineDoc<State>({ kind: "k", version: 1.5, scope: "session", initial })).toThrow(
			"positive integer",
		);
		expect(defineDoc<State>({ kind: "", version: 1, scope: "session", initial }).definition.kind).toBe("");
		expect(SessionDoc.definition.kind).toBe("t.session");
	});

	it("types every owner, key, and seed overload", async () => {
		const session: Session = createSession(new MemoryStorage());
		const check = async (tx: Tx, conversationId: ConversationId, taskId: TaskId): Promise<void> => {
			expectTypeOf(await tx.doc(SessionDoc)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(LatestDoc, conversationId)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(RewindableDoc, conversationId)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(TaskDoc, taskId)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(SessionFamily, "k", 1)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(ConversationFamily, conversationId, "k", 1)).toEqualTypeOf<Draft<State>>();
			expectTypeOf(await tx.doc(TaskFamily, taskId, "k", 1)).toEqualTypeOf<Draft<State>>();
			await tx.retireDoc(SessionDoc);
			await tx.retireDoc(LatestDoc, conversationId);
			await tx.retireDoc(TaskDoc, taskId);
			await tx.retireDoc(SessionFamily, "k");
			await tx.retireDoc(ConversationFamily, conversationId, "k");
			await tx.retireDoc(TaskFamily, taskId, "k");

			// @ts-expect-error Session documents take no owner
			await tx.doc(SessionDoc, conversationId);
			// @ts-expect-error conversation documents require a conversation ID
			await tx.doc(LatestDoc);
			// @ts-expect-error family access requires a creation seed
			await tx.doc(SessionFamily, "k");
			// @ts-expect-error family seeds are typed
			await tx.doc(SessionFamily, "k", "seed");
			// @ts-expect-error family retirement takes no seed
			await tx.retireDoc(TaskFamily, taskId, "k", 1);
		};
		expect(check).toBeTypeOf("function");

		expectTypeOf(await session.snapshot(SessionDoc, context)).toEqualTypeOf<Readonly<State> | undefined>();
		const taskId = idFromNumber<TaskId>(1);
		expectTypeOf(await session.snapshot(LatestDoc, ROOT_CONVERSATION_ID, context)).toEqualTypeOf<
			Readonly<State> | undefined
		>();
		expectTypeOf(await session.snapshot(TaskDoc, taskId, context)).toEqualTypeOf<Readonly<State> | undefined>();
		expectTypeOf(await session.snapshot(SessionFamily, "k", context)).toEqualTypeOf<Readonly<State> | undefined>();
		expectTypeOf(await session.snapshot(ConversationFamily, ROOT_CONVERSATION_ID, "k", context)).toEqualTypeOf<
			Readonly<State> | undefined
		>();
		expectTypeOf(await session.snapshot(TaskFamily, taskId, "k", context)).toEqualTypeOf<
			Readonly<State> | undefined
		>();
		// @ts-expect-error snapshots never take a creation seed
		await session.snapshot(SessionFamily, "k", 1, context).catch(() => undefined);
		await session.close(context);
	});
});
