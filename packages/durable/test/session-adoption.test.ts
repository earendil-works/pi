import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type CommitPublication,
	type CommitResult,
	defineDoc,
	MemoryStorage,
	type Seq,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileError, Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { type ObservedCommit, SessionImpl } from "../src/session/session.ts";
import { Transaction } from "../src/session/transaction.ts";
import { JsonlStorage } from "../src/storage/jsonl/index.ts";
import { ControlledStorage, context, createConversation, documentValues } from "./session-support.ts";

const CounterDoc = defineDoc<{ count: number }>({
	checkpointWhen: () => false,
	kind: "adoption.counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});

/** A latest, initial-fork conversation document, the kind a deferred commit may hold. */
const NoteDoc = defineDoc<{ a?: number; b?: number }>({
	checkpointWhen: () => false,
	kind: "adoption.note",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** Controlled storage that records `adopt` and its own resolution in `order`; its next commit misbehaves as `fault` says. */
class FaultyStorage extends ControlledStorage {
	fault: "reject_after_adopt" | "skip_adopt" | undefined;
	readonly order: string[] = [];

	override async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		callContext: Context,
	): Promise<CommitResult> {
		const fault = this.fault;
		this.fault = undefined;
		if (fault === "skip_adopt") return super.commit(batches, () => {}, callContext);
		const result = await super.commit(
			batches,
			(index, committed) => {
				this.order.push("adopt");
				receive(index, committed);
				this.order.push("adopted");
			},
			callContext,
		);
		this.order.push("resolve");
		if (fault === "reject_after_adopt") throw new Error("reclaim failed");
		return result;
	}
}

function open() {
	const storage = new FaultyStorage();
	const session = new SessionImpl(storage);
	return { storage, session };
}

const bump = (session: SessionImpl) =>
	session.commit(async (tx) => {
		(await tx.doc(CounterDoc)).count++;
	}, context);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Session adoption after Storage stored a commit", () => {
	it("takes the durability receipt inside the commit, and adopts once Storage resolved", async () => {
		const { storage, session } = open();
		const adopt = vi.spyOn(Transaction.prototype, "adopt");
		await bump(session);
		expect(storage.order).toEqual(["adopt", "adopted", "resolve"]);
		expect(adopt).toHaveBeenCalledTimes(1);
		expect(await session.snapshot(CounterDoc, context)).toEqual({ count: 1 });
		await session.close(context);
	});

	it("fails the Session without discarding when Storage rejects after adoption", async () => {
		const { storage, session } = open();
		await bump(session);
		const discard = vi.spyOn(Transaction.prototype, "discard");
		storage.fault = "reject_after_adopt";
		await expect(bump(session)).rejects.toThrow("reclaim failed");
		expect(discard).not.toHaveBeenCalled();
		expect(await session.closed).toMatchObject({ kind: "failed", error: new Error("reclaim failed") });
	});

	it("discards the staged changes when Storage rejects before adoption", async () => {
		const storage = new MemoryStorage();
		const session = new SessionImpl(storage);
		await bump(session);
		const discard = vi.spyOn(Transaction.prototype, "discard");
		vi.spyOn(storage, "commit").mockRejectedValueOnce(new Error("disk full"));
		await expect(bump(session)).rejects.toThrow("disk full");
		expect(discard).toHaveBeenCalledTimes(1);
		expect(await session.closed).toMatchObject({ kind: "failed" });
	});

	it("fails the Session with its own adoption error, which never reaches Storage", async () => {
		const { storage, session } = open();
		await bump(session);
		const failure = new Error("adoption failed");
		vi.spyOn(Transaction.prototype, "adopt").mockImplementationOnce(() => {
			throw failure;
		});
		await expect(bump(session)).rejects.toBe(failure);
		// Storage saw a normal adoption and resolved.
		expect(storage.order.slice(-3)).toEqual(["adopt", "adopted", "resolve"]);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
	});

	it("fails the Session when Storage resolves without adopting", async () => {
		const { storage, session } = open();
		storage.fault = "skip_adopt";
		await expect(bump(session)).rejects.toThrow("without adopting");
		expect(await session.closed).toMatchObject({ kind: "failed" });
	});
});

describe("publication after storage", () => {
	it("runs its own observers once Storage resolved, and host listeners one microtask later", async () => {
		const { storage, session } = open();
		session.followCommits(() => {
			storage.order.push(`observed adopting=${storage.adopting}`);
		});
		session.observeCommits({
			advance: () => {
				storage.order.push(`host adopting=${storage.adopting}`);
			},
			end: () => {},
		});
		await bump(session);
		expect(storage.order).toEqual(["adopt", "adopted", "resolve", "observed adopting=false", "host adopting=false"]);
		await session.close(context);
	});

	it("calls the host listeners registered when its dispatch runs, and none for a commit published without one", async () => {
		const { session } = open();
		const calls: string[] = [];
		const removed = session.observeCommits({
			advance: () => {
				calls.push("removed");
			},
			end: () => {},
		});
		session.observeCommits({
			advance: () => {
				calls.push("kept");
			},
			end: () => {},
		});
		// During the publication, after the dispatch was queued.
		let changed = false;
		session.followCommits(() => {
			if (changed) return;
			changed = true;
			removed.detach();
			session.observeCommits({
				advance: () => {
					calls.push("added");
				},
				end: () => {},
			});
		});
		await bump(session);
		expect(calls).toEqual(["kept", "added"]);
		// A Session with no host listener at the publication queues no dispatch, so one added during it misses it.
		const bare = open();
		const late: Seq[] = [];
		let added = false;
		bare.session.followCommits(() => {
			if (added) return;
			added = true;
			bare.session.observeCommits({
				advance: (publication) => {
					late.push(publication.seq);
				},
				end: () => {},
			});
		});
		await bump(bare.session);
		expect(late).toEqual([]);
		await bump(bare.session);
		expect(late).toHaveLength(1);
		await session.close(context);
		await bare.session.close(context);
	});

	it("fails the Session after Storage returned for a throw of its own observers; the others and hosts got the commit", async () => {
		const { storage, session } = open();
		const bug = new Error("observer bug");
		session.followCommits(() => {
			storage.order.push("observed");
			throw bug;
		});
		session.followCommits(() => {
			storage.order.push("observed after");
		});
		session.observeCommits({
			advance: () => {
				storage.order.push(`host failed=${session.failure !== undefined}`);
			},
			end: () => {},
		});
		session.subscribeClose(() => {
			storage.order.push("close");
		});
		await expect(bump(session)).resolves.toBeUndefined();
		// Published once Storage resolved; the Session failed only after the hosts got the commit.
		expect(storage.order).toEqual([
			"adopt",
			"adopted",
			"resolve",
			"observed",
			"observed after",
			"host failed=false",
			"close",
		]);
		expect(await session.closed).toEqual({ kind: "failed", error: bug });
		const reopened = new SessionImpl(storage.reopen());
		expect(await reopened.snapshot(CounterDoc, context)).toEqual({ count: 1 });
		await reopened.close(context);
	});

	it("publishes a commit that Storage rejects after adopting it, then fails the Session", async () => {
		const { storage, session } = open();
		await bump(session);
		const stored: Seq[] = [];
		session.followCommits(() => {
			storage.order.push("observed");
		});
		session.observeCommits({
			advance: (publication) => {
				storage.order.push("host");
				stored.push(publication.seq);
			},
			end: () => {},
		});
		storage.order.length = 0;
		storage.fault = "reject_after_adopt";
		await expect(bump(session)).rejects.toThrow("reclaim failed");
		expect(storage.order).toEqual(["adopt", "adopted", "resolve", "observed", "host"]);
		expect(stored).toHaveLength(1);
		expect(await session.closed).toMatchObject({ kind: "failed" });
		const reopened = new SessionImpl(storage.reopen());
		expect(await reopened.snapshot(CounterDoc, context)).toEqual({ count: 2 });
		await reopened.close(context);
	});

	it("keeps what host listeners get: exactly what was stored, held changes included", async () => {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			await tx.doc(NoteDoc, conversationId);
		}, context);
		const observed: ObservedCommit[] = [];
		const stored: CommitPublication[] = [];
		session.followCommits((publication) => {
			storage.order.push("observed");
			observed.push(publication);
		});
		session.observeCommits({
			advance: (publication) => {
				storage.order.push("host");
				stored.push(publication);
			},
			end: () => {},
		});
		storage.order.length = 0;
		await session.commit(
			async (tx) => {
				(await tx.doc(NoteDoc, conversationId)).a = 1;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		// Held in memory: observed at once, nothing stored.
		expect(storage.order).toEqual(["observed"]);
		await session.commit(async (tx) => {
			(await tx.doc(NoteDoc, conversationId)).b = 2;
		}, context);
		expect(storage.order).toEqual(["observed", "adopt", "adopted", "resolve", "observed", "host"]);
		expect(documentValues(observed[1]!).map((change) => change.ops)).toEqual([[["s", ["b"], 2]]]);
		expect(stored).toHaveLength(1);
		expect(documentValues(stored[0]!).map((change) => change.ops)).toEqual([
			[
				["s", ["a"], 1],
				["s", ["b"], 2],
			],
		]);
		expect(stored[0]!.seq).toBe((observed[1] as Extract<ObservedCommit, { kind: "stored" }>).seq);
		await session.close(context);
	});

	it("publishes a store of held changes to host listeners once Storage resolved", async () => {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			await tx.doc(NoteDoc, conversationId);
		}, context);
		session.observeCommits({
			advance: () => {
				storage.order.push(`host adopting=${storage.adopting}`);
			},
			end: () => {},
		});
		await session.commit(
			async (tx) => {
				(await tx.doc(NoteDoc, conversationId)).a = 1;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		storage.order.length = 0;
		await session.unloadDocuments();
		expect(storage.order).toEqual(["adopt", "adopted", "resolve", "host adopting=false"]);
		await session.close(context);
	});

	it("publishes a JSONL commit once the storage reclaimed its sidecar and resolved", async () => {
		/** Node environment that records each sidecar rename, the last step of a reclaim. */
		class RenameLog extends NodeExecutionEnv {
			readonly order: string[] = [];

			override renameFile(
				source: string,
				destination: string,
				renameContext: Context,
			): Promise<Result<void, FileError>> {
				this.order.push(`rename ${basename(destination)}`);
				return super.renameFile(source, destination, renameContext);
			}
		}
		// A base at the second count makes JSONL rewrite the document's sidecar after adopting the commit.
		const Rebased = defineDoc<{ count: number }>({
			checkpointWhen: (value) => value.count === 2,
			kind: "adoption.rebased",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
		});
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-adoption-"));
		const env = new RenameLog({ cwd: directory });
		const session = new SessionImpl(await JsonlStorage.open(directory, env, context));
		const count = () =>
			session.commit(async (tx) => {
				(await tx.doc(Rebased)).count++;
			}, context);
		try {
			await count();
			session.observeCommits({
				advance: () => {
					env.order.push("host");
				},
				end: () => {},
			});
			await count();
			env.order.push("resolved");
			expect(env.order).toEqual([expect.stringMatching(/^rename doc-\d+\.jsonl$/), "host", "resolved"]);
		} finally {
			await session.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("publishes a store of held changes that Storage rejects after adopting it, then fails the Session", async () => {
		const { storage, session } = open();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			await tx.doc(NoteDoc, conversationId);
		}, context);
		const stored: (readonly unknown[])[] = [];
		session.observeCommits({
			advance: (publication) => {
				stored.push(documentValues(publication).map((change) => change.ops));
			},
			end: () => {},
		});
		await session.commit(
			async (tx) => {
				(await tx.doc(NoteDoc, conversationId)).a = 1;
			},
			context,
			{ persistence: { kind: "deferred", withinMs: Infinity } },
		);
		storage.order.length = 0;
		storage.fault = "reject_after_adopt";
		await expect(session.unloadDocuments()).rejects.toThrow("reclaim failed");
		expect(storage.order).toEqual(["adopt", "adopted", "resolve"]);
		expect(stored).toEqual([[[["s", ["a"], 1]]]]);
		expect(await session.closed).toMatchObject({ kind: "failed", error: new Error("reclaim failed") });
	});
});
