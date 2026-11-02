// Device pairing (slice 13 §2, decision "The app kit, point 3" (c)): a command-line or terminal client on another
// machine asks for a code (`POST /_chord/pair`, public) and polls with a secret it got with it; the owner opens
// `/_chord/pair/<code>` in a signed-in browser and approves; the next poll returns a device session's token, once.
// Codes are short, random, single use and expire after 10 minutes; the poll secret is kept only hashed. Asking is
// public, so pairings anonymous clients start are capped: `maxPending` in all (100 by default) and `perAddress` per
// client address (10). The trade: a party filling the caps locks pairing out for others for up to 10 minutes (behind a
// tunnel every remote client has the tunnel's address), instead of growing the server's memory without bound; a
// signed-in owner's pairings are not counted, so the owner can always pair.

import { randomInt } from "node:crypto";
import type { Principal } from "../../next/data/index.ts";
import { defineFacet, type Facet } from "../../next/host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import { OWNER } from "./owner.ts";
import { hashToken, newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

/** How long a pairing code is valid: 10 minutes. */
const PAIRING_MS = 10 * 60_000;

/** The code's letters: no 0/O, 1/I/L. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Who starts a pairing: the signed-in owner (not counted), or an anonymous client at an address (counted). */
export type PairingStarter = { readonly kind: "owner" } | { readonly kind: "anonymous"; readonly address: string };

/** One pairing under way: its code, the device's label, who started it, its expiry, its token once approved. */
type Pairing = {
	readonly code: string;
	readonly label: string;
	readonly by: PairingStarter;
	readonly expires: number;
	token?: string;
};

/** The limits of pairings under way: in all (100 by default) and per client address (10 by default). */
export type PairingLimits = { readonly maxPending?: number; readonly perAddress?: number };

/** The pairings under way, by code and by their poll secret's hash, with the anonymous ones counted. */
export class Pairings {
	readonly #byCode = new Map<string, Pairing>();
	readonly #byPoll = new Map<string, Pairing>();
	readonly #perAddress = new Map<string, number>();
	#anonymous = 0;
	readonly #maxPending: number;
	readonly #maxPerAddress: number;

	constructor(limits: PairingLimits = {}) {
		this.#maxPending = limits.maxPending ?? 100;
		this.#maxPerAddress = limits.perAddress ?? 10;
	}

	/**
	 * A new pairing for a device labelled `label`, started `by` the owner or an anonymous client: its code (for the
	 * owner) and its poll secret (for the device); `undefined` when an anonymous client reached a limit.
	 */
	begin(label: string, by: PairingStarter): { readonly code: string; readonly poll: string } | undefined {
		this.#expire();
		if (by.kind === "anonymous") {
			const full = this.#anonymous >= this.#maxPending;
			if (full || (this.#perAddress.get(by.address) ?? 0) >= this.#maxPerAddress) return undefined;
			this.#anonymous++;
			this.#perAddress.set(by.address, (this.#perAddress.get(by.address) ?? 0) + 1);
		}
		let code: string;
		do code = `${letters(4)}-${letters(4)}`;
		while (this.#byCode.has(code));
		const poll = newToken();
		const pairing: Pairing = { code, label, by, expires: Date.now() + PAIRING_MS };
		this.#byCode.set(code, pairing);
		this.#byPoll.set(hashToken(poll), pairing);
		return { code, poll };
	}

	/** The pairing waiting for approval under `code` (any case), unexpired. */
	waiting(code: string): Pairing | undefined {
		this.#expire();
		const pairing = this.#byCode.get(code.toUpperCase());
		return pairing?.token === undefined ? pairing : undefined;
	}

	/** What a poll with `poll` learns: still waiting, the device's token (once: the pairing ends), or nothing. */
	poll(
		poll: string,
	): { readonly kind: "waiting" } | { readonly kind: "approved"; readonly token: string } | undefined {
		this.#expire();
		const hash = hashToken(poll);
		const pairing = this.#byPoll.get(hash);
		if (pairing === undefined) return undefined;
		if (pairing.token === undefined) return { kind: "waiting" };
		this.#end(hash, pairing);
		return { kind: "approved", token: pairing.token };
	}

	/** Drops the expired pairings. */
	#expire(): void {
		const now = Date.now();
		for (const [hash, pairing] of this.#byPoll) {
			if (pairing.expires <= now) this.#end(hash, pairing);
		}
	}

	/** Ends `pairing` (its poll secret's hash `hash`). */
	#end(hash: string, pairing: Pairing): void {
		this.#byPoll.delete(hash);
		this.#byCode.delete(pairing.code);
		const { by } = pairing;
		if (by.kind === "owner") return;
		this.#anonymous--;
		const left = (this.#perAddress.get(by.address) ?? 1) - 1;
		if (left === 0) this.#perAddress.delete(by.address);
		else this.#perAddress.set(by.address, left);
	}
}

/** `count` random letters of `ALPHABET` (`crypto.randomInt`). */
function letters(count: number): string {
	let text = "";
	for (let index = 0; index < count; index++) text += ALPHABET[randomInt(ALPHABET.length)];
	return text;
}

/** The pairing routes' prefix. */
export const PAIR_PATH = "/_chord/pair";

/**
 * The kit's facet for device pairing: `POST /_chord/pair` (public: `{ label? }` → `{ code, poll }`, 429 past a limit
 * unless the owner asks), `POST /_chord/pair/poll` (public: `{ poll }` → `{ status: "waiting" }`, `{ status:
 * "approved", token }` once, else 404), `GET` and `POST /_chord/pair/:code` (the owner's confirm page and approval: a
 * device session of the owner).
 */
export function pairingFacet<P extends Principal>(pairings: Pairings): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`POST ${PAIR_PATH}`]: {
					public: true,
					handler: async (request, ctx): Promise<HttpResponse> => {
						const label = await labelOf(request);
						const by: PairingStarter =
							ctx.principal?.kind === "owner"
								? { kind: "owner" }
								: { kind: "anonymous", address: request.remoteAddress ?? "" };
						const begun = pairings.begin(label, by);
						return begun === undefined ? { kind: "error", status: 429 } : { kind: "json", value: begun };
					},
				},
				[`POST ${PAIR_PATH}/poll`]: {
					public: true,
					handler: async (request): Promise<HttpResponse> => {
						// A trust boundary: anyone may poll.
						const body = (await request.json()) as { readonly poll?: unknown } | null;
						const polled = typeof body?.poll === "string" ? pairings.poll(body.poll) : undefined;
						if (polled === undefined) return { kind: "error", status: 404 };
						if (polled.kind === "waiting") return { kind: "json", value: { status: "waiting" } };
						return { kind: "json", value: { status: "approved", token: polled.token } };
					},
				},
				[`GET ${PAIR_PATH}/:code`]: async (request, ctx) => {
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					const pairing = pairings.waiting(request.params.code ?? "");
					if (pairing === undefined)
						return { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
					return { kind: "html", body: confirmPage(pairing.code, pairing.label) };
				},
				[`POST ${PAIR_PATH}/:code`]: async (request, ctx) => {
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					const pairing = pairings.waiting(request.params.code ?? "");
					if (pairing === undefined)
						return { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
					const sessions = await ctx.get(Sessions, {});
					const { token } = await sessions.issue({ principal: OWNER, label: pairing.label, kind: "device" }, ctx);
					pairing.token = token;
					return {
						kind: "html",
						body: `<p>Approved: ${escapeHtml(pairing.label)} is signed in as the owner.</p>`,
					};
				},
			},
		}),
	);
}

/** The device's label from a pairing request's body (`{ label }`, at most 100 characters), else `device`. */
async function labelOf(request: HttpRequest): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared === 0 && request.headers.get("transfer-encoding") === null) return "device";
	// A trust boundary: anyone may ask for a code.
	const body = (await request.json(4096)) as { readonly label?: unknown } | null;
	return typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 100) : "device";
}

/** The owner's confirm page for pairing `code` (a form posting to itself: same origin, the session cookie). */
function confirmPage(code: string, label: string): string {
	return [
		"<!doctype html><title>Pair a device</title>",
		`<p>Sign in <b>${escapeHtml(label)}</b> as the owner? Its code: <b>${escapeHtml(code)}</b> (compare it with the device).</p>`,
		'<form method="post"><button>Approve</button></form>',
	].join("\n");
}

/** `text` safe in HTML. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
