// `/glyph.svg?seed=<path or name>[&size=<px>]`: a project glyph as an SVG file, for embedding (`<img src>`) where the
// sidebar's inline glyph is not available. Open to everyone, on purpose: the glyph is a pure function of the query and
// reads no data, so it tells a visitor nothing they did not send; the seed's length bounds the work.
import { contribute, defineFacet } from "@p2/app/v1";
import { type RouteHandler, Routes } from "@p2/app/v1/server";
import { glyphOf, glyphSvg } from "./glyph.ts";

const MAX_SEED = 1024;

export default defineFacet((host) => {
	contribute(host, "p2.glyph-routes", (self) => {
		const serve: RouteHandler = (request, response) => {
			const query = new URL(request.url ?? "/", "http://localhost").searchParams;
			const seed = query.get("seed");
			const size = Number(query.get("size") ?? 64);
			if (seed === null || seed.length > MAX_SEED || !Number.isInteger(size) || size < 8 || size > 1024) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Expected ?seed=<at most 1024 characters>&size=<8 to 1024>\n");
				return;
			}
			const body = Buffer.from(glyphSvg(glyphOf(seed), size), "utf8");
			response.writeHead(200, {
				"Content-Type": "image/svg+xml; charset=utf-8",
				"Content-Length": body.byteLength,
				// A seed's glyph is fixed for this algorithm (`glyph-v1`); a day bounds how long one lingers after a change.
				"Cache-Control": "public, max-age=86400",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"X-Content-Type-Options": "nosniff",
				"Cross-Origin-Resource-Policy": "cross-origin",
			});
			response.end(request.method === "HEAD" ? undefined : body);
		};
		self.contribute(Routes, { "GET /glyph.svg": serve, "HEAD /glyph.svg": serve });
	});
});
