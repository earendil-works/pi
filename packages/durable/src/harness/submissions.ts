import { type Context, copyJson, type JsonRepresentation } from "@earendil-works/chord";
import { withTelemetry } from "@earendil-works/chord/context";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { ConversationBusy } from "../errors.ts";
import type { ObservedCommit, SessionImpl } from "../session/session.ts";
import type { ConversationId, JsonObject, Storage, SubmissionId, SubmissionRecord, Tx } from "../types.ts";
import { startRun } from "./generation.ts";
import {
	appendInput,
	applyBoundary,
	hasQueuedReset,
	InboxDoc,
	isDisplayOnly,
	isStale,
	pickInputEntry,
	prepareBoundary,
	type QueueModes,
	removeInboxItem,
} from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
import type { InputEntry, SettledSubmissionRecord, Submission, SubmissionDraft, UserInput } from "./types.ts";
import { closedError, Waiters } from "./util.ts";

type AbortResult = "aborted" | "already_placed" | "settled";
type Admission = { readonly id: SubmissionId; readonly status: "queued" | "placed" | "done" };

/** Admission, waits, and withdrawal of the durable submissions of one Harness. */
export class Submissions {
	readonly #telemetry: TelemetryContext;
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #now: () => number;
	/** Read at each admission, on the Session line. */
	readonly #queueModes: () => QueueModes;
	/** Enable task scheduling; submitting or waiting asks for progress. */
	readonly #resume: () => void;
	readonly #waiters = new Waiters<SubmissionId, SettledSubmissionRecord>();
	#closed = false;

	constructor(
		session: SessionImpl,
		storage: Storage,
		now: () => number,
		queueModes: () => QueueModes,
		resume: () => void,
		telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
	) {
		this.#telemetry = telemetry;
		this.#session = session;
		this.#storage = storage;
		this.#now = now;
		this.#queueModes = queueModes;
		this.#resume = resume;
		session.observeCommits((publication) => this.#observe(publication));
		session.subscribeClose(() => {
			this.#closed = true;
			this.#waiters.rejectAll(closedError(this.#session));
		});
	}

	/** Admit a submission in one commit; see `admitSubmission()`. */
	async submit(conversationId: ConversationId, draft: SubmissionDraft, context: Context): Promise<Submission> {
		this.#resume();
		const parent = draft.type === "input" ? this.#telemetry : context.telemetry;
		return createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])(
			"pi.durable.submit",
			{
				"submission.type": draft.type,
				"conversation.id": conversationId,
			},
			async (span) => {
				if (draft.type === "input") span.addLink({ context: context.telemetry });
				try {
					const { id, status } = await this.#session.commitWith(
						(tx) => admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes(), span),
						withTelemetry(span, context),
					);
					span.setAttributes({ "submission.id": id, result: status });
					return new SubmissionHandle(id, this);
				} catch (error) {
					// Error text may contain caller content. Record only the status.
					span.setStatus({ status: "error" });
					throw error;
				}
			},
		);
	}

	/** Handle for an existing submission, or `undefined`. */
	async get(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		return record === undefined ? undefined : new SubmissionHandle(record.id, this);
	}

	async status(id: SubmissionId, context: Context): Promise<SubmissionRecord> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		if (record === undefined) throw new Error(`Submission ${id} does not exist`);
		return record;
	}

	async wait(id: SubmissionId, context: Context): Promise<SettledSubmissionRecord> {
		this.#resume();
		// Check and register on the line so no settling publication falls between them.
		const found = await this.#session.readOnLine(async () => {
			const record = await this.#storage.submission(id, context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist`);
			if (isSettled(record)) return { promise: Promise.resolve(record) };
			// Close rejects registered waiters synchronously and may begin during the read.
			if (this.#closed) throw closedError(this.#session);
			return { promise: this.#waiters.add(id, context) };
		});
		return found.promise;
	}

	/** Withdraw a queued submission and remove its inbox item; placed inputs and settled submissions are reported. */
	abort(id: SubmissionId, context: Context, conversationId?: ConversationId): Promise<AbortResult | "not_found"> {
		return this.#session.commitWith(async (tx) => {
			const record = await tx.submission(id);
			if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId)) {
				return "not_found";
			}
			if (record.status === "queued") {
				tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
				await removeInboxItem(tx, record.conversationId, id);
				return "aborted";
			}
			return record.status === "placed" ? "already_placed" : "settled";
		}, context);
	}

	#observe(publication: ObservedCommit): void {
		// A commit held in memory changes documents only.
		if (publication.kind === "memory") return;
		for (const change of publication.changes) {
			if (change.type !== "submission" || !isSettled(change.value)) continue;
			this.#waiters.resolve(change.value.id, change.value);
		}
	}
}

class SubmissionHandle implements Submission {
	readonly id: SubmissionId;
	readonly #submissions: Submissions;

	constructor(id: SubmissionId, submissions: Submissions) {
		this.id = id;
		this.#submissions = submissions;
	}

	status(context: Context): Promise<SubmissionRecord> {
		return this.#submissions.status(this.id, context);
	}

	wait(context: Context): Promise<SettledSubmissionRecord> {
		return this.#submissions.wait(this.id, context);
	}

	async abort(context: Context): Promise<AbortResult> {
		const result = await this.#submissions.abort(this.id, context);
		if (result === "not_found") throw new Error(`Submission ${this.id} does not exist`);
		return result;
	}
}

function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
	return record.status === "done" || record.status === "unanswered";
}

/** Reject an input entry an untyped caller got wrong: its kind must be a non-empty string outside the `pi.` prefix. */
function checkInputEntry(entry: InputEntry): void {
	const { kind } = entry;
	if (typeof kind !== "string" || kind.length === 0 || kind.startsWith("pi.")) {
		throw new TypeError(
			`An input entry's kind must be a non-empty string not starting with "pi.", got ${String(kind)}`,
		);
	}
}

/**
 * Admit a submission inside a commit (spec §6); `Conversation.submit()` and conversation-owned compactions share it. A
 * known request ID returns its existing submission without writing. A display-only write (only `kind` and `data`) is
 * appended and settled `done` at once, busy or not, as it changes nothing the model sees; only behind a queued reset it
 * queues, so it lands after the reset instead of before it in the context the reset ends. A busy conversation queues anything else in
 * `pi.inbox`, or rejects `whenBusy: "reject"` input with `ConversationBusy`. An idle conversation with queued items
 * queues it behind them and runs a final boundary. Otherwise idle input places its entry (`pi.user`, or the input's
 * own) and starts a run, and an idle write appends its entry and settles `done`, or `stale` when its head reaches
 * before the active range.
 */
export async function admitSubmission(
	tx: Tx,
	conversationId: ConversationId,
	draft: SubmissionDraft,
	now: number,
	queueModes: QueueModes,
	span?: TelemetrySpan,
): Promise<Admission> {
	if (draft.type === "input" && draft.entry !== undefined) checkInputEntry(draft.entry);
	if (draft.requestId !== undefined) {
		const existing = await tx.submissionByRequest(conversationId, draft.requestId);
		if (existing !== undefined) {
			if (existing.type !== draft.type) {
				throw new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`);
			}
			return { id: existing.id, status: existing.status === "unanswered" ? "done" : existing.status };
		}
	}
	const fields = { conversationId, requestId: draft.requestId, trace: span?.propagation?.inject(span) };
	if (
		draft.type === "write" &&
		isDisplayOnly(draft.entry) &&
		!hasQueuedReset((await tx.doc(InboxDoc, conversationId)).items)
	) {
		const entry = await tx.appendEntry(conversationId, draft.entry);
		const write = { ...fields, type: "write", status: "done", entry: entry.id } as const;
		return { id: (await tx.createSubmission(write)).id, status: "done" };
	}
	const live = await tx.doc(LiveDoc, conversationId);
	const busy = live.run !== undefined;
	if (
		draft.type === "input" &&
		draft.whenBusy === "steer" &&
		live.run !== undefined &&
		span?.propagation !== undefined
	) {
		const run = await tx.task(live.run.taskId);
		if (run?.trace !== undefined) span.addLink({ context: span.propagation.extract(run.trace) });
	}
	if (busy && draft.type === "input" && draft.whenBusy === "reject") throw new ConversationBusy(conversationId);
	// A boundary reads the table, so it is prepared before the first table write; a busy one needs none.
	const boundary = busy ? undefined : await prepareBoundary(tx, conversationId, queueModes);
	if (boundary === undefined || boundary.inbox.items.length > 0) {
		const { id } = await tx.createSubmission({
			...fields,
			type: draft.type,
			status: "queued",
		});
		// Hosts may leave optional fields `undefined`; drafts take strict JSON.
		const value = copyJson(draft.type === "write" ? draft.entry : draft.content, {
			omitUndefinedProperties: true,
		});
		const items = (boundary?.inbox ?? (await tx.doc(InboxDoc, conversationId))).items;
		if (draft.type === "write") items.push({ id, mode: "write", entry: value as JsonObject });
		else {
			const mode = draft.whenBusy === "steer" ? "steer" : "followUp";
			const content = value as JsonRepresentation<UserInput>;
			const entry = draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) };
			items.push({ id, mode, content, ...entry });
		}
		if (boundary === undefined) return { id, status: "queued" };
		const { users } = await applyBoundary(tx, boundary, "final", now);
		if (users.length > 0) await startRun(tx, conversationId, live, users);
		return { id, status: draft.type === "write" ? "done" : users.at(-1) === id ? "placed" : "queued" };
	}
	if (draft.type === "write") {
		if (isStale(boundary, draft.entry)) {
			const stale = { status: "unanswered", reason: "stale" } as const;
			return {
				id: (await tx.createSubmission({ ...fields, type: "write", ...stale })).id,
				status: "done",
			};
		}
		const entry = await tx.appendEntry(conversationId, draft.entry);
		const write = { ...fields, type: "write", status: "done", entry: entry.id } as const;
		return { id: (await tx.createSubmission(write)).id, status: "done" };
	}
	const entry = await appendInput(tx, conversationId, draft.content, draft.entry, now);
	const input = { ...fields, type: "input", status: "placed", entry: entry.id } as const;
	const { id } = await tx.createSubmission(input);
	await startRun(tx, conversationId, live, [id]);
	return { id, status: "placed" };
}
