// `GET /entry-image?session=…&conversation=…&entry=…&message=…&part=…`: one image of a conversation's entries, for
// whoever may view the session. The chat view carries references to them instead of their bytes
// (src/runtime/entry-images.ts); a page loads each image here when it shows it.
import { canView, contribute, defineFacet, ENTRY_IMAGE_PATH, withAbortSignal } from "@p2/app/v1";
import { type RouteHandler, Routes, sendJson, serverOf } from "@p2/app/v1/server";
import { ChatImages } from "./contract.ts";

/** Image types served as themselves; anything else goes out as bytes, never as a document a browser would run. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export default defineFacet((host) => {
	contribute(host, "p2.chat-image-routes", (self) => {
		const server = serverOf(self);
		const serve: RouteHandler = async (request, response, { principal }, outer) => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			if (!canView(principal, session) || request.headers["sec-fetch-site"] === "cross-site") {
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			/** The query's integer `name`, at least `min`; undefined when absent or malformed. */
			const integer = (name: string, min: number): number | undefined => {
				const value = Number(query.get(name) ?? "");
				return Number.isSafeInteger(value) && value >= min ? value : undefined;
			};
			const conversation = integer("conversation", 1);
			const entry = integer("entry", 1);
			const message = integer("message", 0);
			const part = integer("part", 0);
			if (conversation === undefined || entry === undefined || message === undefined || part === undefined) {
				sendJson(response, 400, { error: "Invalid image location" });
				return;
			}
			const abort = new AbortController();
			const closed = () => {
				if (!response.writableFinished) abort.abort(new Error("Disconnected"));
			};
			response.on("close", closed);
			try {
				// A root of the server's own (the worker answers only the server), ended by a disconnect.
				const image = await server().root(
					async (ctx) => {
						const images = await ctx.get(ChatImages, { session, conversation });
						return images.image({ entry, message, part }, ctx);
					},
					withAbortSignal(abort.signal, outer),
				);
				const body = Buffer.from(image.data, "base64");
				response.writeHead(200, {
					"Content-Type": IMAGE_TYPES.has(image.mimeType) ? image.mimeType : "application/octet-stream",
					"Content-Length": body.byteLength,
					// Entries never change once committed: the image at a place stays the same.
					"Cache-Control": "private, max-age=31536000, immutable",
					"Content-Security-Policy": "default-src 'none'; sandbox",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(request.method === "HEAD" ? undefined : body);
			} catch (error) {
				if (response.headersSent) response.destroy();
				else sendJson(response, 404, { error: error instanceof Error ? error.message : "No such image" });
			} finally {
				response.removeListener("close", closed);
			}
		};
		self.contribute(Routes, { [`GET ${ENTRY_IMAGE_PATH}`]: serve, [`HEAD ${ENTRY_IMAGE_PATH}`]: serve });
	});
});
