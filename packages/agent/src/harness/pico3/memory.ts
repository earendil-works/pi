import type { Context } from "@earendil-works/chord";
import { applyImmutable, isBase, type Op } from "@earendil-works/chord/delta";
import type {
	Conversation,
	DocRef,
	Entry,
	EntryScan,
	Id,
	Input,
	JsonObject,
	Seq,
	Storage,
	Task,
	TaskScan,
	Write,
} from "./types.ts";

/**
 * In-memory Storage. The reference backend, and the read path of JsonlStorage.
 *
 * A batch is validated and staged in full before any table changes: one failed
 * batch changes no table, no document, no ID high-water, no sequence. Committed
 * IDs are never reused; IDs minted but never committed may be reused after reopen.
 */
export class MemoryStorage implements Storage {
	protected readonly conversationsById = new Map<Id, Conversation>();
	protected readonly entriesById = new Map<Id, Entry>();
	protected readonly entriesByConversation = new Map<Id, Entry[]>(); // ascending
	protected readonly tasksById = new Map<Id, Task>();
	protected readonly inputsById = new Map<Id, Input>();
	protected readonly inputsByRequest = new Map<string, Input>();
	/** Rewindable docs keep their full op history with the seq of each batch, for `docAsOf`. */
	protected readonly rewindableLog = new Map<Id, { seq: Seq; ops: Op[] }[]>();
	protected readonly stickyLog = new Map<Id, Op[][]>();
	protected sessionDoc: JsonObject | undefined;
	protected readonly entrySeq = new Map<Id, Seq>(); // entry id → seq of its batch
	protected nextIdValue = 1;
	protected seq: Seq = 0;
	private closed = false;

	mintId(): Id {
		return this.nextIdValue++;
	}
	protected setNextId(n: Id) {
		this.nextIdValue = Math.max(this.nextIdValue, n);
	}

	async commit(writes: readonly Write[], _ctx: Context): Promise<Seq> {
		if (this.closed) throw new Error("storage closed");
		const seq = this.seq + 1;
		const staged = this.stage(writes, seq); // throws before any mutation
		staged();
		this.seq = seq;
		return seq;
	}

	/** Validate the whole batch against the current tables; return a function that applies it. */
	protected stage(writes: readonly Write[], seq: Seq): () => void {
		const ops: (() => void)[] = [];
		const created = new Set<Id>();
		let maxId = 0;
		const claim = (id: Id, what: string) => {
			if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${what}: invalid id ${id}`);
			if (created.has(id)) throw new Error(`${what}: id ${id} created twice in one batch`);
			created.add(id);
			maxId = Math.max(maxId, id);
		};
		for (const w of writes) {
			switch (w.type) {
				case "conversation": {
					if (this.conversationsById.has(w.conversation.id))
						throw new Error(`conversation ${w.conversation.id} exists`);
					claim(w.conversation.id, "conversation");
					const c = clone(w.conversation);
					ops.push(() => {
						this.conversationsById.set(c.id, c);
						this.entriesByConversation.set(c.id, []);
					});
					break;
				}
				case "entry": {
					if (this.entriesById.has(w.entry.id)) throw new Error(`entry ${w.entry.id} exists`);
					claim(w.entry.id, "entry");
					const e = clone(w.entry);
					ops.push(() => {
						this.entriesById.set(e.id, e);
						(
							this.entriesByConversation.get(e.conversationId) ??
							this.entriesByConversation.set(e.conversationId, []).get(e.conversationId)!
						).push(e);
						this.entrySeq.set(e.id, seq);
					});
					break;
				}
				case "task": {
					if (this.tasksById.has(w.task.id)) throw new Error(`task ${w.task.id} exists`);
					claim(w.task.id, "task");
					const t = clone(w.task);
					ops.push(() => this.tasksById.set(t.id, t));
					break;
				}
				case "task.patch": {
					const prev =
						this.tasksById.get(w.patch.id) ??
						[...writes]
							.filter((x): x is Extract<Write, { type: "task" }> => x.type === "task")
							.find((x) => x.task.id === w.patch.id)?.task;
					if (prev === undefined) throw new Error(`patch for unknown task ${w.patch.id}`);
					const p = clone(w.patch);
					ops.push(() => {
						const cur = this.tasksById.get(p.id)!;
						const { id: _i, ...fields } = p;
						const next = { ...cur, ...fields } as Task;
						if (p.checkpoint === null) delete (next as { checkpoint?: unknown }).checkpoint;
						this.tasksById.set(p.id, next);
					});
					break;
				}
				case "input": {
					const i = clone(w.input);
					if (!this.inputsById.has(i.id)) claim(i.id, "input");
					ops.push(() => {
						this.inputsById.set(i.id, i);
						if (i.requestId !== undefined) this.inputsByRequest.set(`${i.conversationId}:${i.requestId}`, i);
					});
					break;
				}
				case "doc": {
					const ref = clone(w.ref);
					const o = clone(w.ops);
					if (ref.doc === "session")
						ops.push(() => {
							this.sessionDoc = applyImmutable(
								(this.sessionDoc ?? { plugins: {} }) as JsonObject,
								o,
							) as JsonObject;
						});
					else if (ref.doc === "rewindable")
						ops.push(() =>
							(
								this.rewindableLog.get(ref.conversationId) ??
								this.rewindableLog.set(ref.conversationId, []).get(ref.conversationId)!
							).push({ seq, ops: o }),
						);
					else
						ops.push(() =>
							(
								this.stickyLog.get(ref.conversationId) ??
								this.stickyLog.set(ref.conversationId, []).get(ref.conversationId)!
							).push(o),
						);
					break;
				}
			}
		}
		return () => {
			for (const op of ops) op();
			this.setNextId(maxId + 1);
		};
	}

	async conversation(id: Id, _ctx?: Context) {
		return optionalClone(this.conversationsById.get(id));
	}
	async conversations(_ctx?: Context) {
		return [...this.conversationsById.values()].map(clone);
	}
	async entries(ids: readonly Id[], _ctx?: Context) {
		const out = new Map<Id, Entry>();
		for (const id of ids) {
			const e = this.entriesById.get(id);
			if (e) out.set(id, clone(e));
		}
		return out;
	}
	/** Newest-first, fork-aware: after this conversation's own entries, the parent's up to the fork point, and so on. */
	async scanEntries(scan: EntryScan, _ctx?: Context) {
		const out: Entry[] = [];
		let conversationId: Id | undefined = scan.conversationId;
		let cap: Id | undefined = scan.before;
		while (conversationId !== undefined && out.length < scan.limit) {
			const own = this.entriesByConversation.get(conversationId) ?? [];
			for (let i = own.length - 1; i >= 0 && out.length < scan.limit; i--) {
				const e = own[i]!;
				if (cap !== undefined && e.id >= cap) continue;
				if (scan.kind !== undefined && e.kind !== scan.kind) continue;
				if (scan.withHead && e.head === undefined) continue;
				out.push(clone(e));
			}
			const c = this.conversationsById.get(conversationId);
			conversationId = c?.parent?.conversationId;
			cap = c?.parent === undefined ? undefined : Math.min(cap ?? Infinity, c.parent.at + 1);
		}
		return out;
	}
	async task(id: Id, _ctx?: Context) {
		return optionalClone(this.tasksById.get(id));
	}
	async scanTasks(scan: TaskScan, _ctx?: Context) {
		const out: Task[] = [];
		for (const t of this.tasksById.values()) {
			if (scan.conversationId !== undefined && t.conversationId !== scan.conversationId) continue;
			if (scan.status !== undefined && !scan.status.includes(t.status)) continue;
			if (scan.kind !== undefined && t.kind !== scan.kind) continue;
			out.push(clone(t));
		}
		return out;
	}
	async input(id: Id, _ctx?: Context) {
		return optionalClone(this.inputsById.get(id));
	}
	async inputByRequest(conversationId: Id, requestId: string, _ctx?: Context) {
		return optionalClone(this.inputsByRequest.get(`${conversationId}:${requestId}`));
	}

	async doc(ref: DocRef, _ctx?: Context): Promise<JsonObject | undefined> {
		if (ref.doc === "session")
			return this.sessionDoc === undefined ? { plugins: {} } : structuredClone(this.sessionDoc);
		const log =
			ref.doc === "rewindable"
				? this.rewindableLog.get(ref.conversationId)?.map((r) => r.ops)
				: this.stickyLog.get(ref.conversationId);
		if (log === undefined) return undefined;
		return clone(this.fold(log));
	}
	/**
	 * Commit-granular history: the rewindable state after the atomic commit that contains
	 * entry `at`, walking the fork chain for entries owned by ancestors.
	 */
	async docAsOf(conversationId: Id, at: Id, _ctx?: Context): Promise<JsonObject | undefined> {
		const owner = this.entriesById.get(at)?.conversationId;
		if (owner === undefined) return undefined;
		const chain: Id[] = [];
		let c: Conversation | undefined = this.conversationsById.get(conversationId);
		while (c !== undefined && c.id !== owner) {
			chain.push(c.id);
			c = c.parent ? this.conversationsById.get(c.parent.conversationId) : undefined;
		}
		if (c === undefined) return undefined;
		const seqAt = this.entrySeq.get(at) ?? 0;
		const log = (this.rewindableLog.get(owner) ?? []).filter((r) => r.seq <= seqAt).map((r) => r.ops);
		return log.length === 0 ? undefined : clone(this.fold(log));
	}
	protected fold(log: Op[][]): JsonObject {
		let start = 0;
		for (let i = log.length - 1; i >= 0; i--)
			if (isBase(log[i]!)) {
				start = i;
				break;
			}
		let state: JsonObject = {};
		for (let i = start; i < log.length; i++) state = applyImmutable(state, log[i]!) as JsonObject;
		return state;
	}
	async truncate(ref: DocRef, _ctx?: Context) {
		if (ref.doc !== "sticky") return;
		const log = this.stickyLog.get(ref.conversationId);
		if (log === undefined) return;
		let start = 0;
		for (let i = log.length - 1; i >= 0; i--)
			if (isBase(log[i]!)) {
				start = i;
				break;
			}
		log.splice(0, start);
	}
	async close(_ctx?: Context) {
		this.closed = true;
	}
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function optionalClone<T>(value: T | undefined): T | undefined {
	return value === undefined ? undefined : clone(value);
}
