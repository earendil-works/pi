import { canView, contribute, defineFacet } from "@p2/app/v1";
import { type RouteHandler, Routes, Server } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { ArtifactError, Artifacts, instrumentArtifact } from "./store.ts";

const EXECUTABLE_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-modals allow-pointer-lock";
const DOCUMENT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

export default defineFacet((host) => {
	contribute(host, "p2.artifact-routes", (self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const artifacts = self.open(
			async () => new Artifacts(server.info.value.dataDir),
			() => {},
		);
		const serve: RouteHandler = async (request, response, { principal }, ctx) => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const session = query.get("session") ?? "";
			if (!canView(principal, session) || request.headers["sec-fetch-site"] === "cross-site") {
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			try {
				await catalog.get({ id: session }, ctx);
				const artifact = await artifacts.value.read(session, query.get("name") ?? "", Number(query.get("version")));
				const download = query.get("download") === "1";
				const executable = artifact.info.type === "html" || artifact.info.type === "svg";
				const body = Buffer.from(
					executable && !download ? instrumentArtifact(artifact.info, artifact.content) : artifact.content,
					"utf8",
				);
				const extension =
					artifact.info.type === "markdown" ? "md" : artifact.info.type === "text" ? "txt" : artifact.info.type;
				response.writeHead(200, {
					"Content-Security-Policy": executable ? EXECUTABLE_CSP : DOCUMENT_CSP,
					"Content-Type":
						artifact.info.type === "html"
							? "text/html; charset=utf-8"
							: artifact.info.type === "svg"
								? "image/svg+xml; charset=utf-8"
								: "text/plain; charset=utf-8",
					"Content-Length": body.byteLength,
					"Content-Disposition": download ? `attachment; filename="${artifact.info.name}.${extension}"` : "inline",
					"Cross-Origin-Resource-Policy": "same-origin",
				});
				response.end(request.method === "HEAD" ? undefined : body);
			} catch (error) {
				if (response.headersSent) response.destroy();
				else {
					response.writeHead(error instanceof ArtifactError ? error.status : 404);
					response.end("Artifact not found");
				}
			}
		};
		self.contribute(Routes, { "GET /artifact": serve, "HEAD /artifact": serve });
	});
});
