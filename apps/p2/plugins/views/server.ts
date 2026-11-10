// Views (server): the owner's library of saved views, and `/view-frame`, which serves a custom view's HTML into its
// sandboxed frame with the bridge (`bridge.ts`) and the artifacts' diagnostics on top.
import { arr, nullable, obj, str } from "@earendil-works/pi-schema";
import { canView, contribute, defineFacet, followNative, forbidden, isOwner, local, method } from "@p2/app/v1";
import { type RouteHandler, Routes, Server, serverOf } from "@p2/app/v1/server";
import { instrumentArtifact } from "../artifacts/store.ts";
import { Catalog } from "../sessions/contract.ts";
import { VIEW_BRIDGE_SCRIPT } from "./bridge.ts";
import { SavedInfoSchema, SavedViewSchema, SavedViews, VIEW_ID, ViewSource } from "./contract.ts";
import { Library } from "./library.ts";

/** The library (server-internal, one per server): every principal's `SavedViews` shares it. */
const ViewLibrary = local("p2.view-library", {
	version: 1,
	params: {},
	members: {
		saved: arr(SavedInfoSchema),
		get: method(obj({ name: str({ pattern: VIEW_ID.source }) }), nullable(SavedViewSchema)),
		save: method(SavedViewSchema, SavedInfoSchema),
		remove: method(obj({ name: str({ pattern: VIEW_ID.source }) })),
	},
});

/** As the artifacts' previews: scripts, but no app origin, no frames, forms or plugins. */
const FRAME_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-modals allow-pointer-lock";

export default defineFacet((host) => {
	host.serve(ViewLibrary, (_params, self) => {
		const server = self.get(Server, {});
		const library = self.open(
			async () => {
				const opened = new Library(server.info.value.dataDir);
				await opened.load();
				return opened;
			},
			() => {},
		);
		return {
			saved: followNative(
				self,
				(changed) => library.value.subscribe(changed),
				() => library.value.saved,
			),
			get: ({ name }) => library.value.get(name),
			save: (view) => library.value.save(view),
			remove: async ({ name }) => {
				await library.value.remove(name);
				return null;
			},
		};
	});

	host.serve(SavedViews, (_params, principal, self) => {
		const library = self.get(ViewLibrary, {});
		if (isOwner(principal))
			return {
				variant: "owner",
				members: { saved: library.saved, remove: (args, ctx) => library.remove(args, ctx) },
			};
		if (principal.kind !== "worker") throw forbidden("saved views are the owner's");
		return {
			variant: "worker",
			members: {
				list: async () => [...library.saved.value],
				get: (args, ctx) => library.get(args, ctx),
				save: (view, ctx) => library.save(view, ctx),
			},
		};
	});

	contribute(host, "p2.view-frames", (self) => {
		const server = serverOf(self);
		const catalog = self.get(Catalog, {});
		const serve: RouteHandler = async (request, response, { principal, origin }, outer) => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			if (!canView(principal, session) || request.headers["sec-fetch-site"] === "cross-site") {
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			const view = query.get("view") ?? "";
			const version = Number(query.get("version"));
			try {
				if (!VIEW_ID.test(view) || !Number.isSafeInteger(version) || version < 1) throw new Error("invalid");
				// The bytes are the session worker's, read in a root of the server's own after the viewer was authorized.
				const source = await server().root(async (ctx) => {
					const row = await catalog.get({ id: session }, ctx).catch(() => undefined);
					if (row === undefined || row.archivedAt !== null) throw new Error("unknown session");
					return (await ctx.get(ViewSource, { session })).read({ view, version }, ctx);
				}, outer);
				const html = instrumentArtifact(
					{ name: view, title: source.title, type: "html", version },
					injectBridge(source.html),
				);
				const body = Buffer.from(html, "utf8");
				response.writeHead(200, {
					"Content-Security-Policy": `${FRAME_CSP}; frame-ancestors 'self'${
						origin.relayShellOrigin === undefined ? "" : ` ${origin.relayShellOrigin}`
					}`,
					"Content-Type": "text/html; charset=utf-8",
					"Content-Length": body.byteLength,
					"Cross-Origin-Resource-Policy": "same-origin",
					// Versions are immutable, but a closed and reopened view reuses its ID: never cache.
					"Cache-Control": "no-store",
				});
				response.end(request.method === "HEAD" ? undefined : body);
			} catch {
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(404);
					response.end("View not found");
				}
			}
		};
		self.contribute(Routes, { "GET /view-frame": serve, "HEAD /view-frame": serve });
	});
});

/** `html` with the bridge's script first in its head (or first of all without one). */
function injectBridge(html: string): string {
	const script = `<script>${VIEW_BRIDGE_SCRIPT}</script>`;
	const head = /<head(?:\s[^>]*)?>/i.exec(html);
	if (head) return `${html.slice(0, head.index + head[0].length)}${script}${html.slice(head.index + head[0].length)}`;
	return `${script}${html}`;
}
