// Uploads (POST /upload) and download snapshots (GET /download) of a session's files, which live in the session's
// worker (its `Files`): the routes check who may upload or view and stream the bytes through `SessionFiles` as the
// server.
import { once } from "node:events";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import {
	type Ctx,
	canSend,
	canView,
	contribute,
	defineFacet,
	filePreview,
	signalOf,
	withAbortSignal,
} from "@p2/app/v1";
import { DownloadError, FILE_CHUNK, MAX_DOWNLOAD_BYTES } from "@p2/app/v1/node";
import { fromOrigin, type RequestAccess, Routes, sendJson, serverOf } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { DownloadStore, SessionFiles } from "./contract.ts";
import { MAX_UPLOAD_BYTES, UploadError } from "./uploads.ts";

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
		const catalog = self.get(Catalog, {});
		return {
			// A local object's method acts as the server: the session's worker answers it.
			save: async ({ session, path, name }, ctx) => {
				// An archived session's worker never starts: refused at once, never waited for.
				if ((await catalog.get({ id: session }, ctx)).archivedAt !== null)
					throw new DownloadError(409, "Session is archived");
				// NONBLOCK avoids hanging on a named pipe before fstat rejects non-regular sources.
				const source = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
					throw new DownloadError(400, "Could not open source file");
				});
				try {
					const stat = await source.stat();
					if (!stat.isFile()) throw new DownloadError(400, "Source must be a regular file");
					if (stat.size > MAX_DOWNLOAD_BYTES) throw new DownloadError(413, "File exceeds 25 MiB");
					const files = await ctx.get(SessionFiles, { session });
					const begun = await files.begin(
						{ space: "downloads", name: name ?? basename(path), source: "server" },
						ctx,
					);
					try {
						const buffer = Buffer.alloc(FILE_CHUNK);
						for (let offset = 0; ; ) {
							const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
							if (!bytesRead) break;
							if (offset + bytesRead > MAX_DOWNLOAD_BYTES) throw new DownloadError(413, "File exceeds 25 MiB");
							await files.append({ upload: begun.upload, offset, bytes: buffer.subarray(0, bytesRead) }, ctx);
							offset += bytesRead;
						}
						const saved = await files.finish(begun.upload, ctx);
						return { id: saved.id, name: saved.name, size: saved.size };
					} catch (error) {
						await files.cancel(begun.upload, ctx).catch(() => {});
						throw error;
					}
				} finally {
					await source.close();
				}
			},
		};
	});

	contribute(host, "p2.file-routes", (self) => {
		const catalog = self.get(Catalog, {});
		const server = serverOf(self);
		const upload = async (
			request: IncomingMessage,
			response: ServerResponse,
			{ principal, origin }: RequestAccess,
			outer: Ctx,
		): Promise<void> => {
			try {
				// A state-changing request: exactly same-origin (a cross-site form cannot send this Origin).
				if (!fromOrigin(request, origin)) throw new UploadError(403, "Invalid origin");
				const query = new URL(request.url ?? "/", "http://localhost").searchParams;
				const session = query.get("session") ?? "";
				if (!canSend(principal, session)) throw new UploadError(403, "Forbidden");
				const name = query.get("name") ?? "";
				if (!name || name.length > 255) throw new UploadError(400, "Invalid file name");
				const declared = Number(request.headers["content-length"] ?? Number.NaN);
				if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new UploadError(413, "File too large");
				const source = principal?.kind === "guest" ? `guest:${principal.id}` : "owner";
				// A root of the server's own (the worker's `SessionFiles` answers only the server).
				const uploaded = await server().root(async (ctx) => {
					// An archived session's worker never starts: refused at once, never waited for.
					const row = await catalog.get({ id: session }, ctx).catch(() => {
						throw new UploadError(400, "Unknown session");
					});
					if (row.archivedAt !== null) throw new UploadError(409, "Session is archived");
					const files = await ctx.get(SessionFiles, { session });
					const { upload } = await files.begin({ space: "uploads", name, source }, ctx);
					try {
						let offset = 0;
						for await (const value of request) {
							const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
							if (offset + chunk.length > MAX_UPLOAD_BYTES) throw new UploadError(413, "File too large");
							for (let start = 0; start < chunk.length; start += FILE_CHUNK) {
								const bytes = chunk.subarray(start, start + FILE_CHUNK);
								await files.append({ upload, offset, bytes }, ctx);
								offset += bytes.length;
							}
						}
						return await files.finish(upload, ctx);
					} catch (error) {
						await files.cancel(upload, ctx).catch(() => {});
						throw error;
					}
				}, outer);
				sendJson(response, 200, uploaded);
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
			outer: Ctx,
		): Promise<void> => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			// A cross-site page may link here, but never with the owner's or a guest's access.
			if (request.headers["sec-fetch-site"] === "cross-site" || !canView(principal, session)) {
				response.writeHead(403, { "Content-Type": "text/plain" });
				response.end("Forbidden");
				return;
			}
			const abort = new AbortController();
			const closed = () => {
				if (!response.writableFinished) abort.abort(new Error("Disconnected"));
			};
			response.on("close", closed);
			try {
				await server().root(
					async (ctx) => {
						// An unknown or archived session (whose worker never starts) is a 404 at once, never waited for.
						const row = await catalog.get({ id: session }, ctx).catch(() => undefined);
						if (row === undefined || row.archivedAt !== null) throw new DownloadError(404, "File not found");
						const files = await ctx.get(SessionFiles, { session });
						const found = await files.download(query.get("id") ?? "", ctx);
						if (found === null) throw new DownloadError(404, "File not found");
						const { name, size } = found;
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
						if (request.method === "HEAD" || size === 0) {
							response.end();
							return;
						}
						for (let offset = start; offset <= end; ) {
							const length = Math.min(FILE_CHUNK, end - offset + 1);
							const bytes = await files.read({ file: found.file, offset, length }, ctx);
							if (!bytes.length) throw new Error("File changed during transfer");
							if (!response.write(bytes)) await once(response, "drain", { signal: signalOf(ctx) });
							offset += bytes.length;
						}
						response.end();
					},
					withAbortSignal(abort.signal, outer),
				);
			} catch (error) {
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(error instanceof DownloadError ? error.status : 404, {
						"Content-Type": "text/plain",
					});
					response.end("File not found");
				}
			} finally {
				response.removeListener("close", closed);
			}
		};
		self.contribute(Routes, {
			"POST /upload": upload,
			"GET /download": download,
			"HEAD /download": download,
		});
	});
});
