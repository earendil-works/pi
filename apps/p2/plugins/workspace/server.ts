import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { canSend, contribute, defineFacet, filePreview, signalOf } from "@p2/app/v1";
import { fromOrigin, type RouteHandler, Routes, sendJson, serverOf } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { WorkspaceTransfer } from "./contract.ts";
import { WORKSPACE_DOWNLOAD_LIMIT, WORKSPACE_READ_CHUNK, workspacePath } from "./protocol.ts";

export default defineFacet((host) => {
	contribute(host, "p2.workspace-routes", (self) => {
		const catalog = self.get(Catalog, {});
		const server = serverOf(self);
		const serve: RouteHandler = async (request, response, { principal, origin }, outer) => {
			const params = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = params.get("session") ?? "";
			const uploading = request.method === "POST";
			if (
				!canSend(principal, session) ||
				request.headers["sec-fetch-site"] === "cross-site" ||
				(uploading && !fromOrigin(request, origin))
			) {
				request.resume();
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			const abort = new AbortController();
			const closed = () => {
				if (!response.writableFinished) abort.abort(new Error("Disconnected"));
			};
			response.on("close", closed);
			try {
				// A root of the server's own (the worker answers only the server), ended by a disconnect.
				await server().root(
					async (ctx) => {
						const info = await catalog.get({ id: session }, ctx);
						if (info.archivedAt !== null) throw new Error("Session is archived");
						const conversation = Number(params.get("conversation") ?? "1");
						const path = workspacePath(params.get("path") ?? "");
						if (path === undefined || !Number.isSafeInteger(conversation) || conversation < 1)
							throw new Error("Invalid workspace location");
						const transfer = await ctx.get(WorkspaceTransfer, { session, conversation });
						if (uploading) {
							const name = params.get("name") ?? "";
							if (!name || name.length > 255 || name.includes("/") || workspacePath(name) === undefined)
								throw new Error("Invalid file name");
							const token = randomUUID();
							let offset = 0;
							try {
								for await (const value of request) {
									const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
									if (offset + chunk.length > WORKSPACE_DOWNLOAD_LIMIT)
										throw new Error("Upload exceeds 25 MiB");
									for (let start = 0; start < chunk.length; start += WORKSPACE_READ_CHUNK) {
										const data = chunk.subarray(start, start + WORKSPACE_READ_CHUNK);
										await transfer.write(
											{
												path,
												name,
												token,
												offset,
												data: data.toString("base64"),
												final: false,
											},
											ctx,
										);
										offset += data.length;
									}
								}
								await transfer.write({ path, name, token, offset, data: "", final: true }, ctx);
							} catch (error) {
								// Cleanup has its own uncancelled root after a disconnect.
								await server()
									.root(async (cleanup) =>
										(await cleanup.get(WorkspaceTransfer, { session, conversation })).write(
											{ path, name, token, offset, data: "", final: false, abort: true },
											cleanup,
										),
									)
									.catch(() => {});
								throw error;
							}
							sendJson(response, 200, { path: path ? `${path}/${name}` : name, size: offset });
							return;
						}
						if (!path) throw new Error("Invalid file path");
						const preview = filePreview(path);
						const media = preview?.kind === "audio" || preview?.kind === "video";
						const header = media ? request.headers.range : undefined;
						const match = header === undefined ? undefined : /^bytes=(\d*)-(\d*)$/.exec(header);
						if (header !== undefined && (!match || (!match[1] && !match[2]))) {
							response.writeHead(416);
							response.end();
							return;
						}
						const range = match
							? match[1]
								? { start: Number(match[1]), ...(match[2] ? { end: Number(match[2]) } : {}) }
								: { suffix: Number(match[2]) }
							: {};
						if (
							Object.values(range).some((n) => !Number.isSafeInteger(n) || n < 0) ||
							("suffix" in range && range.suffix === 0) ||
							("end" in range && range.end !== undefined && range.end < (range.start ?? 0))
						) {
							response.writeHead(416);
							response.end();
							return;
						}
						let chunk = await transfer.read({ path, ...range }, ctx);
						const size = chunk.size;
						const start = chunk.start;
						const end = Math.min("end" in range ? (range.end ?? size - 1) : size - 1, size - 1);
						if (header !== undefined && (!size || start >= size || end < start)) {
							response.writeHead(416, { "Content-Range": `bytes */${size}` });
							response.end();
							return;
						}
						// As Pi Mobile: a whole file over 25 MiB is refused (media players page through ranges instead).
						if (!header && size > WORKSPACE_DOWNLOAD_LIMIT) {
							response.writeHead(413, { "Content-Type": "text/plain" });
							response.end("File too large");
							return;
						}
						const name = path.split("/").at(-1)!;
						// Only media keeps its type (for the viewer's image, audio and video elements); anything else is an
						// opaque download, never a document the browser renders.
						const typed = preview?.kind === "image" || media;
						response.writeHead(header ? 206 : 200, {
							"Content-Type": typed
								? (preview?.mimeType ?? "application/octet-stream")
								: "application/octet-stream",
							"Content-Length": size === 0 ? 0 : end - start + 1,
							"Content-Disposition": `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
							"Accept-Ranges": media ? "bytes" : "none",
							"Content-Security-Policy": "default-src 'none'; sandbox",
							"Cross-Origin-Resource-Policy": "same-origin",
							...(header ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
						});
						if (request.method === "HEAD" || !size) {
							response.end();
							return;
						}
						let offset = start;
						while (offset <= end) {
							const bytes = Buffer.from(chunk.data, "base64");
							if (!bytes.length) throw new Error("File changed during transfer");
							if (!response.write(bytes)) await once(response, "drain", { signal: signalOf(ctx) });
							offset += bytes.length;
							if (offset <= end) chunk = await transfer.read({ path, start: offset, end }, ctx);
						}
						response.end();
					},
					AbortSignal.any([abort.signal, signalOf(outer)]),
				);
			} catch (error) {
				request.resume();
				if (response.headersSent) response.destroy();
				else {
					sendJson(response, uploading ? 400 : 404, {
						error: error instanceof Error ? error.message : "Workspace request failed",
					});
				}
			} finally {
				response.removeListener("close", closed);
			}
		};
		self.contribute(Routes, {
			"GET /workspace-file": serve,
			"HEAD /workspace-file": serve,
			"POST /workspace-upload": serve,
		});
	});
});
