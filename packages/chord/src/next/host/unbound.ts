// The unbound index (dependency model §1, §4): the requests a host decided cannot bind yet, by the name they wait for.
// Before the host's first publication every request made here, and every hold arriving on its links, waits here
// (`unpublished`); after it, those its check left unbound (`not_served`, `version`): a reference made here, a hold that
// arrived over a link and was refused for a name. A publication wakes the requests of the names it serves; a request
// leaves when it ends (released, settled, given up, its link or origin closed, revoked) or binds.

import type { ChordError, Principal } from "../data/index.ts";

/** A request in the index: a reference made here or a hold that arrived over a link. */
export interface UnboundRequest {
	/** Whom it acts for: revocation ends the requests of a revoked principal. */
	readonly principal: Principal | undefined;
	/** The name it waits for became usable (or the host published): it runs its check again, leaving the index first. */
	wake(): void;
	/** It is revoked, or its host closes: it ends with `error` (a hold sends `gone`), leaving the index. */
	end(error: ChordError): void;
}

/** A host's unbound requests by name. */
export class UnboundIndex {
	readonly #byName = new Map<string, Set<UnboundRequest>>();

	/** Indexes `request` under `name` (once; again after a wake). */
	add(name: string, request: UnboundRequest): void {
		let requests = this.#byName.get(name);
		if (requests === undefined) {
			requests = new Set();
			this.#byName.set(name, requests);
		}
		requests.add(request);
	}

	/** `request` ended or binds: it leaves the index. */
	delete(name: string, request: UnboundRequest): void {
		const requests = this.#byName.get(name);
		if (requests === undefined || !requests.delete(request)) return;
		if (requests.size === 0) this.#byName.delete(name);
	}

	/** The host's publication: every request indexed (by any name) runs its check again, out of the index first. */
	wakeAll(): void {
		const all = [...this.#byName.values()].flatMap((requests) => [...requests]);
		this.#byName.clear();
		for (const request of all) request.wake();
	}

	/** Every indexed request acting for a principal `revoked` names ends with `error`. */
	revoke(revoked: (principal: Principal) => boolean, error: ChordError): void {
		for (const requests of [...this.#byName.values()]) {
			for (const request of [...requests]) {
				if (request.principal !== undefined && revoked(request.principal)) request.end(error);
			}
		}
	}

	/** The host closed: every indexed request ends with `error`. */
	close(error: ChordError): void {
		const all = [...this.#byName.values()].flatMap((requests) => [...requests]);
		this.#byName.clear();
		for (const request of all) request.end(error);
	}
}
