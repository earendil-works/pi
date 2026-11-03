// The unbound index (dependency model §1, §4): the requests a host decided cannot bind yet, by the name they wait for.
// Before the host's first publication every hold arriving on its links, and a request made here while `load` runs the
// setups (before `load` this host's own requests throw), waits here (`unpublished`); after it, those its check left
// unbound (`not_served`, `version`): a reference made here, a hold that arrived over a link and was refused for a name.
// A publication wakes the requests of the names it serves (`load`'s every one, a reload's those of its names); a
// request leaves when it ends (released, settled, given up, its link or origin closed, revoked) or binds. A request
// waiting with a cause (after the publication) is on the host's `UnboundClock` while it is indexed: reported after 5 s.

import type { ChordError, FailureCause, Principal } from "../data/index.ts";
import type { UnboundClock } from "./unbound-clock.ts";

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
	readonly #clock: UnboundClock;

	constructor(clock: UnboundClock) {
		this.#clock = clock;
	}

	/**
	 * Indexes `request` under `name` (once; again after a wake), waiting for the publication (no `cause`) or for a
	 * provider that fits (`cause`, on the clock).
	 */
	add(name: string, request: UnboundRequest, cause: FailureCause | undefined): void {
		let requests = this.#byName.get(name);
		if (requests === undefined) {
			requests = new Set();
			this.#byName.set(name, requests);
		}
		requests.add(request);
		if (cause !== undefined) this.#clock.start(request, name, cause.error);
	}

	/** `request` ended or binds: it leaves the index. */
	delete(name: string, request: UnboundRequest): void {
		const requests = this.#byName.get(name);
		if (requests === undefined || !requests.delete(request)) return;
		this.#clock.stop(request);
		if (requests.size === 0) this.#byName.delete(name);
	}

	/** The names requests wait for, sorted. */
	names(): string[] {
		return [...this.#byName.keys()].sort();
	}

	/** The host's publication: every request indexed (by any name) runs its check again, out of the index first. */
	wakeAll(): void {
		const all = [...this.#byName.values()].flatMap((requests) => [...requests]);
		this.#byName.clear();
		for (const request of all) this.#clock.stop(request);
		for (const request of all) request.wake();
	}

	/**
	 * A reload's publication: the requests indexed under `names` (the types and registries it serves) run their check
	 * again, out of the index first; the others stay (carry-over "Publications wake per name").
	 */
	wake(names: Iterable<string>): void {
		const woken: UnboundRequest[] = [];
		for (const name of names) {
			const requests = this.#byName.get(name);
			if (requests === undefined) continue;
			this.#byName.delete(name);
			woken.push(...requests);
		}
		for (const request of woken) this.#clock.stop(request);
		for (const request of woken) request.wake();
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
		for (const request of all) this.#clock.stop(request);
		for (const request of all) request.end(error);
	}
}
