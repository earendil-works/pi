// The launcher's credentials (slice 11 §4, decision "The app kit, point 3" (c)): a device token the launcher keeps,
// never the sandbox. It is given, read from a token file (the owner token file on the server's machine, slice 13), or
// got by device pairing: the launcher asks for a code, shows it, and polls until the owner approved it in a browser;
// a paired token may be saved to a file (mode 0600) for the next start.

import { readFile } from "node:fs/promises";
import { writeSecret } from "../app/secrets.ts";

/** Where the launcher's token comes from. */
export type TerminalCredentials =
	| { readonly kind: "token"; readonly token: string }
	| { readonly kind: "file"; readonly path: string }
	/** Pairing with the server, the device named `label`; the token saved to `save` (created, mode 0600) when given. */
	| { readonly kind: "pairing"; readonly label: string; readonly save?: string };

/** How often a pairing is polled. */
const POLL_MS = 2000;

/** The launcher's token for the server at `url`; pairing shows its code through `say`. */
export async function tokenOf(
	credentials: TerminalCredentials,
	url: URL,
	say: (line: string) => void,
	signal: AbortSignal,
): Promise<string> {
	switch (credentials.kind) {
		case "token":
			return credentials.token;
		case "file":
			return (await readFile(credentials.path, "utf8")).trim();
		case "pairing":
			return pair(credentials, url, say, signal);
	}
}

/** Pairs this device: a code shown, the approval polled for, the token returned (and saved when asked). */
async function pair(
	credentials: Extract<TerminalCredentials, { kind: "pairing" }>,
	url: URL,
	say: (line: string) => void,
	signal: AbortSignal,
): Promise<string> {
	const asked = await post(new URL("/_chord/pair", url), { label: credentials.label }, signal);
	if (!asked.ok) throw new Error(`terminal: the server refused to pair (${asked.status})`);
	const { code, poll } = (await asked.json()) as { readonly code?: unknown; readonly poll?: unknown };
	// A trust boundary: the server's answer is shown on the terminal and sent back.
	if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(code) || typeof poll !== "string") {
		throw new Error("terminal: the server's pairing answer is malformed");
	}
	say(`Pairing code ${code}: approve it at ${new URL(`/_chord/pair/${code}`, url)} (signed in as the owner).`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		signal.throwIfAborted();
		const polled = await post(new URL("/_chord/pair/poll", url), { poll }, signal);
		if (!polled.ok) throw new Error("terminal: the pairing ended without approval");
		const answer = (await polled.json()) as { readonly status: string; readonly token?: string };
		if (answer.status !== "approved" || answer.token === undefined) continue;
		if (credentials.save !== undefined) await writeSecret(credentials.save, answer.token, "create");
		return answer.token;
	}
}

/** A JSON post. */
function post(url: URL, body: unknown, signal: AbortSignal): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}
