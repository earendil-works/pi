// Tests for `Session.observeDoc()`, the synchronous observer of one document address that watches are built on.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { WatchChange } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineDoc,
	MemoryStorage,
	type Observation,
	type Observer,
	type ReportInfo,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { SessionImpl } from "../src/session/session.ts";
import { ControlledStorage, context, createConversation, flush } from "./session-support.ts";

type Counter = { count: number };

const SessionCounter = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "observe.session-counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});

/** A latest, initial-fork conversation document, the kind a deferred commit may hold. */
const ConversationCounter = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "observe.conversation-counter",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0 }),
});

/** A Session that keeps its reports, which a plain Session drops. */
class ReportingSession extends SessionImpl {
	readonly reports: { readonly error: unknown; readonly info: ReportInfo }[] = [];

	override report(error: unknown, info: ReportInfo = { type: "listener_error" }): void {
		this.reports.push({ error, info });
	}
}

/** An observer that records each call, and whether it ran inside the storage's `adopt`. */
function recorder(storage: ControlledStorage) {
	const calls: Array<
		| { readonly advance: WatchChange<Readonly<Counter>>; readonly adopting: boolean }
		| { readonly end: { readonly error: unknown } | undefined }
	> = [];
	const observer: Observer<Readonly<Counter>> = {
		advance: (change) => {
			calls.push({ advance: change, adopting: storage.adopting });
		},
		end: (failure) => {
			calls.push({ end: failure });
		},
	};
	return { calls, observer };
}

function open() {
	const storage = new ControlledStorage();
	const session = new ReportingSession(storage);
	return { storage, session };
}

const add = (session: SessionImpl, by = 1) =>
	session.commit(async (tx) => {
		(await tx.doc(SessionCounter)).count += by;
	}, context);

describe("observeDoc", () => {
	it("returns undefined for an absent address and attaches nothing", async () => {
		const { storage, session } = open();
		const { calls, observer } = recorder(storage);
		expect(await session.observeDoc(SessionCounter, observer, context)).toBeUndefined();
		await add(session);
		expect(calls).toEqual([]);
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.close(context);
	});

	it("starts at the committed value and advances inside adopt with each stored commit's ops", async () => {
		const { storage, session } = open();
		await add(session);
		const { calls, observer } = recorder(storage);
		const observation = (await session.observeDoc(SessionCounter, observer, context))!;
		expect(observation.value).toEqual({ count: 1 });
		const committing = add(session, 2);
		await committing;
		expect(calls).toEqual([
			{ advance: { value: { count: 3 }, ops: [["s", ["count"], 3]], retired: false }, adopting: true },
		]);
		observation.detach();
		await session.close(context);
	});

	it("advances when memory adopts a held commit, before anything is stored", async () => {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			await tx.doc(ConversationCounter, conversationId);
		}, context);
		const { calls, observer } = recorder(storage);
		const observation = (await session.observeDoc(ConversationCounter, conversationId, observer, context))!;
		const stored = storage.commits.length;
		await session.commit(
			async (tx) => {
				(await tx.doc(ConversationCounter, conversationId)).count = 5;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Number.POSITIVE_INFINITY } },
		);
		expect(storage.commits).toHaveLength(stored);
		expect(calls).toEqual([
			{ advance: { value: { count: 5 }, ops: [["s", ["count"], 5]], retired: false }, adopting: false },
		]);
		observation.detach();
		await session.close(context);
	});

	it("follows a conversation document's address: a retirement with the last value, then the new incarnation", async () => {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			(await tx.doc(ConversationCounter, conversationId)).count = 2;
		}, context);
		const { calls, observer } = recorder(storage);
		const observation = (await session.observeDoc(ConversationCounter, conversationId, observer, context))!;
		await session.commit((tx) => tx.retireDoc(ConversationCounter, conversationId), context);
		// The address is absent now: a new attachment finds nothing, the existing one goes on.
		expect(await session.observeDoc(ConversationCounter, conversationId, recorder(storage).observer, context)).toBe(
			undefined,
		);
		await session.commit(async (tx) => {
			(await tx.doc(ConversationCounter, conversationId)).count = 9;
		}, context);
		expect(calls).toEqual([
			{ advance: { value: observation.value, ops: [], retired: true }, adopting: true },
			{ advance: { value: { count: 9 }, ops: [["r", { count: 9 }]], retired: false }, adopting: true },
		]);
		expect((calls[0] as { advance: WatchChange<Counter> }).advance.value).toBe(observation.value);
		observation.detach();
		await session.close(context);
	});

	it("gets nothing after detach, which is idempotent and unpins the document", async () => {
		const { storage, session } = open();
		await add(session);
		const { calls, observer } = recorder(storage);
		const observation = (await session.observeDoc(SessionCounter, observer, context))!;
		expect(session.documentCacheSizes.attached).toBe(1);
		observation.detach();
		observation.detach();
		expect(session.documentCacheSizes.attached).toBe(0);
		await add(session);
		await session.close(context);
		expect(calls).toEqual([]);
	});

	it("ends once when the Session closes", async () => {
		const { storage, session } = open();
		await add(session);
		const { calls, observer } = recorder(storage);
		await session.observeDoc(SessionCounter, observer, context);
		await session.close(context);
		expect(calls).toEqual([{ end: undefined }]);
	});

	it("ends with the error that failed the Session", async () => {
		const { storage, session } = open();
		await add(session);
		const { calls, observer } = recorder(storage);
		await session.observeDoc(SessionCounter, observer, context);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(add(session)).rejects.toThrow("disk gone");
		await session.closed;
		expect(calls).toEqual([{ end: { error: failure } }]);
	});

	it("reports a throwing observer, detaches it and ends it with the error; the commit and other observers go on", async () => {
		const { storage, session } = open();
		await add(session);
		const bug = new Error("observer bug");
		const ends: unknown[] = [];
		const throwing: Observer<Readonly<Counter>> = {
			advance: () => {
				throw bug;
			},
			end: (failure) => ends.push(failure),
		};
		await session.observeDoc(SessionCounter, throwing, context);
		const healthy = recorder(storage);
		await session.observeDoc(SessionCounter, healthy.observer, context);
		await add(session);
		await add(session);
		expect(session.reports).toEqual([{ error: bug, info: { type: "listener_error" } }]);
		expect(ends).toEqual([{ error: bug }]);
		expect(healthy.calls).toHaveLength(2);
		expect(await session.snapshot(SessionCounter, context)).toEqual({ count: 3 });
		await session.close(context);
		// Detached at its throw: the close does not end it again.
		expect(ends).toHaveLength(1);
		expect(session.failure).toBeUndefined();
	});

	it("attaches atomically on the line: a commit queued before the attachment is in its value", async () => {
		const { storage, session } = open();
		await add(session);
		const { calls, observer } = recorder(storage);
		const committing = add(session, 10);
		const observation = (await session.observeDoc(SessionCounter, observer, context))!;
		await committing;
		expect(observation.value).toEqual({ count: 11 });
		expect(calls).toEqual([]);
		observation.detach();
		await session.close(context);
	});

	it("rejects an attachment whose context is cancelled, and attaches nothing", async () => {
		const { storage, session } = open();
		await add(session);
		const controller = new AbortController();
		controller.abort(new Error("gone"));
		const cancelled = withAbortSignal(controller.signal, context);
		await expect(session.observeDoc(SessionCounter, recorder(storage).observer, cancelled)).rejects.toThrow("gone");
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.close(context);
	});

	it("keeps no detached observer alive", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		const session = new SessionImpl(new MemoryStorage());
		await add(session);
		/** Attach an observer only the Session references; `detach` says whether to detach it before returning. */
		const attach = async (detach: boolean) => {
			const observer: Observer<Readonly<Counter>> = { advance: () => {}, end: () => {} };
			const observation = (await session.observeDoc(SessionCounter, observer, context))!;
			if (detach) observation.detach();
			return { observation, observer: new WeakRef(observer) };
		};
		// Control: an attached observer stays, so the collection below is real.
		const attached = await attach(false);
		await collect();
		expect(attached.observer.deref()).toBeDefined();
		attached.observation.detach();

		const detached = await attach(true);
		await collect();
		expect(detached.observer.deref()).toBeUndefined();
		await flush();
		await session.close(context);
	});

	it("rejects, never throws, on a closed Session or a missing scope ID", async () => {
		const { storage, session } = open();
		const missing = session.observeDoc(
			ConversationCounter,
			undefined as unknown as ConversationId,
			recorder(storage).observer,
			context,
		);
		await expect(missing).rejects.toThrow(TypeError);
		await session.close(context);
		const closed = session.observeDoc(SessionCounter, recorder(storage).observer, context);
		await expect(closed).rejects.toThrow("Session is closed");
	});
	it("keeps no value of a document retired for good, while still attached", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		const session = new SessionImpl(new MemoryStorage());
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			await tx.doc(ConversationCounter, conversationId);
		}, context);
		/** Attach an observer that keeps nothing, change the document, and retire it: only a WeakRef to its last value. */
		const retire = async () => {
			let last: WeakRef<object> | undefined;
			const observation = (await session.observeDoc(
				ConversationCounter,
				conversationId,
				{
					advance: (change) => {
						if (!change.retired) last = new WeakRef(change.value);
					},
					end: () => {},
				},
				context,
			))!;
			await session.commit(async (tx) => {
				(await tx.doc(ConversationCounter, conversationId)).count = 7;
			}, context);
			await session.commit((tx) => tx.retireDoc(ConversationCounter, conversationId), context);
			await session.unloadDocuments();
			return { observation, last: last! };
		};
		const { observation, last } = await retire();
		await collect();
		expect(last.deref()).toBeUndefined();
		observation.detach();
		await session.close(context);
	});
});

describe("observeDoc detached during a commit", () => {
	/** A Session with a conversation counter at 1, and the commit that retires it and creates it again at 2. */
	async function retiring() {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			(await tx.doc(ConversationCounter, conversationId)).count = 1;
		}, context);
		const recreate = () =>
			session.commit(async (tx) => {
				await tx.retireDoc(ConversationCounter, conversationId);
				(await tx.doc(ConversationCounter, conversationId)).count = 2;
			}, context);
		return { storage, session, conversationId, recreate };
	}

	it("gets nothing more of the commit once it throws on the retirement, and pins nothing for the recreation", async () => {
		const { session, conversationId, recreate } = await retiring();
		const bug = new Error("observer bug");
		const changes: WatchChange<Readonly<Counter>>[] = [];
		const ends: unknown[] = [];
		const observation = (await session.observeDoc(
			ConversationCounter,
			conversationId,
			{
				advance: (change) => {
					changes.push(change);
					throw bug;
				},
				end: (failure) => ends.push(failure),
			},
			context,
		))!;
		await recreate();
		expect(changes).toEqual([{ value: observation.value, ops: [], retired: true }]);
		expect(ends).toEqual([{ error: bug }]);
		expect(session.reports).toEqual([{ error: bug, info: { type: "listener_error" } }]);
		expect(session.documentCacheSizes.attached).toBe(0);
		observation.detach();
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.close(context);
	});

	it("gets nothing more of the commit once it detaches in the retirement call, and pins nothing", async () => {
		const { session, conversationId, recreate } = await retiring();
		const changes: WatchChange<Readonly<Counter>>[] = [];
		const ends: unknown[] = [];
		let observation: Observation<Readonly<Counter>> | undefined;
		observation = await session.observeDoc(
			ConversationCounter,
			conversationId,
			{
				advance: (change) => {
					changes.push(change);
					observation?.detach();
				},
				end: (failure) => ends.push(failure),
			},
			context,
		);
		await recreate();
		expect(changes).toEqual([{ value: observation!.value, ops: [], retired: true }]);
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.close(context);
		expect(ends).toEqual([]);
	});

	it("gets nothing of the commit when another observer's call detached it first, and pins nothing", async () => {
		const { storage, session, conversationId, recreate } = await retiring();
		let second: Observation<Readonly<Counter>> | undefined;
		const first = (await session.observeDoc(
			ConversationCounter,
			conversationId,
			{
				advance: () => second?.detach(),
				end: () => {},
			},
			context,
		))!;
		const detached = recorder(storage);
		second = await session.observeDoc(ConversationCounter, conversationId, detached.observer, context);
		await recreate();
		expect(detached.calls).toEqual([]);
		// Only the first observer pins the new incarnation; its detach leaves nothing pinned.
		first.detach();
		expect(session.documentCacheSizes.attached).toBe(0);
		await session.close(context);
	});
});
