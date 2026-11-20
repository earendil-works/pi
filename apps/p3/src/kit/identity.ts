// Who a listening server is, proven without a secret on the wire. `GET /_p3/identity?nonce=<32 hex digits>` answers
// the server's run id (random, made at each start, in its record from the `starting` step on), its pid, its Pi's id,
// and `proof`: HMAC-SHA256 of the nonce, keyed by the owner token. A command believes a `running` record only once
// the server on the record's port answers that record's run id and the proof for the command's own fresh nonce.
//
// What it protects against: another user on the machine. A record that survived a crash names a port another user's
// program may hold by then; the run id is no secret (the real server tells anyone), so a program could echo it. Only
// the owner's own processes can read the owner token (the data directory is 0700), so only the server can answer the
// proof, and the command sends the token itself (the owner link, the stop) only to a server proven so.

import { createHmac, timingSafeEqual } from "node:crypto";
import { defineFacet, type Facet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";
import type { P3Principal } from "../principals.ts";

/** The path of a server's identity. */
export const IDENTITY_PATH = "/_p3/identity";

/** What the identity route answers. */
export type Identity = { readonly run: string; readonly pid: number; readonly pi: string; readonly proof: string };

/** A nonce as the route takes it: 16 random bytes in hex. */
const NONCE = /^[0-9a-f]{32}$/;

/**
 * The kit's facet for the server's identity: `GET /_p3/identity?nonce=…`, open to anyone (it tells nothing secret);
 * 400 for a missing or malformed nonce. `ownerToken` is the owner token file's token, known before the server listens.
 */
export function identityFacet(
	server: { readonly run: string; readonly pid: number; readonly pi: string },
	ownerToken: () => string,
): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${IDENTITY_PATH}`]: {
					public: true,
					handler: async (request) => {
						// A trust boundary: anyone may ask.
						const nonce = request.query.get("nonce");
						if (nonce === null || !NONCE.test(nonce)) return { kind: "error", status: 400 };
						return { kind: "json", value: { ...server, proof: proofOf(ownerToken(), nonce) } };
					},
				},
			},
		}),
	);
}

/** The proof for `nonce`: HMAC-SHA256 keyed by `token`, in hex. */
export function proofOf(token: string, nonce: string): string {
	return createHmac("sha256", token).update(nonce).digest("hex");
}

/** Whether `proof` (what a server answered) is the proof for `nonce` under `token`, compared in constant time. */
export function proves(proof: unknown, token: string, nonce: string): boolean {
	const expected = Buffer.from(proofOf(token, nonce), "hex");
	return (
		typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, "hex"), expected)
	);
}
