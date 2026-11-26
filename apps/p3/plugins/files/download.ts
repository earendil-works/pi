// The download route (`GET /files/download`): a file's bytes for a browser, read through the person's own reference
// to Files in the workspace (decision 25: the stream holds it as the person). Every piece is one `read` call on that
// reference, so the stream ends at the first piece after Read is withheld, the person leaves the workspace or the
// machine stops being available to them there.

import { type Ctx, contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { Http, type HttpRequest, type HttpResponse } from "@earendil-works/p3/v1/server";
import { CHUNK, DOWNLOAD_PATH, Files } from "./contract.ts";

/** Serves the download route on `host`. */
export function serveDownload(host: FacetHost<P3Principal>): void {
	contribute(host, "files.download", (self) => {
		self.contribute(Http, { routes: { [`GET ${DOWNLOAD_PATH}`]: { handler: download } } });
	});
}

/** The route: the bytes of the file the query names, or a refusal. */
async function download(request: HttpRequest, ctx: Ctx): Promise<HttpResponse> {
	// A trust boundary: the query is the browser's.
	const [workspace, thing, machine, path] = ["workspace", "thing", "machine", "path"].map((name) =>
		request.query.get(name),
	);
	if (!workspace || !thing || !machine || !path) return { kind: "error", status: 400 };
	// The request's scope is the person's: the reference is admitted as them, and held while the body is read.
	const files = await ctx.get(Files, { workspace, thing }).catch(() => undefined);
	if (files?.read === undefined) return { kind: "error", status: 403 };
	const first = await files.read({ machine, path, offset: 0, length: 0 }, ctx).catch(() => undefined);
	if (first === undefined) return { kind: "error", status: 404 };
	return {
		kind: "bytes",
		mime: "application/octet-stream",
		size: first.size,
		download: path.slice(path.lastIndexOf("/") + 1),
		ranges: true,
		read: async (offset, length, pieceCtx) => {
			// The member as the reference has it now: a withheld Read takes it away.
			const now = files.read;
			if (now === undefined) throw new Error("files: Read was withheld");
			const piece = await now({ machine, path, offset, length: Math.min(length, CHUNK) }, pieceCtx);
			return Buffer.from(piece.data, "base64");
		},
	};
}
