// The owner's stop over HTTP: `POST /_p3/stop`, for the owner only (the `p3 stop` command signs in with the owner
// token file), answered first; then the server closes as on `SIGTERM`. A command needs no signal for it, so it stops a
// server whose process it cannot identify (no `ps`) or may not signal.

import { defineFacet, type Facet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";
import type { P3Principal } from "../principals.ts";

/** The path the owner posts to for the server to stop. */
export const STOP_PATH = "/_p3/stop";

/**
 * The kit's facet for the owner's stop: `POST /_p3/stop` answers the owner `"stopping"`, then calls `stop` (the start
 * script's close, as on `SIGTERM`); anyone else gets 403 (401 without a sign-in, as every route that is not public).
 */
export function stopFacet(stop: () => void): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`POST ${STOP_PATH}`]: {
					handler: async (_request, ctx) => {
						if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
						// After the answer: the close drains running requests, this one written by then.
						setImmediate(stop);
						return { kind: "json", value: "stopping" };
					},
				},
			},
		}),
	);
}
