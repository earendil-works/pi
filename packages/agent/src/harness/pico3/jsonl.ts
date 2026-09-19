import {
	closeSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isBase, type Op } from "@earendil-works/chord/delta";
import { MemoryStorage } from "./memory.ts";
import type { DocRef, Id, Seq, Storage, Write } from "./types.ts";

/** One line of any file. `refs` (main only) lists the sidecar files this commit also wrote. */
interface Record_ {
	seq: Seq;
	maxId: Id;
	writes: Write[];
	refs?: string[];
}

/**
 * Files in a session directory:
 *   main.jsonl                   conversations, entries, inputs, rewindable/session doc ops, each task's
 *                                CREATE and TERMINAL records, and one marker per commit. Append-only, never rewritten.
 *   sticky-<conversation>.jsonl  sticky doc ops; rewritten from its last base by `truncate` (on the Session line)
 *   task-<id>.jsonl              a live task's intermediate patches (running, checkpoints); unlinked after its
 *                                terminal record is published in main
 *
 * Publication (§10): one commit `Seq`; sidecar records are appended first, then exactly one main
 * record, last, listing the sidecar refs it expects — the publication point. Replay applies a sidecar
 * record only when main has the marker for that seq naming that file; unconfirmed sidecar tails are
 * ignored. Every record carries the committed-ID high-water. Bytes after the last newline of any file
 * are a torn write and are truncated before the file is opened for append. There is no compaction.
 *
 * With `fsync: false`, recovery covers process termination while the OS and filesystem remain alive.
 * It does not promise that an acknowledged commit survives power loss, kernel/host failure,
 * storage-cache loss, or a filesystem that loses/reorders completed writes. An acknowledged tail may
 * roll back, or a surviving main marker may reference a missing sidecar and make open fail rather
 * than expose partial state. A lost pre-effect checkpoint can cause an external effect to be attempted
 * again; external idempotency remains required.
 *
 * With `fsync: true`, each sidecar is flushed before the main publication marker is flushed. This
 * strengthens file-data durability and ordering across machine failure. It is not a complete database
 * guarantee: newly created files, renames, and unlinks are not followed by a parent-directory fsync,
 * and storage hardware/filesystems may provide weaker guarantees.
 *
 * One process owns a directory at a time; a second process is unsupported.
 */
export class JsonlStorage extends MemoryStorage implements Storage {
	private mainFd: number;
	private readonly sidecars = new Map<Id, number>(); // sticky docs, by conversation
	private readonly taskSidecars = new Map<Id, number>();
	private readonly dir: string;
	readonly fsync: boolean;
	private closedOnce = false;

	private constructor(dir: string, fsync: boolean) {
		super();
		this.dir = dir;
		this.fsync = fsync;
		this.mainFd = openSync(join(dir, "main.jsonl"), "a");
	}

	static async open(dir: string, opts: { fsync?: boolean } = {}): Promise<JsonlStorage> {
		mkdirSync(dir, { recursive: true });
		for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) truncateTornTail(join(dir, f));
		const storage = new JsonlStorage(dir, opts.fsync ?? true);
		try {
			await storage.replay();
			return storage;
		} catch (error) {
			await storage.close();
			throw error;
		}
	}

	/** For tests and tooling: sizes of every file in the directory. */
	sizes(): { [file: string]: number } {
		const out: { [file: string]: number } = {};
		for (const f of readdirSync(this.dir)) out[f] = statSync(join(this.dir, f)).size;
		return out;
	}

	private async replay() {
		const read = (file: string): { record: Record_; end: number }[] => {
			if (!existsSync(file)) return [];
			const bytes = readFileSync(file);
			const out: { record: Record_; end: number }[] = [];
			let start = 0;
			let last = 0;
			for (let end = bytes.indexOf(0x0a, start); end >= 0; end = bytes.indexOf(0x0a, start)) {
				const line = bytes.subarray(start, end).toString("utf8");
				start = end + 1;
				if (line === "") continue;
				let record: Record_;
				try {
					record = JSON.parse(line) as Record_;
				} catch (error) {
					throw new Error(`${file}: malformed record: ${String(error)}`);
				}
				if (typeof record.seq !== "number" || typeof record.maxId !== "number" || !Array.isArray(record.writes))
					throw new Error(`${file}: record lacks seq/maxId/writes`);
				if (record.seq <= last) throw new Error(`${file}: sequence not increasing at ${record.seq}`);
				last = record.seq;
				out.push({ record, end: start });
			}
			return out;
		};
		let maxId = 0;
		// Main is the commit log. Confirmed = (seq → refs) for every marker.
		const main = read(join(this.dir, "main.jsonl")).map(({ record }) => record);
		const confirmed = new Map<Seq, Set<string>>();
		for (const record of main) confirmed.set(record.seq, new Set(record.refs ?? []));
		// Merge every file's records by seq so batches apply in commit order.
		const sidecarFiles = readdirSync(this.dir).filter(
			(file) => file.startsWith("sticky-") || file.startsWith("task-"),
		);
		const bySeq = new Map<Seq, Write[]>();
		const found = new Map<Seq, Set<string>>();
		const retainedStickyBase = new Map<string, Seq>();
		const retiredTasks = new Map<Id, Seq>();
		for (const record of main) {
			for (const write of record.writes) {
				if (write.type === "task.patch" && write.patch.status === "terminal")
					retiredTasks.set(write.patch.id, record.seq);
			}
			bySeq.set(record.seq, [...record.writes]);
			maxId = Math.max(maxId, record.maxId);
		}
		for (const file of sidecarFiles) {
			const path = join(this.dir, file);
			const records = read(path);
			const first = records[0]?.record;
			if (
				file.startsWith("sticky-") &&
				first !== undefined &&
				isBase(first.writes.flatMap((write) => (write.type === "doc" ? write.ops : [])))
			) {
				retainedStickyBase.set(file, first.seq);
			}
			let confirmedEnd = 0;
			let sawUnconfirmed = false;
			for (const { record, end } of records) {
				if (!confirmed.get(record.seq)?.has(file)) {
					sawUnconfirmed = true;
					continue;
				}
				if (sawUnconfirmed)
					throw new Error(`${path}: confirmed record follows an unconfirmed tail at ${record.seq}`);
				confirmedEnd = end;
				const files = found.get(record.seq) ?? new Set<string>();
				files.add(file);
				found.set(record.seq, files);
				bySeq.get(record.seq)!.push(...record.writes);
				maxId = Math.max(maxId, record.maxId);
			}
			if (sawUnconfirmed) truncateTo(path, confirmedEnd);
		}
		for (const record of main) {
			for (const file of record.refs ?? []) {
				if (found.get(record.seq)?.has(file)) continue;
				const retainedFrom = retainedStickyBase.get(file);
				if (retainedFrom !== undefined && record.seq < retainedFrom) continue;
				if (file.startsWith("task-")) {
					const id = Number(file.slice(5, -6));
					const retiredAt = retiredTasks.get(id);
					if (retiredAt !== undefined && record.seq < retiredAt) continue;
				}
				throw new Error(`${join(this.dir, file)}: missing record for published sequence ${record.seq}`);
			}
		}
		for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
			this.seq = seq - 1;
			await super.commit(bySeq.get(seq)!, BACKGROUND_CONTEXT);
		}
		this.setNextId(maxId + 1);
		// Task sidecars belong to live tasks only; a leftover for a terminal (or unknown) task cannot resurrect anything.
		for (const f of sidecarFiles) {
			if (!f.startsWith("task-")) continue;
			const id = Number(f.slice(5, -6));
			const t = await super.task(id);
			if (t === undefined || t.status === "terminal") unlinkSync(join(this.dir, f));
		}
	}

	override async commit(writes: readonly Write[], ctx: Context): Promise<Seq> {
		if (this.closedOnce) throw new Error("storage closed");
		const seq = this.seq + 1;
		const apply = this.stage(writes, seq); // validates the whole batch first; throws before any file is touched
		const maxId = this.nextIdAfter(writes);
		const main: Write[] = [];
		const sticky = new Map<Id, Write[]>();
		const tasks = new Map<Id, Write[]>();
		const retired: Id[] = [];
		for (const w of writes) {
			if (w.type === "doc" && w.ref.doc === "sticky")
				(sticky.get(w.ref.conversationId) ?? sticky.set(w.ref.conversationId, []).get(w.ref.conversationId)!).push(
					w,
				);
			else if (w.type === "task.patch" && w.patch.status !== "terminal")
				(tasks.get(w.patch.id) ?? tasks.set(w.patch.id, []).get(w.patch.id)!).push(w);
			else {
				main.push(w);
				if (w.type === "task.patch" && w.patch.status === "terminal") retired.push(w.patch.id);
			}
		}
		const refs: string[] = [];
		for (const [id, ws] of tasks) {
			this.append(this.taskSidecar(id), { seq, maxId, writes: ws });
			refs.push(`task-${id}.jsonl`);
		}
		for (const [c, ws] of sticky) {
			this.append(this.sidecar(c), { seq, maxId, writes: ws });
			refs.push(`sticky-${c}.jsonl`);
		}
		this.append(this.mainFd, { seq, maxId, writes: main, ...(refs.length ? { refs } : {}) }); // the publication point
		apply();
		this.seq = seq;
		for (const id of retired) this.retireTaskSidecar(id); // after the terminal record is durably published
		void ctx;
		return seq;
	}
	private nextIdAfter(writes: readonly Write[]): Id {
		let max = this.nextIdValue - 1;
		for (const w of writes) {
			const id =
				w.type === "conversation"
					? w.conversation.id
					: w.type === "entry"
						? w.entry.id
						: w.type === "task"
							? w.task.id
							: w.type === "input"
								? w.input.id
								: 0;
			max = Math.max(max, id);
		}
		return max;
	}

	private append(fd: number, record: Record_) {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		if (this.fsync) fsyncSync(fd);
	}

	private sidecar(conversationId: Id): number {
		let fd = this.sidecars.get(conversationId);
		if (fd === undefined) {
			fd = openSync(join(this.dir, `sticky-${conversationId}.jsonl`), "a");
			this.sidecars.set(conversationId, fd);
		}
		return fd;
	}
	private taskSidecar(id: Id): number {
		let fd = this.taskSidecars.get(id);
		if (fd === undefined) {
			fd = openSync(join(this.dir, `task-${id}.jsonl`), "a");
			this.taskSidecars.set(id, fd);
		}
		return fd;
	}
	private retireTaskSidecar(id: Id) {
		const fd = this.taskSidecars.get(id);
		if (fd !== undefined) closeSync(fd);
		this.taskSidecars.delete(id);
		try {
			unlinkSync(join(this.dir, `task-${id}.jsonl`));
		} catch {}
	}

	/** Rewrite the sticky sidecar from its last base: temp file, optional fsync, rename. Called on the Session line. */
	override async truncate(ref: DocRef, _ctx?: Context): Promise<void> {
		await super.truncate(ref);
		if (ref.doc !== "sticky") return;
		const file = join(this.dir, `sticky-${ref.conversationId}.jsonl`);
		if (!existsSync(file)) return;
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		let start = 0;
		for (let i = lines.length - 1; i >= 0; i--)
			if (
				isBase((JSON.parse(lines[i]!) as Record_).writes.flatMap((w) => (w.type === "doc" ? w.ops : [])) as Op[])
			) {
				start = i;
				break;
			}
		if (start === 0) return;
		const tmp = `${file}.tmp`;
		const fd = openSync(tmp, "w");
		writeSync(
			fd,
			lines
				.slice(start)
				.map((l) => `${l}\n`)
				.join(""),
		);
		if (this.fsync) fsyncSync(fd);
		closeSync(fd);
		const old = this.sidecars.get(ref.conversationId);
		if (old !== undefined) closeSync(old);
		renameSync(tmp, file);
		this.sidecars.set(ref.conversationId, openSync(file, "a"));
	}

	override async close(_ctx?: Context) {
		if (this.closedOnce) return;
		this.closedOnce = true;
		await super.close();
		closeSync(this.mainFd);
		for (const fd of this.sidecars.values()) closeSync(fd);
		for (const fd of this.taskSidecars.values()) closeSync(fd);
	}
}

function truncateTo(file: string, length: number): void {
	const fd = openSync(file, "r+");
	try {
		ftruncateSync(fd, length);
	} finally {
		closeSync(fd);
	}
}

/** Bytes after the last newline are a torn write: cut them so a later append cannot extend a corrupt line. */
function truncateTornTail(file: string) {
	const size = statSync(file).size;
	if (size === 0) return;
	const buf = readFileSync(file);
	const end = buf.lastIndexOf(0x0a);
	if (end + 1 !== buf.length) truncateTo(file, end + 1);
}
