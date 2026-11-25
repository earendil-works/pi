// Radius's HTTP adapter for Chord's session-sync remote contract.
import type { Context } from "@p2/app/v1";
import {
	type BatchInfo,
	type JsonObject,
	type PutBatchResult,
	type RemoteListing,
	type Seq,
	type SessionChanges,
	type SessionSyncStore,
	SYNC_PROTOCOL,
	type SyncBody,
} from "@p2/app/v1/node";

/** What a Radius sync request needs. Authentication and token refresh stay outside the adapter. */
export type RadiusSyncAccess = { readonly gateway: string; readonly serverId: string; readonly token: string };

const PAGE_SIZE = 100;

/** The header carrying the sync rules' version (`SYNC_PROTOCOL`) on every request; Radius reads it as 0 when absent. */
const PROTOCOL_HEADER = "pi-sync-protocol";

/** Radius's code for a write this client's protocol is too old for: the session moved under newer rules. */
const PROTOCOL_TOO_OLD = "protocol_too_old";

/** Radius's error answer, as far as it could be read. */
type RadiusError = { readonly message?: string; readonly code?: string; readonly details: Record<string, unknown> };

/**
 * Chord session storage through Radius's server-scoped HTTP API. The first consumer backs up and restores sessions;
 * the same remote boundary can support broader synchronization later. Radius stamps slots with the authenticated
 * server ID, so the adapter intentionally ignores the device argument.
 */
export class RadiusSyncRemote implements SessionSyncStore {
	readonly #access: () => Promise<RadiusSyncAccess>;
	readonly #fetch: typeof fetch;

	constructor(access: () => Promise<RadiusSyncAccess>, fetchImpl: typeof fetch = fetch) {
		this.#access = access;
		this.#fetch = fetchImpl;
	}

	async putBatch(
		sessionId: string,
		after: Seq,
		to: Seq,
		_device: string,
		body: SyncBody,
		context: Context,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		const query = new URLSearchParams({ to: String(to) });
		if (options.archive === true) query.set("archive", "1");
		const init: StreamedInit = {
			method: "PUT",
			headers: { "content-type": "application/gzip" },
			body: streamOf(body),
			// A body sent as it is read (chunked, no length known up front): fetch needs to be told so.
			duplex: "half",
		};
		const response = await this.#request(
			`/${encodeURIComponent(sessionId)}/batches/${after}?${query}`,
			context,
			init,
		);
		if (response.status === 201) return { type: "created" };
		if (response.status === 409) {
			const error = errorOf(await response.json());
			const { details } = error;
			if (error.code === "slot_taken" && isSeq(details.to) && typeof details.device === "string")
				return { type: "exists", to: details.to, device: details.device };
			if (error.code === "not_head" && isSeq(details.head)) return { type: "not_head", head: details.head };
			// Chord needs one terminal divergence result instead of a transport error its scheduler would retry forever.
			if (error.code === "slot_content_mismatch" && isSeq(details.to)) return { type: "not_head", head: details.to };
			if ((error.code === "next_id_regression" || error.code === "legacy_session_history") && isSeq(details.head))
				return { type: "not_head", head: details.head };
			throw new RadiusSyncError(
				`Radius sync could not upload a batch: 409${error.message ? ` ${error.message}` : ""}`,
				409,
				error.code,
			);
		}
		throw await failure(response, "upload a batch");
	}

	getBatch(sessionId: string, after: Seq, context: Context): Promise<SyncBody | undefined> {
		return this.#body(`/${encodeURIComponent(sessionId)}/batches/${after}`, context, "download a batch");
	}

	getSnapshot(sessionId: string, to: Seq, context: Context): Promise<SyncBody | undefined> {
		return this.#body(`/${encodeURIComponent(sessionId)}/snapshots/${to}`, context, "download a snapshot");
	}

	async list(sessionId: string, context: Context): Promise<RemoteListing> {
		const response = await this.#request(`/${encodeURIComponent(sessionId)}`, context);
		if (response.status === 404) return { batches: [], snapshots: [] };
		if (!response.ok) throw await failure(response, "list a session");
		return listingOf(await response.json());
	}

	async sessions(cursor: string | undefined, context: Context): Promise<SessionChanges> {
		const query = new URLSearchParams({ cursor: cursor ?? "0", limit: String(PAGE_SIZE) });
		const response = await this.#request(`?${query}`, context);
		if (!response.ok) throw await failure(response, "list sessions");
		return changesOf(await response.json());
	}

	async putMeta(sessionId: string, meta: JsonObject, context: Context): Promise<void> {
		const response = await this.#request(`/${encodeURIComponent(sessionId)}/meta`, context, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(meta),
		});
		if (!response.ok) throw await failure(response, "write a session description");
	}

	async getMeta(sessionId: string, context: Context): Promise<JsonObject | undefined> {
		const response = await this.#request(`/${encodeURIComponent(sessionId)}/meta`, context);
		if (response.status === 404) return undefined;
		if (!response.ok) throw await failure(response, "read a session description");
		const meta: unknown = await response.json();
		if (!isObject(meta)) throw malformed("read a session description");
		return meta;
	}

	async #body(path: string, context: Context, operation: string): Promise<SyncBody | undefined> {
		const response = await this.#request(path, context);
		if (response.status === 404) return undefined;
		if (!response.ok) throw await failure(response, operation);
		if (response.body === null) throw new Error(`Radius sync could not ${operation}: the response has no body`);
		// Node fetch streams are async iterable; the DOM type used by p2 omits that surface.
		return response.body as unknown as SyncBody;
	}

	async #request(path: string, context: Context, init: RequestInit = {}): Promise<Response> {
		const access = await this.#access();
		const url = new URL(`/v1/servers/${encodeURIComponent(access.serverId)}/sync/sessions${path}`, access.gateway);
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${access.token}`);
		headers.set(PROTOCOL_HEADER, String(SYNC_PROTOCOL));
		return this.#fetch(url, {
			...init,
			headers,
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
		});
	}
}

/** A request whose body streams; `duplex` is Node's fetch option, which the DOM type p2 uses lacks. */
type StreamedInit = RequestInit & { readonly duplex: "half" };

/**
 * `body` as a request body that streams: each piece is taken from `body` only when the request reads the next one
 * (`highWaterMark` 0), so the server holds about one piece per upload, never the whole body, and a slow Radius slows the
 * worker that produces the pieces instead of filling memory.
 */
function streamOf(body: SyncBody): ReadableStream<Uint8Array> {
	const pieces = body[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const next = await pieces.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			// The request stopped reading (aborted, failed): the producer stops too.
			async cancel(reason) {
				await pieces.return?.(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

function isSeq(value: unknown): value is Seq {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A request Radius answered with an error: its HTTP status and Radius's error code, so a caller tells a refusal from a
 * passing failure.
 */
export class RadiusSyncError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "RadiusSyncError";
		this.status = status;
		this.code = code;
	}
}

/**
 * Whether retrying `error` cannot help (Radius's session-sync contract, radius#295): a body Radius refuses (400), one
 * too large (413), sync not allowed for this server or user (403: the `session_sync` feature off, the server not
 * theirs), or a session that needs a newer sync protocol than this client's (409 `protocol_too_old`: only updating p2
 * helps). Expired credentials (401) refresh on the next attempt; server errors and network failures pass.
 */
export function isTerminalSyncError(error: unknown): boolean {
	return (
		error instanceof RadiusSyncError &&
		(error.status === 400 || error.status === 403 || error.status === 413 || error.code === PROTOCOL_TOO_OLD)
	);
}

async function failure(response: Response, operation: string): Promise<RadiusSyncError> {
	let error: RadiusError = { details: {} };
	try {
		error = errorOf(await response.json());
	} catch {
		// The response was not JSON: its status says enough.
	}
	const message = error.message ?? "";
	return new RadiusSyncError(
		`Radius sync could not ${operation}: ${response.status}${message ? ` ${message}` : ""}`,
		response.status,
		error.code,
	);
}

// Radius's answers are wire input (a trust boundary): each is checked before p2 uses it, never cast.

/** Radius's error answer (`{ error: { message, code, details } }`), each field kept only when it has its type. */
function errorOf(body: unknown): RadiusError {
	const error = isObject(body) && isObject(body.error) ? body.error : {};
	return {
		...(typeof error.message === "string" ? { message: error.message } : {}),
		...(typeof error.code === "string" ? { code: error.code } : {}),
		details: isObject(error.details) ? error.details : {},
	};
}

/** A session's slots and snapshots; a malformed answer fails the request, retried as a passing failure. */
function listingOf(body: unknown): RemoteListing {
	if (!isObject(body) || !Array.isArray(body.batches) || !Array.isArray(body.snapshots))
		throw malformed("list a session");
	const batches = body.batches.map((slot: unknown): BatchInfo => {
		if (!isObject(slot) || !isSeq(slot.after) || !isSeq(slot.to) || typeof slot.device !== "string")
			throw malformed("list a session");
		return {
			after: slot.after,
			to: slot.to,
			device: slot.device,
			...(slot.folded === true ? { folded: true as const } : {}),
			...(slot.archive === true ? { archive: true as const } : {}),
		};
	});
	const snapshots = body.snapshots.map((at: unknown) => {
		if (!isSeq(at)) throw malformed("list a session");
		return at;
	});
	return { batches, snapshots };
}

/** A page of sessions changed after a cursor. */
function changesOf(body: unknown): SessionChanges {
	if (!isObject(body) || !Array.isArray(body.sessions) || !isSeq(body.cursor) || typeof body.more !== "boolean")
		throw malformed("list sessions");
	const sessions = body.sessions.map((session: unknown) => {
		if (!isObject(session) || typeof session.id !== "string" || !isSeq(session.head))
			throw malformed("list sessions");
		// A session without a description has `meta: null`.
		const meta = isObject(session.meta) ? session.meta : undefined;
		if (meta === undefined && session.meta !== null && session.meta !== undefined) throw malformed("list sessions");
		return { id: session.id, head: session.head, meta };
	});
	return { sessions, cursor: String(body.cursor), more: body.more };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const malformed = (operation: string): Error => new Error(`Radius sync could not ${operation}: a malformed answer`);
