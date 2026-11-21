// The owner's sign-in: a one-time owner link (single use, 10 minutes; its page posts the token from the URL's
// fragment, never sent to a server, and gets a browser sign-in), made fresh for `p3` (the command `owner-link`, over
// the data directory's socket, which only the owner's processes reach).

import { contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { Http, ServerCommands, ServerRuntime } from "@earendil-works/p3/v1/server";
import { SignIns } from "./contract.ts";
import { hashToken, matchesHash, newToken } from "./sign-ins.ts";

/** How long an owner link is valid: 10 minutes. */
const OWNER_LINK_MS = 10 * 60_000;

/** The owner link's page and post. */
export const OWNER_PATH = "/_p3/owner";

/** Serves the owner link's page and post, and the command `owner-link`, on `host`. */
export function serveOwner(host: FacetHost<P3Principal>): void {
	const ownerLink = new OwnerLink();
	contribute(host, "sign-in.owner", (self) => {
		const runtime = self.registry(ServerRuntime);
		self.contribute(Http, {
			routes: {
				[`GET ${OWNER_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: ownerPage(request.nonce) }),
				},
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						if (typeof body?.token !== "string" || !ownerLink.consume(body.token)) {
							return { kind: "error", status: 403 };
						}
						const signIns = await ctx.get(SignIns, {});
						const secure = request.provenance.kind !== "local";
						const owner = { principal: OWNER, label: "owner browser", kind: "browser", secure } as const;
						const issued = await signIns.issue(owner, ctx);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		});
		// `p3` asks it over the data directory's socket, which only the owner's processes reach.
		self.contribute(ServerCommands, {
			name: "owner-link",
			run: async () => {
				const listening = runtime.value.listening();
				if (listening === undefined) throw new Error("p3: the server does not listen yet");
				return ownerLink.renew(`http://127.0.0.1:${listening.port}`);
			},
		});
	});
}

/** The owner's principal. */
const OWNER = { kind: "owner" } as const;

/** The owner link and its one-time token: made on request, consumed by its first use. */
class OwnerLink {
	#hash: string | undefined;
	#expires = 0;

	/** A fresh link at `origin` (the previous one no longer valid), valid 10 minutes. */
	renew(origin: string): string {
		const token = newToken();
		this.#hash = hashToken(token);
		this.#expires = Date.now() + OWNER_LINK_MS;
		return `${origin}${OWNER_PATH}#${token}`;
	}

	/** Whether `token` is the current one and has not expired; it is used up either way when it matches. */
	consume(token: string): boolean {
		const hash = this.#hash;
		if (hash === undefined || !matchesHash(token, hash)) return false;
		this.#hash = undefined;
		return Date.now() < this.#expires;
	}
}

/** The owner link's page: its script (the response's nonce) posts the fragment's token, then opens p3. */
function ownerPage(nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(OWNER_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}
