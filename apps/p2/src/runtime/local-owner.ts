// Local owner sign-in: how a client on the p2 host (the TUI, `npm run owner-link`, scripts) proves that it runs as the
// server's user. Reading the private `<data>/owner-key` (0600, in the 0700 data directory) is the proof, but the key
// never leaves the client: it asks the server for a one-time challenge and answers with an HMAC of the challenge and the
// port. Whatever listens on that port learns nothing it could use elsewhere: a squatter on 8788 cannot pass the answer to
// a p2 on another port, and a restarted p2 forgot the challenge. The answer earns a local owner session cookie
// (`plugins/devices`, `access: "local"`), which the client then sends like a browser.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `POST`: a one-time challenge, `{ challenge }`. */
export const LOCAL_CHALLENGE_PATH = "/owner/local/challenge";
/** `POST { challenge, proof }`: a local owner session cookie (`Set-Cookie`). */
export const LOCAL_CLAIM_PATH = "/owner/local/claim";

/**
 * A local sign-in: the cookie pair to send, or why it is unavailable (no readable owner key, a server that offers no
 * local sign-in, or one with another data directory).
 */
export type LocalSignIn =
	| { readonly kind: "signed-in"; readonly cookie: string }
	| { readonly kind: "unavailable"; readonly message: string };

/** The data directory the server uses by default: `P2_DATA_DIR`, else `~/.pi/p2`. */
export const dataDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
	env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");

/** The answer to a challenge: HMAC-SHA256 under the owner key of the server's port and the challenge. */
export const localOwnerProof = (key: string, port: number, challenge: string): string =>
	createHmac("sha256", key).update(`p2-local-owner:${port}:${challenge}`).digest("hex");

/** Signs in to the p2 at the loopback origin `url` as its local owner, with the key of `dataDir`; throws if unreachable. */
export async function localOwnerSignIn(url: URL, dataDir: string): Promise<LocalSignIn> {
	const path = join(dataDir, "owner-key");
	let key: string;
	try {
		key = readFileSync(path, "utf8").trim();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") throw error;
		return {
			kind: "unavailable",
			message: `Cannot read ${path}: local sign-in needs the user running the p2 server, with its P2_DATA_DIR`,
		};
	}
	const port = Number(url.port || 80);
	const challenged = await post(url, LOCAL_CHALLENGE_PATH, {});
	const value: unknown = challenged.ok ? await challenged.json().catch(() => undefined) : undefined;
	const challenge = value && typeof value === "object" && "challenge" in value ? value.challenge : undefined;
	if (typeof challenge !== "string")
		return {
			kind: "unavailable",
			message: `The server at ${url.origin} offers no local sign-in (${challenged.status})`,
		};
	const claimed = await post(url, LOCAL_CLAIM_PATH, { challenge, proof: localOwnerProof(key, port, challenge) });
	await claimed.arrayBuffer().catch(() => {});
	if (claimed.status === 403)
		return {
			kind: "unavailable",
			message: `The p2 server at ${url.origin} does not use the data directory ${dataDir}: set P2_DATA_DIR to its data directory, or sign in with an owner link`,
		};
	const cookie = claimed.ok
		? claimed.headers
				.getSetCookie()
				.map((header) => header.split(";", 1)[0]!)
				.join("; ")
		: "";
	if (!cookie) throw new Error(`Local sign-in at ${url.origin} failed (${claimed.status})`);
	return { kind: "signed-in", cookie };
}

/** A same-origin JSON POST without redirects; an unreachable server is one clear error. */
async function post(url: URL, path: string, body: object): Promise<Response> {
	try {
		return await fetch(new URL(path, url), {
			method: "POST",
			headers: { Origin: url.origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw new Error(`Cannot reach p2 at ${url.origin}`, { cause: error });
	}
}
