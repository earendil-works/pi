// Files' two routes, a file's bytes to and from a browser, each held as the person (decision 25): the request's scope
// holds the person's own reference to Files in the workspace, and the transfer holds what lets the person do it, live
// (`held`): the member (`open` or `upload`) on that reference and the machine's availability to them there (their
// answer on it). The moment either goes the transfer ends: the reader is closed or the staged file removed at once, not
// at the next piece, a read under way cut. Both are checked before the machine's host is asked for. Each route checks
// the member once when it starts (the tick, the machine and the path, live); the upload checks it again before it
// lands, and from the landing's call on the landing has won over a loss.
// - `GET /files/download`: one reader opened once (the path's last component not followed) and read as the browser asks
//   (ranges answered), so a file saved meanwhile never splices two revisions; released when the response ends (read
//   whole, a range, `HEAD`, 416, a disconnect), on a failure or a loss.
// - `PUT /files/upload`: the body streamed into a file staged beside the target (`MachineHost.stageFile`: a name of its
//   own, only the server's user reads it) and landed over the target once all of it came, keeping the replaced file's
//   permission bits; discarded on a failure, a refusal, a loss or a disconnect, and remembered meanwhile (with its
//   identity) so a crash's leftovers go (staging.ts), never a file that took their place. Two uploads of one name never
//   mix: each has its file, the last one landed wins whole.

import {
	BACKGROUND_CONTEXT,
	type Context,
	type Ctx,
	callerKey,
	contribute,
	type FacetHost,
	forbidden,
	isChordError,
	type P3Principal,
	type Reference,
	reportError,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import {
	type BinaryReader,
	type FileError,
	Http,
	type HttpRequest,
	type HttpResponse,
} from "@earendil-works/p3/v1/server";
import {
	type MachineHost,
	type MachineHostResolver,
	MachineHosts,
	machineAvailable,
	type StagedFile,
} from "../environments/contract.server.ts";
import { abortWhen, abortWhenLost, Gives } from "../things/contract.server.ts";
import { DOWNLOAD_PATH, Files, UPLOAD_PATH } from "./kind.ts";
import { must, placed, placedNew } from "./places.ts";
import { owned, StagingStore, serveStaging, sweep } from "./staging.ts";

/** How many bytes one upload carries at most. */
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

/** Serves the download and upload routes on `host`, and the staged files' store. */
export function serveTransfers(host: FacetHost<P3Principal>): void {
	serveStaging(host);
	contribute(host, "files.transfers", (self) => {
		const hosts = self.registry(MachineHosts);
		// Held by the routes, not by a request: a discard after the request's end still forgets its row.
		const staging = self.get(StagingStore, {});
		self.contribute(Http, {
			routes: {
				[`GET ${DOWNLOAD_PATH}`]: { handler: (request, ctx) => download(request, hosts.value, ctx) },
				[`PUT ${UPLOAD_PATH}`]: { handler: (request, ctx) => upload(request, hosts.value, staging, ctx) },
			},
		});
	});
}

/** What a route's query names: the Files thing in a workspace, a machine and a path on it. */
type Target = { readonly workspace: string; readonly thing: string; readonly machine: string; readonly path: string };

/**
 * A transfer as it starts: the person's Files, the machine's host, the signal its loss aborts, and `check`, which
 * throws once the loss came (also when the person's reference shows it before the signal's watch has seen it).
 */
type Transfer = {
	readonly files: Reference<typeof Files>;
	readonly at: MachineHost;
	readonly lost: AbortSignal;
	check(): void;
};

/** The bytes of the file the query names, or a refusal. */
async function download(request: HttpRequest, hosts: MachineHostResolver, ctx: Ctx): Promise<HttpResponse> {
	const target = targetOf(request);
	if (target === undefined) return { kind: "error", status: 400 };
	const transfer = await held(target, "open", hosts, ctx);
	if (transfer === undefined) return { kind: "error", status: 403 };
	const { files, at, lost } = transfer;
	const { path } = target;
	let reader: BinaryReader;
	try {
		await check(files, "open", target, ctx);
		reader = must(await at.env.openBinaryReader(await placed(at, path, ctx), { noFollow: true }, ctx));
	} catch (error) {
		return refused(error);
	}
	// Installed at once: every way the transfer ends (the scope's seal at the response's end, a loss) releases it.
	const release = once(() =>
		reader
			.close(BACKGROUND_CONTEXT)
			.catch((error: unknown) => reportError("files: a download's close", error, BACKGROUND_CONTEXT)),
	);
	whenAborted(lost, release);
	// One context for every read: the request's scope (the reads run in it) cut by the loss too.
	const reading = withAbortSignal(lost, ctx);
	try {
		const { size } = must(await reader.info(reading));
		transfer.check();
		return {
			kind: "bytes",
			mime: "application/octet-stream",
			size,
			ranges: true,
			download: path.slice(path.lastIndexOf("/") + 1),
			read: async (offset, length) => {
				try {
					transfer.check();
					// A loss cuts a read under way; what it read meanwhile is not the person's any more.
					const bytes = must(await reader.read(offset, length, reading));
					transfer.check();
					return bytes;
				} catch (error) {
					await release();
					throw error;
				}
			},
		};
	} catch (error) {
		await release();
		return refused(error);
	}
}

/** Puts the request's body at the path the query names, or refuses. */
async function upload(
	request: HttpRequest,
	hosts: MachineHostResolver,
	staging: Reference<typeof StagingStore>,
	ctx: Ctx,
): Promise<HttpResponse> {
	const target = targetOf(request);
	if (target === undefined) return { kind: "error", status: 400 };
	const transfer = await held(target, "upload", hosts, ctx);
	if (transfer === undefined) return { kind: "error", status: 403 };
	const { files, at, lost } = transfer;
	const { machine, path } = target;
	let folder: string;
	try {
		await check(files, "upload", target, ctx);
		const destination = await placedNew(at, path, ctx);
		folder = destination.slice(0, destination.lastIndexOf("/")) || "/";
		await sweep(at, machine, staging, ctx);
	} catch (error) {
		return refused(error);
	}
	const staged = await at.stageFile(folder, ctx);
	if (!staged.ok) return { kind: "error", status: statusOf(staged.error) };
	const job = owned(staged.value, machine, staging);
	// Installed at once: a loss discards the staged file without waiting for the next piece; the request's end too
	// (after a landing it removes nothing).
	whenAborted(lost, job.discard);
	try {
		await job.remembered;
		await received(request, staged.value, transfer, ctx);
		// The final path first, then the last check, then the landing with no wait between: from the landing's call on
		// it has won, and a loss after it removes nothing it landed.
		const destination = await placedNew(at, path, ctx);
		await check(files, "upload", target, ctx);
		transfer.check();
		await job.land(destination, ctx);
		return { kind: "json", value: {} };
	} catch (error) {
		await job.discard();
		// A loss is the refusal, whatever it cut (a write, a read of the body).
		if (lost.aborted) return { kind: "error", status: 403 };
		if (isChordError(error)) return refused(error);
		throw error;
	}
}

/** Calls `member` of the person's Files for `target`: the tick, the machine and the path checked as they are now. */
async function check(
	files: Reference<typeof Files>,
	member: "open" | "upload",
	{ machine, path }: Target,
	context: Context,
): Promise<void> {
	const call = files[member];
	if (call === undefined) throw gone();
	await call({ machine, path }, context);
}

/**
 * The transfer of `target` as the scope's person: their Files there with `member`, the machine's host, and a signal
 * aborted once the member or the machine's availability to them goes (or the scope ends); `undefined` when they have
 * neither now. Both are checked before the machine's host is asked for (it may connect), and again after.
 */
async function held(
	target: Target,
	member: "open" | "upload",
	hosts: MachineHostResolver,
	ctx: Ctx,
): Promise<Transfer | undefined> {
	const { workspace, thing, machine } = target;
	// The HTTP component's scope runs as p3's principal of the sign-in; Chord's type is its generic one.
	const principal = ctx.principal as P3Principal | undefined;
	if (principal?.kind !== "person") return undefined;
	// The request's scope is the person's: the reference is admitted as them, and held while the transfer runs.
	const files = await ctx.get(Files, { workspace, thing }).catch(() => undefined);
	if (files?.[member] === undefined) return undefined;
	const caller = { kind: "person", person: principal.id } as const;
	const answers = (await ctx.get(Gives, { workspace, caller: callerKey(principal) })).answers;
	const allowed = () => files[member] !== undefined && machineAvailable(caller, answers.value[machine]);
	if (!allowed()) return undefined;
	const at = await hosts(machine, ctx);
	if (at === undefined || !allowed()) return undefined;
	const lost = new AbortController();
	abortWhenLost(files, member, lost, ctx);
	abortWhen(answers, (given) => !machineAvailable(caller, given[machine]), lost, ctx);
	return {
		files,
		at,
		lost: lost.signal,
		check: () => {
			if (lost.signal.aborted || !allowed()) throw gone();
		},
	};
}

/**
 * Writes the body into `file`, piece by piece, until it ends; a loss stops it at once (one waiter on the loss, taken
 * off at the end). The body is let go on every way out: at once, or, when a read still waits (an async generator's
 * `return` waits for it), once that read settles, which the connection's end brings.
 */
async function received(request: HttpRequest, file: StagedFile, transfer: Transfer, context: Context): Promise<void> {
	const pieces = request.body(MAX_UPLOAD)[Symbol.asyncIterator]();
	let pending: Promise<IteratorResult<Uint8Array>> | undefined;
	let interrupt: ((error: unknown) => void) | undefined;
	const stop = () => interrupt?.(gone());
	transfer.lost.addEventListener("abort", stop, { once: true });
	// One context for every write: the request's cut by the loss too.
	const writing = withAbortSignal(transfer.lost, context);
	try {
		for (;;) {
			transfer.check();
			const next = pieces.next();
			pending = next;
			const piece = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
				interrupt = reject;
				next.then(resolve, reject);
			});
			pending = undefined;
			if (piece.done === true) return;
			transfer.check();
			must(await file.write(piece.value, writing));
		}
	} finally {
		transfer.lost.removeEventListener("abort", stop);
		interrupt = undefined;
		await letGo(pieces, pending);
	}
}

/** Ends `pieces` (its producer's cleanup runs): now, or after `pending`, the read that still waits, settles. */
async function letGo(
	pieces: AsyncIterator<Uint8Array>,
	pending: Promise<IteratorResult<Uint8Array>> | undefined,
): Promise<void> {
	const end = () => pieces.return?.().catch(() => undefined);
	if (pending === undefined) await end();
	else void pending.then(end, end);
}

/** `fn`, run once however often the answer is called; every call waits for that one run. */
function once(fn: () => Promise<void>): () => Promise<void> {
	let run: Promise<void> | undefined;
	return () => {
		run ??= fn();
		return run;
	};
}

/** Calls `fn` when `signal` aborts, at once when it has already. */
function whenAborted(signal: AbortSignal, fn: () => unknown): void {
	if (signal.aborted) void fn();
	else signal.addEventListener("abort", () => void fn(), { once: true });
}

/** The refusal of a transfer whose tick or machine went. */
function gone() {
	return forbidden("files: the transfer's tick or machine went");
}

/** The query's target, `undefined` when a part is missing (a trust boundary: the query is the browser's). */
function targetOf(request: HttpRequest): Target | undefined {
	const [workspace, thing, machine, path] = ["workspace", "thing", "machine", "path"].map((name) =>
		request.query.get(name),
	);
	if (!workspace || !thing || !machine || !path) return undefined;
	return { workspace, thing, machine, path };
}

/** A refusal as the route answers it: 403 for a refused caller, 404 for anything else (a path not there). */
function refused(error: unknown): HttpResponse {
	if (isChordError(error)) return { kind: "error", status: isChordError(error, "forbidden") ? 403 : 404 };
	throw error;
}

/** The status of a machine that could not stage a file: 403 refused, 404 its folder gone, 409 anything else. */
function statusOf(error: FileError): number {
	return error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : 409;
}
