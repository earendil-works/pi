// The open html pages of each artifact (server, in memory): what they report (errors, logs, numbered as they arrive,
// the newest kept), which of their errors a message carried to the agent already, and the agent's code each runs. A page
// is open while some browser shows it (its pane or inline card holds `ArtifactPage`); requests go to the first one open.
import { randomUUID } from "node:crypto";
import type { EvalResult, LogEntry } from "./contract.ts";

/** How many errors and log lines are kept per artifact, the newest. */
const KEPT_ERRORS = 50;
const KEPT_LOGS = 500;
/** How long the agent's code may run in a page before the request fails. */
const EVAL_TIMEOUT_MS = 30_000;

/** An open page: how to ask it to run code. */
export type PageChannel = { readonly run: (request: { request: string; code: string }) => void };

type Reported = { errors: LogEntry[]; logs: LogEntry[]; carried: number; seq: number };

/** The open pages and their reports, by `<session>/<id>`. */
export class PageRegistry {
	readonly #pages = new Map<string, PageChannel[]>();
	readonly #reports = new Map<string, Reported>();
	readonly #pending = new Map<string, (result: EvalResult) => void>();

	/** Registers an open page of artifact `id` of `session`; the returned function unregisters it. */
	open(session: string, id: string, channel: PageChannel): () => void {
		const key = keyOf(session, id);
		this.#pages.set(key, [...(this.#pages.get(key) ?? []), channel]);
		return () => {
			const left = (this.#pages.get(key) ?? []).filter((each) => each !== channel);
			if (left.length) this.#pages.set(key, left);
			else this.#pages.delete(key);
		};
	}

	/** What a page reported: its new errors and log lines. */
	report(
		session: string,
		id: string,
		errors: readonly string[],
		logs: readonly { readonly level: string; readonly text: string }[],
	): void {
		const reported = this.#reported(session, id);
		const at = Date.now();
		for (const text of errors) reported.errors.push({ seq: ++reported.seq, level: "error", text, at });
		for (const { level, text } of logs) reported.logs.push({ seq: ++reported.seq, level, text, at });
		reported.errors.splice(0, Math.max(0, reported.errors.length - KEPT_ERRORS));
		reported.logs.splice(0, Math.max(0, reported.logs.length - KEPT_LOGS));
	}

	/** The errors kept for artifact `id`, oldest first. */
	errors(session: string, id: string): LogEntry[] {
		return [...(this.#reports.get(keyOf(session, id))?.errors ?? [])];
	}

	/** The log lines kept after `since`, and the newest number. */
	logs(session: string, id: string, since: number): { logs: LogEntry[]; next: number } {
		const reported = this.#reports.get(keyOf(session, id));
		return { logs: (reported?.logs ?? []).filter((entry) => entry.seq > since), next: reported?.seq ?? since };
	}

	/** The errors of `session`'s artifacts no message carried yet, and the marks `carried` takes once one did. */
	uncarried(session: string): { errors: { id: string; text: string }[]; marks: { id: string; seq: number }[] } {
		const errors: { id: string; text: string }[] = [];
		const marks: { id: string; seq: number }[] = [];
		const prefix = `${session}/`;
		for (const [key, reported] of this.#reports) {
			if (!key.startsWith(prefix)) continue;
			const id = key.slice(prefix.length);
			const fresh = reported.errors.filter((entry) => entry.seq > reported.carried);
			if (!fresh.length) continue;
			errors.push(...fresh.map((entry) => ({ id, text: entry.text })));
			marks.push({ id, seq: fresh.at(-1)!.seq });
		}
		return { errors, marks };
	}

	/** Marks errors up to each mark's number carried. */
	carried(session: string, marks: readonly { readonly id: string; readonly seq: number }[]): void {
		for (const { id, seq } of marks) {
			const reported = this.#reports.get(keyOf(session, id));
			if (reported && seq > reported.carried) reported.carried = seq;
		}
	}

	/** Runs `code` in the first open page of artifact `id`: its result, or an error when none is open or it times out. */
	run(session: string, id: string, code: string, signal: AbortSignal | undefined): Promise<EvalResult> {
		const [page] = this.#pages.get(keyOf(session, id)) ?? [];
		if (!page)
			return Promise.resolve({
				ok: false,
				error: `Artifact "${id}" is not open on any device: artifact_open or artifact_show it first`,
			});
		const request = randomUUID();
		return new Promise<EvalResult>((resolve) => {
			const done = (result: EvalResult) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", aborted);
				this.#pending.delete(request);
				resolve(result);
			};
			const aborted = () => done({ ok: false, error: "Cancelled" });
			const timer = setTimeout(
				() => done({ ok: false, error: `The page did not answer within ${EVAL_TIMEOUT_MS / 1000} s` }),
				EVAL_TIMEOUT_MS,
			);
			signal?.addEventListener("abort", aborted, { once: true });
			this.#pending.set(request, done);
			page.run({ request, code });
		});
	}

	/** A page's answer to request `request` (the first answer wins; a late or unknown one changes nothing). */
	answer(request: string, result: EvalResult): void {
		this.#pending.get(request)?.(result);
	}

	/** Forgets what artifact `id` reported (it was removed). */
	forget(session: string, id: string): void {
		this.#reports.delete(keyOf(session, id));
	}

	#reported(session: string, id: string): Reported {
		const key = keyOf(session, id);
		let reported = this.#reports.get(key);
		if (!reported) {
			reported = { errors: [], logs: [], carried: 0, seq: 0 };
			this.#reports.set(key, reported);
		}
		return reported;
	}
}

const keyOf = (session: string, id: string) => `${session}/${id}`;
