// Owner links (`/owner#<token>`) and the origins they are for: checked by the owner-link CLI and the TUI launcher.
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
