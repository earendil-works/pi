// The server's base pieces that a test topology shares with the real server: the base's facet (the registries it
// serves) and the admission of the route to session workers.

import {
	type Address,
	type AdmitSelf,
	allow,
	defineFacet,
	deny,
	type Facet,
	orderedEntries,
} from "@earendil-works/chord";
import type { Session } from "@earendil-works/p3/v1";
import { LinkOpened, ServerRuntime, SessionRoute, WorkerRunners } from "@earendil-works/p3/v1/server";
import type { P3Principal } from "./principals.ts";

/**
 * The base's facet: it serves `ServerRuntime` (the process values), `WorkerRunners` (the first runner by plugin name) and
 * `LinkOpened` (every hook called, in plugin order).
 */
export function serverCoreFacet(runtime: ServerRuntime): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) => {
		host.serve(ServerRuntime, { compose: () => runtime });
		host.serve(WorkerRunners, { compose: (table) => table[0]?.value });
		host.serve(LinkOpened, {
			compose: (table) => {
				const hooks = orderedEntries(table, (hook) => [hook]);
				return (request, close) => {
					const ends = hooks.map(({ value }) => value(request, close)).filter((end) => end !== undefined);
					if (ends.length === 0) return undefined;
					return () => {
						for (const end of ends) end();
					};
				};
			},
		});
	});
}

/**
 * The route's admission: a session's worker is reached only while the session exists (the sessions plugin's
 * `SessionRoute`), and never by another session's worker.
 */
export function admitSession(principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	const route = self.get(SessionRoute, { session: address.params.id });
	return self.derive([route.exists], ([exists]) =>
		principal.kind !== "worker" && exists ? allow(null) : deny("no such session"),
	);
}
