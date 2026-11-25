// A route's admission (slice 14 §2.3): the decision a route asks before it resolves an address or forwards a hold, so
// no host starts for a caller who will be denied. One decision per principal key and address with holds on the route,
// asked after `authorize`, shared by those holds and released with the last. It gates the address's path: a hold is
// held back until its decision allows it, released upstream by a denial (its calls rejected `forbidden/revoked`), and
// forwarded again by the next allow (behind the path's fence). A decision lives with its holds on the routing host
// and takes no fate in a reload; its references follow the reference rules.

import { type Context, type ContextKey, createContextKey, withContextValue } from "../context/index.ts";
import type { Address } from "../contracts/index.ts";
import type { FailureCause, Principal } from "../data/index.ts";
import { asChordError, sameCause } from "../data/internal.ts";
import type { Path, PathGate, Upstream } from "../remote/internal.ts";
import type { Watchable } from "../watch.ts";
import { type Admission, type AdmitSelf, Decision, type Verdict } from "./admission.ts";
import type { Blocked } from "./dependencies.ts";
import type { AnyHost } from "./host.ts";

/** A route's `admit` as its route calls it: plugin-free base code, but what it returns is checked as any `admit`'s. */
export type RouteAdmit = (principal: Principal, address: Address, self: AdmitSelf) => Watchable<Admission<null>>;

/**
 * The route whose admission binds the references made under a context: a hold of a type placed behind that very
 * route would wait on itself, so the route refuses it `invalid/cycle`.
 */
export const ADMITTING: ContextKey<object> = createContextKey<object>("chord.route.admitting");

/**
 * Where a decision stands. `settling`: its verdict is being settled (its pinned keys load, its live queries open),
 * and `moved` says something it reads changed meanwhile, so what the settle read is of the past. `waiting`: the last
 * settle found it not decided (a source loads or failed): the next change settles again. `settled`: it reached an
 * allow or a denial once, so it is read synchronously from then on, in the flush of the batch that changed it.
 */
type AskedState =
	| { readonly kind: "settling"; moved: boolean }
	| { readonly kind: "waiting" }
	| { readonly kind: "settled" }
	| { readonly kind: "released" };

/**
 * One decision and the holds it is asked for. `verdict` is what its holds were last told: nothing before its first
 * check (they are `loading`: nothing is resolved or forwarded for them). `forwarded` are the holds its last allow
 * forwarded: a decision that cannot be read (a failed source) leaves them alone, however often it fails; only a
 * denial takes them back.
 */
type Asked = {
	readonly decision: Decision;
	readonly path: Path;
	readonly holders: Set<Upstream>;
	readonly forwarded: Set<Upstream>;
	verdict: Verdict | undefined;
	state: AskedState;
};

/** A route's decision reports no long wait: its holds show what it waits on. */
const NO_REPORT: Blocked = { blockedBy: () => {} };

/** Not decided by its last settle: the shared state (it has no fields). */
const WAITING: AskedState = { kind: "waiting" };

/** Decided once, read synchronously from then on: the shared state. */
const SETTLED: AskedState = { kind: "settled" };

/** Its last hold left: the shared state. */
const RELEASED: AskedState = { kind: "released" };

/** The decisions of one route, by address key and principal key. */
export class RouteAdmission {
	readonly #host: AnyHost;
	/** What a hold behind this very route is refused by: the route itself, the value of `ADMITTING`. */
	readonly #route: object;
	readonly #admit: RouteAdmit;
	/** The route's context, with the route named as the one admitting. */
	readonly #context: Context;
	readonly #asked = new Map<string, Asked>();

	constructor(host: AnyHost, route: object, admit: RouteAdmit, context: Context) {
		this.#host = host;
		this.#route = route;
		this.#admit = admit;
		this.#context = withContextValue(ADMITTING, route, context);
		// Its decisions declare under this context: their follows of their references end with it (`Decision.unfollow`).
		context.abortSignal?.addEventListener(
			"abort",
			() => {
				for (const asked of this.#asked.values()) asked.decision.unfollow();
			},
			{ once: true },
		);
	}

	/** Whether `context` binds a reference of this route's own admission (which may hold nothing behind the route). */
	admitting(context: Context): boolean {
		return context.value(ADMITTING) === this.#route;
	}

	/** The gate of `address`'s path (`path()` gives it: the path is made with its gate). */
	gate(address: Address, path: () => Path): PathGate {
		return {
			joined: (holder) => this.#joined(address, path(), holder),
			left: (holder) => this.#left(address, holder),
			unlinked: () => this.#unlinked(path()),
		};
	}

	/**
	 * `path` lost its link. A hold is forwarded on a new link only under an allow that can be read now (fail closed:
	 * a new link is new work at the address's host, perhaps its start): the holds forwarded under a last allow whose
	 * source has failed since are taken back, `failed { waiting }` on it, until the source recovers. A source that
	 * only loads keeps its allow.
	 */
	#unlinked(path: Path): void {
		for (const asked of this.#asked.values()) {
			if (asked.path !== path || asked.verdict?.kind === "allow") continue;
			for (const holder of [...asked.forwarded]) {
				asked.forwarded.delete(holder);
				this.#tell(asked, holder);
			}
		}
	}

	/**
	 * `holder` joined `address`'s path: its principal's decision is asked (once, however many holds share it); whether
	 * it allows now, so the hold is forwarded at once. A decision that cannot be declared (a throwing `admit`, a
	 * refused request, a hold behind this route) fails the hold `broken`.
	 */
	#joined(address: Address, path: Path, holder: Upstream): boolean {
		// A hold routed over a route acts for a principal (`Route.path` refused one without).
		const principal = holder.caller.principal!;
		const key = this.#key(address, principal);
		const asked = this.#asked.get(key);
		if (asked !== undefined) {
			asked.holders.add(holder);
			if (asked.verdict?.kind === "allow") {
				asked.forwarded.add(holder);
				return true;
			}
			this.#tell(asked, holder);
			return false;
		}
		const settling: AskedState = { kind: "settling", moved: false };
		const made: Asked = {
			decision: new Decision({
				host: this.#host,
				label: `route ${address.key}`,
				// The admission's references act as the host.
				caller: { principal: this.#host.principal, incarnation: this.#host.incarnation },
				dependent: undefined,
				grants: undefined,
				moved: () => this.#moved(made),
			}),
			path,
			holders: new Set([holder]),
			forwarded: new Set(),
			verdict: undefined,
			// Settling from its declaration on: what its requests tell while they are bound is a change to settle.
			state: settling,
		};
		this.#asked.set(key, made);
		try {
			made.decision.declare((self) => this.#admit(principal, address, self), this.#context);
		} catch (error) {
			made.state = WAITING;
			made.verdict = { kind: "broken", error: asChordError(error, address.key) };
			this.#tell(made, holder);
			return false;
		}
		void this.#settle(made, settling);
		return false;
	}

	/** `holder` left: its decision is released with its last hold. */
	#left(address: Address, holder: Upstream): void {
		const key = this.#key(address, holder.caller.principal!);
		const asked = this.#asked.get(key);
		if (asked === undefined || !asked.holders.delete(holder)) return;
		asked.forwarded.delete(holder);
		if (asked.holders.size > 0) return;
		asked.state = RELEASED;
		this.#asked.delete(key);
		asked.decision.release();
	}

	/** The key of the decision for `principal` at `address`. */
	#key(address: Address, principal: Principal): string {
		return `${address.key}\n${this.#host.principalKeyOf(principal, this.#context)}`;
	}

	/**
	 * Something `asked` reads changed: read again at once when it decided before; remembered while it settles (what
	 * that settle read is of the past); else its verdict is settled again.
	 */
	#moved(asked: Asked): void {
		const { state } = asked;
		switch (state.kind) {
			case "settled":
				this.#apply(asked, asked.decision.now(this.#context));
				return;
			case "settling":
				state.moved = true;
				return;
			case "waiting": {
				const settling: AskedState = { kind: "settling", moved: false };
				asked.state = settling;
				void this.#settle(asked, settling);
				return;
			}
			case "released":
				// Its last hold left while a source still told it: nobody is left to tell.
				return;
		}
	}

	/**
	 * Brings `asked` to a verdict (its pinned keys loaded, its live queries open) as the settle `settling`. **A
	 * verdict is told only when nothing it reads changed while it was settled:** a settle is asynchronous, and a
	 * denial arriving between its read and its continuation must not be answered with the allow it read before (that
	 * would resolve the address, start its host and leave the hold live with nobody left to correct it). It settles
	 * again until one is stable.
	 */
	async #settle(asked: Asked, settling: Extract<AskedState, { readonly kind: "settling" }>): Promise<void> {
		for (;;) {
			settling.moved = false;
			const verdict = await asked.decision.settle(NO_REPORT, this.#context);
			// Released meanwhile: nobody is told.
			if (asked.state !== settling) return;
			if (settling.moved) continue;
			asked.state = verdict.kind === "allow" || verdict.kind === "deny" ? SETTLED : WAITING;
			this.#apply(asked, verdict);
			return;
		}
	}

	/**
	 * `asked` says `verdict` now. An allow forwards every hold not forwarded yet; a denial takes every hold back
	 * (released upstream, its calls rejected `forbidden/revoked`). A decision that cannot be made (a source failed or
	 * ended, a broken one) fails the holds held back and leaves the ones bound on the path's link alone, at its first
	 * failure and at every later one; without a link (it dropped, its next one is on its way) the forwarded ones are
	 * taken back too, since nothing is forwarded on a new link without an allow that can be read. A source that only
	 * loads tells nobody (the last decision stands; before the first, the holds stay `loading`).
	 */
	#apply(asked: Asked, verdict: Verdict): void {
		const before = asked.verdict;
		if (verdict === before) return;
		asked.verdict = verdict;
		const { holders, forwarded, path } = asked;
		if (verdict.kind === "allow" || verdict.kind === "deny") {
			for (const holder of holders) holder.span?.addEvent("chord.admit", { outcome: verdict.kind });
		}
		if (verdict.kind === "allow") {
			for (const holder of [...holders]) {
				if (forwarded.has(holder)) continue;
				forwarded.add(holder);
				path.forward(holder);
			}
			return;
		}
		if (verdict.kind === "deny") forwarded.clear();
		const cause = held(verdict);
		if (cause === undefined) return;
		// Not bound anywhere: the holds forwarded under the last allow would be forwarded on the next link.
		if (path.link === undefined) forwarded.clear();
		const told = held(before);
		// The same failure again (its source changed and still fails so): nothing new to tell the holds held back.
		const again = told !== undefined && sameCause(told, cause);
		for (const holder of [...holders]) {
			if (forwarded.has(holder) || (again && path.withholds(holder))) continue;
			path.withhold(holder, cause);
		}
	}

	/** Tells `holder`, held back, what holds it back now; nothing while its decision only loads. */
	#tell(asked: Asked, holder: Upstream): void {
		const cause = held(asked.verdict);
		if (cause !== undefined) asked.path.withhold(holder, cause);
	}
}

/** What holds a hold back under `verdict`: a denial, a source it waits on, a broken decision; nothing while it loads. */
function held(verdict: Verdict | undefined): FailureCause | undefined {
	if (verdict === undefined || verdict.kind === "allow") return undefined;
	if (verdict.kind === "deny") return { kind: "denied", error: verdict.error };
	if (verdict.kind === "broken") return { kind: "broken", error: verdict.error };
	return verdict.shown.kind === "failed" ? verdict.shown.cause : undefined;
}
