// Node-only diagnostics. Redaction happens before a line enters a bounded source buffer.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type LogLevel = "stdout" | "stderr" | "event" | "error";
export type LogLine = { id: number; time: number; level: LogLevel; text: string };
export type LogSource = { id: string; lines: number; updatedAt: number };
export type LogSnapshot = { source: string; lines: LogLine[] };
export type LogNotice = { id: number; time: number; source: string; message: string };
const REDACTED = "[redacted]";
const SENSITIVE =
	/(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie|credential|private[-_]?key|^key$|^access$|^refresh$)/i;

/** Literal secrets supplement structural redaction (e.g. a key printed without its field name). */
export class LogRedactor {
	readonly #secrets = new Set<string>();
	readonly #directories = new Set<string>();
	readonly #fingerprints = new Map<string, string>();

	addSecret(value: string): void {
		if (value && value !== REDACTED) {
			this.#secrets.add(value);
			if (value.trim() && value.trim() !== REDACTED) this.#secrets.add(value.trim());
			// Line capture must also protect multiline values (e.g. private credentials) line by line.
			for (const line of value.split(/\r?\n/)) if (line && line !== REDACTED) this.#secrets.add(line);
			try {
				const url = new URL(value);
				if (url.username) this.#secrets.add(decodeURIComponent(url.username));
				if (url.password) this.#secrets.add(decodeURIComponent(url.password));
				for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
					for (const [name, token] of parameters)
						if (token && /^(?:code|state|token|access_token|refresh_token|id_token|api_key)$/i.test(name))
							this.#secrets.add(token);
				}
			} catch {
				/* Most credential values are not URLs. */
			}
		}
	}

	addDirectory(directory: string): void {
		this.#directories.add(directory);
	}

	#collect(value: unknown, sensitive = false): void {
		if (typeof value === "string") {
			if (sensitive) this.addSecret(value);
		} else if (Array.isArray(value)) {
			for (const entry of value) this.#collect(entry, sensitive);
		} else if (value && typeof value === "object") {
			for (const [key, entry] of Object.entries(value)) this.#collect(entry, sensitive || SENSITIVE.test(key));
		}
	}

	#refresh(): void {
		for (const [key, value] of Object.entries(process.env)) if (value && SENSITIVE.test(key)) this.addSecret(value);
		for (const directory of this.#directories) {
			for (const name of [
				"auth.json",
				"radius.json",
				"models.json",
				"settings.json",
				"envs.json",
				"owner-key",
				"owner-token.txt",
			]) {
				const path = join(directory, name);
				try {
					const info = statSync(path, { bigint: true });
					const fingerprint = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
					if (this.#fingerprints.get(path) === fingerprint) continue;
					const text = readFileSync(path, "utf8");
					if (name.endsWith(".json")) this.#collect(JSON.parse(text.replace(/^\uFEFF/, "")));
					else this.addSecret(text.trim());
					this.#fingerprints.set(path, fingerprint);
				} catch {
					// Keep prior secrets through a partial write, deletion, logout or configuration error.
				}
			}
		}
	}

	redact(text: string): string {
		this.#refresh();
		let result = text;
		// Longest first: overlapping secrets cannot leave an unredacted suffix.
		for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
			result = result.split(secret).join(REDACTED);
			try {
				const encoded = encodeURIComponent(secret);
				if (encoded !== secret) result = result.split(encoded).join(REDACTED);
			} catch {
				/* Malformed Unicode must not break the host's diagnostics. */
			}
		}
		return result
			.replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, `$1: ${REDACTED}`)
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_~.%-]+/gi, `$1 ${REDACTED}`)
			.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
			.replace(/\bsk-[A-Za-z0-9_-]+\b/g, REDACTED)
			.replace(
				/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|cookie|authorization|proxy[-_]?secret|key|access|refresh)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,
				`$1${REDACTED}`,
			);
	}
}

/** Per-source limits plus a source limit bound total memory, including abandoned workers. */
export class LogStore {
	readonly redactor = new LogRedactor();
	readonly #buffers = new Map<string, { lines: LogLine[]; bytes: number; updatedAt: number }>();
	readonly #listeners = new Set<(source: string) => void>();
	readonly #limits: { lines: number; bytes: number; sources: number; lineBytes: number };
	#id = 0;
	#noticeId = 0;
	#notices: LogNotice[] = [];
	readonly events: { subscribe(listener: (source: string) => void): () => void } = {
		subscribe: (listener) => {
			this.#listeners.add(listener);
			return () => this.#listeners.delete(listener);
		},
	};

	constructor(limits: Partial<{ lines: number; bytes: number; sources: number; lineBytes: number }> = {}) {
		this.#limits = { lines: 1000, bytes: 256 * 1024, sources: 128, lineBytes: 16 * 1024, ...limits };
		for (const value of Object.values(this.#limits))
			if (!Number.isInteger(value) || value < 1) throw new Error("Invalid log bounds");
	}

	append(source: string, level: LogLevel, text: string, time = Date.now()): void {
		// Redact the full input, then truncate: never retain a prefix of a secret.
		const safe = this.redactor.redact(text);
		for (const line of safe.split(/\r?\n/)) {
			let entry = this.#buffers.get(source);
			if (!entry) {
				if (this.#buffers.size >= this.#limits.sources) this.#buffers.delete(this.#buffers.keys().next().value!);
				entry = { lines: [], bytes: 0, updatedAt: time };
			}
			// Map order is least recently appended first.
			this.#buffers.delete(source);
			this.#buffers.set(source, entry);
			const bounded = Buffer.byteLength(line) > this.#limits.lineBytes ? "[oversized log line omitted]" : line;
			const size = Buffer.byteLength(bounded);
			entry.lines.push({ id: ++this.#id, time, level, text: bounded });
			entry.bytes += size;
			entry.updatedAt = time;
			while (entry.lines.length > this.#limits.lines || entry.bytes > this.#limits.bytes) {
				entry.bytes -= Buffer.byteLength(entry.lines.shift()!.text);
			}
		}
		for (const listener of [...this.#listeners]) listener(source);
	}

	notice(source: string, message: string): void {
		const safe = this.redactor.redact(message);
		const bounded = Buffer.byteLength(safe) > this.#limits.lineBytes ? "[oversized error message omitted]" : safe;
		this.#notices = [
			...this.#notices.filter((notice) => notice.source !== source),
			{ id: ++this.#noticeId, time: Date.now(), source, message: bounded },
		].slice(-50);
		this.append(source, "error", bounded);
	}

	notices(): LogNotice[] {
		return this.#notices.map((notice) => ({ ...notice }));
	}

	dismissNotice(id: number): void {
		const notice = this.#notices.find((entry) => entry.id === id);
		this.#notices = this.#notices.filter((entry) => entry.id !== id);
		if (notice) for (const listener of [...this.#listeners]) listener(notice.source);
	}

	lines(source: string): LogLine[] {
		return this.#buffers.get(source)?.lines.map((line) => ({ ...line })) ?? [];
	}

	sources(): LogSource[] {
		return [...this.#buffers].map(([id, entry]) => ({ id, lines: entry.lines.length, updatedAt: entry.updatedAt }));
	}
}

// Survives compatible Node facet reloads; the buffers belong to the process, not a factory closure.
const KEY = Symbol.for("p2.process-logs@1");
const CAPTURES = Symbol.for("p2.log-captures@1");
type Capture = { references: number; stop: () => void };
const globals = globalThis as typeof globalThis & {
	[KEY]?: LogStore;
	[CAPTURES]?: WeakMap<LogStore, Map<string, Capture>>;
};
globals[KEY] ??= new LogStore();
globals[CAPTURES] ??= new WeakMap();
export const processLogs: LogStore = globals[KEY];
const captures = globals[CAPTURES];

/** Complete UTF-8 lines only; even a secret split across writes is redacted as a whole. */
export function logWriter(
	source: string,
	level: LogLevel,
	store = processLogs,
	forward?: (line: string) => void,
): {
	write(chunk: string | Uint8Array): void;
	/** Drop an incomplete line after capture overflow, then resume at the next newline. */
	discard(): void;
	end(): void;
} {
	let decoder = new StringDecoder("utf8");
	let pending = "";
	let oversized = false;
	const publish = (text: string): void => {
		const safe = store.redactor.redact(text);
		store.append(source, level, safe);
		forward?.(safe);
	};
	const consume = (text: string): void => {
		for (const [index, part] of text.split("\n").entries()) {
			if (index > 0) {
				publish(oversized ? "[oversized log line omitted]" : pending.replace(/\r$/, ""));
				pending = "";
				oversized = false;
			}
			if (!oversized) {
				pending += part;
				if (Buffer.byteLength(pending) > 64 * 1024) {
					pending = "";
					oversized = true;
				}
			}
		}
	};
	return {
		write: (chunk) => consume(typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk))),
		discard: () => {
			decoder = new StringDecoder("utf8");
			pending = "";
			oversized = true;
		},
		end: () => {
			consume(decoder.end());
			if (pending || oversized) publish(oversized ? "[oversized log line omitted]" : pending);
			pending = "";
			oversized = false;
		},
	};
}

/** Mirror writes without changing the original stdout/stderr behavior. Release when the owning host closes. */
export function captureProcessLogs(
	source: string,
	store = processLogs,
	options: { inTests?: boolean } = {},
): () => void {
	// Test processes use stdout as a reporter transport, not application diagnostics. Tests can opt in explicitly.
	if (!options.inTests && (process.env.NODE_TEST_CONTEXT !== undefined || process.execArgv.includes("--test")))
		return () => {};
	let bySource = captures.get(store);
	if (!bySource) {
		bySource = new Map();
		captures.set(store, bySource);
	}
	const existing = bySource.get(source);
	if (existing) {
		existing.references++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--existing.references === 0) {
				existing.stop();
				bySource.delete(source);
			}
		};
	}
	const stops = (["stdout", "stderr"] as const).map((level) => {
		const stream = process[level];
		const original = stream.write;
		const writer = logWriter(source, level, store);
		let queued: Buffer[] = [];
		let bytes = 0;
		let dropped = false;
		let task: ReturnType<typeof setImmediate> | undefined;
		const flush = (): void => {
			task = undefined;
			const batch = queued;
			queued = [];
			bytes = 0;
			try {
				if (dropped) {
					dropped = false;
					writer.discard();
				}
				for (const chunk of batch) writer.write(chunk);
			} catch {
				/* A diagnostics failure must not change stream behavior. */
			}
		};
		const write: typeof stream.write = function (this: typeof stream, ...args: unknown[]) {
			// Delegate immediately, with the exact receiver and arguments. Never buffer, transform, replay or
			// manufacture callbacks for real output, including binary node:test reporter frames.
			const result = Reflect.apply(original, this, args) as boolean;
			try {
				const [input, encodingOrCallback] = args;
				const chunk =
					typeof input === "string"
						? input
						: ArrayBuffer.isView(input)
							? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
							: undefined;
				if (chunk === undefined) return result;
				const encoding = typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : "utf8";
				const size = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
				if (bytes + size > 256 * 1024) {
					queued = [];
					bytes = 0;
					dropped = true;
				} else {
					const copy = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
					queued.push(copy);
					bytes += copy.byteLength;
				}
				task ??= setImmediate(flush);
				task.unref();
			} catch {
				/* Only the redacted copy is optional; the original write already happened. */
			}
			return result;
		};
		stream.write = write;
		return () => {
			if (stream.write === write) stream.write = original;
			clearImmediate(task);
			flush();
			try {
				writer.end();
			} catch {
				/* Diagnostics must not break shutdown. */
			}
		};
	});
	const capture: Capture = {
		references: 1,
		stop: () => {
			for (const stop of stops) stop();
		},
	};
	bySource.set(source, capture);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--capture.references === 0) {
			capture.stop();
			bySource.delete(source);
		}
	};
}

/** Detached hosts publish an atomic, bounded, already-redacted snapshot; no unbounded raw log file. */
export function persistLogSource(source: string, path: string, store = processLogs): () => Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writes = Promise.resolve();
	let writing = false;
	let pending: string | undefined;
	const flush = (): void => {
		const snapshot: LogSnapshot = { source, lines: store.lines(source) };
		pending = JSON.stringify(snapshot);
		if (writing) return; // A slow disk keeps only the latest pending snapshot, never an unbounded queue.
		writing = true;
		writes = (async () => {
			while (pending !== undefined) {
				const content = pending;
				pending = undefined;
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				const temporary = `${path}.${process.pid}.tmp`;
				await writeFile(temporary, content, { mode: 0o600 });
				await rename(temporary, path);
			}
		})()
			.catch(() => {
				pending = undefined;
			})
			.finally(() => {
				writing = false;
				if (pending !== undefined) flush();
			}); // Diagnostics must not break their host.
	};
	const stop = store.events.subscribe((changed) => {
		if (changed !== source || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			flush();
		}, 50);
		timer.unref();
	});
	flush();
	return async () => {
		stop();
		clearTimeout(timer);
		flush();
		while (writing) await writes;
	};
}

/** Start a detached host's bounded log publication (terminal host or dev supervisor). */
export function capturePublishedLogs(
	source: "terminals" | "dev",
	directory: string,
	options: { inTests?: boolean } = {},
): () => Promise<void> {
	if (!options.inTests && (process.env.NODE_TEST_CONTEXT !== undefined || process.execArgv.includes("--test")))
		return async () => {};
	processLogs.redactor.addDirectory(directory);
	const path = join(directory, `${source}.logs.json`);
	const persist = persistLogSource(source, path);
	const stop = captureProcessLogs(source, processLogs, options);
	// Node's native fatal-error printer can bypass stream.write. Observe without changing its exit behavior.
	const fatal = (error: Error): void => processLogs.append(source, "error", error.stack ?? error.message);
	process.on("uncaughtExceptionMonitor", fatal);
	// Node's default fatal-error printer runs before exit. A synchronous final snapshot retains that stack,
	// and explicit process.exit (terminal idle timeout) cannot skip the last buffered lines.
	const exiting = (): void => {
		stop();
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.exit.tmp`;
			writeFileSync(temporary, JSON.stringify({ source, lines: processLogs.lines(source) }), { mode: 0o600 });
			renameSync(temporary, path);
		} catch {
			/* Diagnostics must not change process termination. */
		}
	};
	process.once("exit", exiting);
	return async () => {
		process.removeListener("exit", exiting);
		process.removeListener("uncaughtExceptionMonitor", fatal);
		stop();
		await persist();
	};
}
