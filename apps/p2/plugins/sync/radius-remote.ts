// Radius's HTTP adapter for Chord's session-sync remote contract.
import type { Context } from "@p2/app/v1";
import type {
	JsonObject,
	PutBatchResult,
	RemoteListing,
	Seq,
	SessionChanges,
	SessionSyncStore,
	SyncBody,
} from "@p2/app/v1/node";

/** What a Radius sync request needs. Authentication and token refresh stay outside the adapter. */
export type RadiusSyncAccess = { readonly gateway: string; readonly serverId: string; readonly token: string };

const PAGE_SIZE = 100;

type ErrorBody = { error?: { message?: string; code?: string; details?: Record<string, unknown> } };

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
		const response = await this.#request(`/${encodeURIComponent(sessionId)}/batches/${after}?${query}`, context, {
			method: "PUT",
			headers: { "content-type": "application/gzip" },
			body: await collect(body),
		});
		if (response.status === 201) return { type: "created" };
		if (response.status === 409) {
			const { error } = (await response.json()) as ErrorBody;
			const details = error?.details ?? {};
			if (error?.code === "slot_taken" && isSeq(details.to) && typeof details.device === "string")
				return { type: "exists", to: details.to, device: details.device };
			if (error?.code === "not_head" && isSeq(details.head)) return { type: "not_head", head: details.head };
			// Chord needs one terminal divergence result instead of a transport error its scheduler would retry forever.
			if (error?.code === "slot_content_mismatch" && isSeq(details.to))
				return { type: "not_head", head: details.to };
			if ((error?.code === "next_id_regression" || error?.code === "legacy_session_history") && isSeq(details.head))
				return { type: "not_head", head: details.head };
			throw new Error(`Radius sync could not upload a batch: 409${error?.message ? ` ${error.message}` : ""}`);
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
		const { batches, snapshots } = (await response.json()) as RemoteListing;
		return { batches, snapshots };
	}

	async sessions(cursor: string | undefined, context: Context): Promise<SessionChanges> {
		const query = new URLSearchParams({ cursor: cursor ?? "0", limit: String(PAGE_SIZE) });
		const response = await this.#request(`?${query}`, context);
		if (!response.ok) throw await failure(response, "list sessions");
		const page = (await response.json()) as {
			sessions: { id: string; head: Seq; meta: JsonObject | null }[];
			cursor: number;
			more: boolean;
		};
		return {
			sessions: page.sessions.map((session) => ({
				id: session.id,
				head: session.head,
				meta: session.meta ?? undefined,
			})),
			cursor: String(page.cursor),
			more: page.more,
		};
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
		return (await response.json()) as JsonObject;
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
		return this.#fetch(url, {
			...init,
			headers,
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
		});
	}
}

/** Radius currently accepts one HTTP request body, so the prototype collects Chord's streamed body at this boundary. */
async function collect(body: SyncBody): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.length;
	}
	// Joined without Node's `Buffer`: a plugin's file loaded by another plugin may import only host packages.
	const joined = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return joined;
}

function isSeq(value: unknown): value is Seq {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A request Radius answered with an error: its HTTP status, so a caller tells a refusal from a passing failure. */
export class RadiusSyncError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "RadiusSyncError";
		this.status = status;
	}
}

/**
 * Whether retrying `error` cannot help (Radius's session-sync contract, radius#295): a body Radius refuses (400), one
 * too large (413), or sync not allowed for this server or user (403: the `session_sync` feature off, the server not
 * theirs). Expired credentials (401) refresh on the next attempt; server errors and network failures pass.
 */
export function isTerminalSyncError(error: unknown): boolean {
	return error instanceof RadiusSyncError && (error.status === 400 || error.status === 403 || error.status === 413);
}

async function failure(response: Response, operation: string): Promise<RadiusSyncError> {
	let message = "";
	try {
		message = ((await response.json()) as ErrorBody).error?.message ?? "";
	} catch {
		// The response was not a Radius JSON error.
	}
	return new RadiusSyncError(
		`Radius sync could not ${operation}: ${response.status}${message ? ` ${message}` : ""}`,
		response.status,
	);
}
