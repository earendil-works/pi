// Owner links (`/owner#<token>`) and the origins they are for: minted by the owner-link CLI and the server's startup
// line, checked by the TUI launcher.
import { localOwnerSignIn } from "./local-owner.ts";

/**
 * A fresh one-time owner link for `base`, minted by the local owner of the p2 at loopback `server` (signed in with the
 * key of `dataDir`). The link is a credential: print it to the invoking user only.
 */
export async function mintOwnerLink(server: URL, dataDir: string, base: URL): Promise<URL> {
	const signIn = await localOwnerSignIn(server, dataDir);
	if (signIn.kind === "unavailable") throw new Error(signIn.message);
	const response = await fetch(new URL("/owner-token", server), {
		headers: { Cookie: signIn.cookie },
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Cannot mint an owner link (${response.status})`);
	const value: unknown = await response.json();
	if (
		!value ||
		typeof value !== "object" ||
		!("token" in value) ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.token)
	)
		throw new Error("Invalid owner-token response");
	const link = new URL("/owner", base);
	link.hash = value.token;
	return link;
}

/** Shared by the shell CLI and TUI; never allow credentials or an invitation in a path/query. */
export function ownerOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid URL; use an http(s) origin");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Use an http(s) origin URL without credentials, path or query");
	if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
		throw new Error("Remote connections require HTTPS");
	return url;
}

export function ownerLinkToken(value: string, origin: URL): string {
	let link: URL;
	try {
		link = new URL(value.trim());
	} catch {
		throw new Error("Invalid owner link");
	}
	if (
		link.origin !== origin.origin ||
		link.username ||
		link.password ||
		link.pathname !== "/owner" ||
		link.search ||
		!/^#[a-f0-9]{64}$/.test(link.hash)
	)
		throw new Error("Use an owner link for this origin with its token in the fragment");
	return link.hash.slice(1);
}
