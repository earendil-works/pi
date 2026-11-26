// Files' two routes, a file's bytes to and from a browser, each held as the person (decision 25): the request's scope
// holds the person's own reference to Files in the workspace, and every piece asks it again (`open` or `upload`, which
// check the tick, the machine and the path live), so a transfer ends at the next piece after the tick is withheld, the
// person leaves the workspace or the machine stops being available to them there.
// - `GET /files/download`: one reader opened once (the path's last component not followed) and read to the end, so a
//   file saved meanwhile never splices two revisions; closed at the end, on a failure, a refusal or a disconnect.
// - `PUT /files/upload`: the body streamed into a new file beside the target, created exclusively under a name of its
//   own (`MachineHost.createFile`), moved over the target once all of it came; removed on a failure, a refusal or a
//   disconnect. Two uploads of one name never mix: each has its file, the last one moved wins whole.

import {
	BACKGROUND_CONTEXT,
	type Ctx,
	contribute,
	type FacetHost,
	forbidden,
	isChordError,
	type P3Principal,
} from "@earendil-works/p3/v1";
import { type BinaryReader, Http, type HttpRequest, type HttpResponse } from "@earendil-works/p3/v1/server";
import { type MachineHostResolver, MachineHosts } from "../environments/contract.server.ts";
import { DOWNLOAD_PATH, Files, UPLOAD_PATH } from "./contract.ts";
import { must, placed, placedNew } from "./places.ts";

/** How many bytes one upload carries at most. */
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

/** Serves the download and upload routes on `host`. */
export function serveTransfers(host: FacetHost<P3Principal>): void {
	contribute(host, "files.transfers", (self) => {
		const hosts = self.registry(MachineHosts);
		self.contribute(Http, {
			routes: {
				[`GET ${DOWNLOAD_PATH}`]: { handler: (request, ctx) => download(request, hosts.value, ctx) },
				[`PUT ${UPLOAD_PATH}`]: { handler: (request, ctx) => upload(request, hosts.value, ctx) },
			},
		});
	});
}

/** What a route's query names: the Files thing in a workspace, a machine and a path on it. */
type Target = { readonly workspace: string; readonly thing: string; readonly machine: string; readonly path: string };

/** The bytes of the file the query names, or a refusal. */
async function download(request: HttpRequest, hosts: MachineHostResolver, ctx: Ctx): Promise<HttpResponse> {
	const target = targetOf(request);
	if (target === undefined) return { kind: "error", status: 400 };
	const { workspace, thing, machine, path } = target;
	// The request's scope is the person's: the reference is admitted as them, and held while the body is read.
	const files = await ctx.get(Files, { workspace, thing }).catch(() => undefined);
	const at = await hosts(machine, ctx);
	if (files?.open === undefined || at === undefined) return { kind: "error", status: 403 };
	const check = async (context: Ctx) => {
		const open = files.open;
		if (open === undefined) throw forbidden("files: Browse was withheld");
		await open({ machine, path }, context);
	};
	let reader: BinaryReader;
	let size: number;
	try {
		await check(ctx);
		reader = must(await at.env.openBinaryReader(await placed(at, path, ctx), { noFollow: true }, ctx));
		size = must(await reader.info(ctx)).size;
	} catch (error) {
		return refused(error);
	}
	let open = true;
	// The scope's own context is aborted by then: the close needs one that is not.
	const close = () => {
		if (!open) return;
		open = false;
		void reader.close(BACKGROUND_CONTEXT);
	};
	ctx.abortSignal?.addEventListener("abort", close, { once: true });
	// Nothing will be read (an empty file, `HEAD`).
	if (size === 0 || request.method === "HEAD") close();
	return {
		kind: "bytes",
		mime: "application/octet-stream",
		size,
		download: path.slice(path.lastIndexOf("/") + 1),
		read: async (offset, length, pieceCtx) => {
			try {
				await check(pieceCtx);
				const bytes = must(await reader.read(offset, length, pieceCtx));
				if (offset + bytes.length >= size) close();
				return bytes;
			} catch (error) {
				close();
				throw error;
			}
		},
	};
}

/** Puts the request's body at the path the query names, or refuses. */
async function upload(request: HttpRequest, hosts: MachineHostResolver, ctx: Ctx): Promise<HttpResponse> {
	const target = targetOf(request);
	if (target === undefined) return { kind: "error", status: 400 };
	const { workspace, thing, machine, path } = target;
	const files = await ctx.get(Files, { workspace, thing }).catch(() => undefined);
	const at = await hosts(machine, ctx);
	if (files?.upload === undefined || at === undefined) return { kind: "error", status: 403 };
	const check = async () => {
		const send = files.upload;
		if (send === undefined) throw forbidden("files: Edit was withheld");
		await send({ machine, path }, ctx);
	};
	let destination: string;
	try {
		await check();
		destination = await placedNew(at, path, ctx);
	} catch (error) {
		return refused(error);
	}
	const slash = destination.lastIndexOf("/");
	const partial = `${destination.slice(0, slash)}/.${destination.slice(slash + 1)}.${crypto.randomUUID()}.p3-upload`;
	const file = await at.createFile(partial, ctx).catch(() => undefined);
	if (file === undefined) return { kind: "error", status: 409 };
	let written = false;
	let landed = false;
	try {
		for await (const chunk of request.body(MAX_UPLOAD)) {
			// Read at each piece: a withheld Edit stops the upload here.
			if (files.upload === undefined) throw forbidden("files: Edit was withheld");
			await file.write(chunk, ctx);
		}
		written = true;
		await file.close(ctx);
		await check();
		must(await at.env.renameFile(partial, destination, ctx));
		landed = true;
		return { kind: "json", value: {} };
	} catch (error) {
		if (isChordError(error)) return refused(error);
		throw error;
	} finally {
		// The scope's context may be aborted (a disconnect): the cleanup needs one that is not.
		if (!written) await file.close(BACKGROUND_CONTEXT).catch(() => undefined);
		if (!landed) await at.env.remove(partial, { force: true }, BACKGROUND_CONTEXT);
	}
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
	return { kind: "error", status: isChordError(error, "forbidden") ? 403 : 404 };
}
