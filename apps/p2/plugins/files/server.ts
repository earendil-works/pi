// Uploads (POST /upload) and download snapshots (GET /download) of a session's files.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { type Ctx, canSend, canView, contribute, defineFacet, filePreview } from "@p2/app/v1";
import { DownloadError, Downloads } from "@p2/app/v1/node";
import { fromOrigin, type RequestAccess, Routes, Server, sendJson } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { DownloadStore } from "./contract.ts";
import { MAX_UPLOAD_BYTES, UploadError, Uploads } from "./uploads.ts";

/** Registers the upload and download routes. */

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The requested byte range of a seekable (audio/video) file, `undefined` for all of it, or "invalid". */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
	if (header === undefined || size === 0) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match) return "invalid";
	let start = 0;
	let end = size - 1;
	if (match[1]) start = Number(match[1]);
	if (!match[1] && match[2]) start = Math.max(0, size - Number(match[2]));
	else if (match[2]) end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
		return "invalid";
	return { start, end: Math.min(end, size - 1) };
}

export default defineFacet((host) => {
	host.serve(DownloadStore, (_params, self) => {
		const server = self.get(Server, {});
		const downloads = self.open(
			async () => new Downloads(server.info.value.dataDir),
			() => {},
		);
		return {
			save: ({ session, path, name }) => downloads.value.save(session, path, name),
		};
	});

	contribute(host, "p2.file-routes", (self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const uploads = self.open(
			async () => new Uploads(server.info.value.dataDir),
			() => {},
		);
		const downloads = self.open(
			async () => new Downloads(server.info.value.dataDir),
			() => {},
		);
		const upload = async (
			request: IncomingMessage,
			response: ServerResponse,
			{ principal, origin }: RequestAccess,
			ctx: Ctx,
		): Promise<void> => {
			try {
				// A state-changing request: exactly same-origin (a cross-site form cannot send this Origin).
				if (!fromOrigin(request, origin)) throw new UploadError(403, "Invalid origin");
				const query = new URL(request.url ?? "/", "http://localhost").searchParams;
				const session = query.get("session") ?? "";
				if (!canSend(principal, session)) throw new UploadError(403, "Forbidden");
				await catalog.get({ id: session }, ctx).catch(() => {
					throw new UploadError(400, "Unknown session");
				});
				const name = query.get("name") ?? "";
				if (!name || name.length > 255) throw new UploadError(400, "Invalid file name");
				sendJson(response, 200, await uploads.value.save(session, name, request));
			} catch (error) {
				request.resume();
				sendJson(response, error instanceof UploadError ? error.status : 400, {
					error: errorMessage(error),
					limit: MAX_UPLOAD_BYTES,
				});
			}
		};
		const download = async (
			request: IncomingMessage,
			response: ServerResponse,
			{ principal }: RequestAccess,
			ctx: Ctx,
		): Promise<void> => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			// A cross-site page may link here, but never with the owner's or a guest's access.
			if (request.headers["sec-fetch-site"] === "cross-site" || !canView(principal, session)) {
				response.writeHead(403, { "Content-Type": "text/plain" });
				response.end("Forbidden");
				return;
			}
			let file: Awaited<ReturnType<Downloads["open"]>> | undefined;
			try {
				await catalog.get({ id: session }, ctx);
				file = await downloads.value.open(session, query.get("id") ?? "");
				const { name, size } = file.info;
				const preview = filePreview(name);
				const seekable = preview?.kind === "audio" || preview?.kind === "video";
				const range = seekable ? byteRange(request.headers.range, size) : undefined;
				if (range === "invalid") {
					response.writeHead(416, { "Content-Range": `bytes */${size}` });
					response.end();
					return;
				}
				const { start, end } = range ?? { start: 0, end: Math.max(0, size - 1) };
				const ascii = name.replace(/[^\x20-\x7e]/g, "_");
				response.writeHead(range ? 206 : 200, {
					"Content-Type": preview?.mimeType ?? "application/octet-stream",
					"Content-Length": size === 0 ? 0 : end - start + 1,
					"Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
					"Accept-Ranges": seekable ? "bytes" : "none",
					...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
				});
				if (request.method === "HEAD" || size === 0) response.end();
				else await pipeline(file.handle.createReadStream({ start, end, autoClose: false }), response);
			} catch (error) {
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(error instanceof DownloadError ? error.status : 404, {
						"Content-Type": "text/plain",
					});
					response.end("File not found");
				}
			} finally {
				await file?.handle.close();
			}
		};
		self.contribute(Routes, {
			"POST /upload": upload,
			"GET /download": download,
			"HEAD /download": download,
		});
	});
});
