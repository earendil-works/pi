// The attach route (`GET /terminals/attach`): a terminal's bytes for a browser, raw, held as the person (decision 25):
// the request's scope holds the person's own reference to Terminals in the workspace. The body is the terminal's kept
// output, then each piece as it comes (at most `TERMINAL_FRAME` bytes a read, paced by the consumer: one that falls
// behind skips to the oldest byte kept), until the terminal ends or closes, the person disconnects, loses Watch and
// Use, or the terminal leaves their list (they left the workspace, its machine is no longer available to them there):
// the stream holds both, live, and a loss ends it at once, a read under way included.

import {
	type Ctx,
	contribute,
	type FacetHost,
	isChordError,
	type P3Principal,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest, type HttpResponse } from "@earendil-works/p3/v1/server";
import { type TerminalHost, TerminalHosts } from "../environments/contract.terminal-host.server.ts";
import { abortWhen, abortWhenLost } from "../things/contract.server.ts";
import { ATTACH_PATH, Terminals } from "./kind.ts";

/** Serves the attach route on `host`. */
export function serveAttach(host: FacetHost<P3Principal>): void {
	contribute(host, "terminals.attach", (self) => {
		const terminals = self.registry(TerminalHosts);
		self.contribute(Http, {
			routes: { [`GET ${ATTACH_PATH}`]: { handler: (request, ctx) => attach(request, terminals.value, ctx) } },
		});
	});
}

/** The end of the body, one value. */
const END = new Uint8Array();

/** The bytes of the terminal the query names, or a refusal. */
async function attach(request: HttpRequest, terminals: TerminalHost | undefined, ctx: Ctx): Promise<HttpResponse> {
	// A trust boundary: the query is the browser's.
	const [workspace, thing, terminal] = ["workspace", "thing", "terminal"].map((name) => request.query.get(name));
	if (!workspace || !thing || !terminal) return { kind: "error", status: 400 };
	const ref = await ctx.get(Terminals, { workspace, thing }).catch(() => undefined);
	if (ref?.attach === undefined || ref.terminals === undefined || terminals === undefined) {
		return { kind: "error", status: 403 };
	}
	try {
		await ref.attach({ terminal }, ctx);
	} catch (error) {
		return { kind: "error", status: isChordError(error, "forbidden") ? 403 : 404 };
	}
	const lost = new AbortController();
	const list = ref.terminals;
	abortWhenLost(ref, "attach", lost, ctx);
	abortWhen(list, (rows) => !rows.some((row) => row.id === terminal), lost, ctx);
	let from = 0;
	// One context for every read: the request's scope (the reads run in it) cut by the loss too.
	const reading = withAbortSignal(lost.signal, ctx);
	return {
		kind: "bytes",
		mime: "application/octet-stream",
		read: async () => {
			if (lost.signal.aborted) return END;
			try {
				const next = await terminals.next(terminal, from, reading);
				// A loss while the read waited ends the body: what came meanwhile is not the person's anymore.
				if (lost.signal.aborted) return END;
				from = next.from + next.bytes.length;
				if (next.bytes.length === 0) lost.abort();
				return next.bytes;
			} catch (error) {
				if (lost.signal.aborted) return END;
				throw error;
			}
		},
	};
}
