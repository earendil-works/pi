import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDirectory, localOwnerSignIn } from "../runtime/local-owner.ts";
import { ownerLinkToken, ownerOrigin } from "../runtime/owner-link.ts";

export type TuiCredentials = { cookie?: string };
/** A share-link guest of one origin (section 4.1): its own cookie, separate from an owner cookie. */
export type TuiGuest = { cookie: string; session?: string };
export type TuiConnection = TuiCredentials & { guest?: TuiGuest };
export type TuiConfig = { connections: Record<string, TuiConnection> };
/**
 * Who the launcher signed in as. Only `cookie` is ever sent, and only by the launcher. `local`: signed in with the data
 * directory's owner key (never saved; a new sign-in replaces it).
 */
export type TuiAdmission = TuiCredentials & { role: "owner" | "guest"; session?: string; local?: true };
export const configDirectory = (): string => process.env.P2_TUI_CONFIG_DIR ?? join(homedir(), ".pi", "p2-tui");
const COOKIE = /^[\x21-\x7e]{1,4096}$/;
const SESSION = /^[\w-]{1,128}$/;
export function readConfig(directory = configDirectory()): TuiConfig {
	try {
		const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as TuiConfig;
		if (!config.connections || typeof config.connections !== "object" || Array.isArray(config.connections))
			throw new Error("Invalid TUI config");
		const connections: Record<string, TuiConnection> = {};
		for (const [origin, value] of Object.entries(config.connections)) {
			if (!value || typeof value !== "object" || (value.cookie !== undefined && typeof value.cookie !== "string"))
				throw new Error("Invalid TUI credentials");
			// Only cookies survive. Old proxy passwords are neither used nor saved again.
			const connection: TuiConnection = value.cookie ? { cookie: value.cookie } : {};
			const guest: unknown = value.guest;
			if (guest && typeof guest === "object" && "cookie" in guest && typeof guest.cookie === "string") {
				if (!COOKIE.test(guest.cookie)) throw new Error("Invalid TUI guest cookie");
				connection.guest = {
					cookie: guest.cookie,
					...("session" in guest && typeof guest.session === "string" && SESSION.test(guest.session)
						? { session: guest.session }
						: {}),
				};
			}
			connections[origin] = connection;
		}
		return { connections };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: {} };
		throw new Error("Cannot read p2-tui config.json");
	}
}
export function saveConfig(config: TuiConfig, directory = configDirectory()): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = join(directory, "config.json");
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}
export function connectionHeaders(url: URL, credentials: TuiCredentials): Record<string, string> {
	return { Origin: url.origin, ...(credentials.cookie ? { Cookie: credentials.cookie } : {}) };
}
export async function claimOwner(url: URL, token: string, credentials: TuiCredentials): Promise<TuiCredentials> {
	const response = await fetch(new URL("/owner/claim", url), {
		method: "POST",
		headers: { ...connectionHeaders(url, credentials), "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error("Owner claim failed; generate a fresh link with npm run owner-link on the host");
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
	if (!cookie) throw new Error("Owner claim did not return a cookie");
	return { cookie };
}

const isLoopback = (url: URL): boolean =>
	["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol === "http:";

/** A share link `<origin>/join/<token>` (plugins/sharing). Its origin must be the TUI's. */
export function joinLinkToken(value: string, origin: URL): string {
	let link: URL;
	try {
		link = new URL(value.trim());
	} catch {
		throw new Error("Invalid share link");
	}
	const token = /^\/join\/([\w-]{43})$/.exec(link.pathname)?.[1];
	if (link.origin !== origin.origin || link.username || link.password || link.search || link.hash || !token)
		throw new Error("Use a share link for this origin (https://host/join/<token>)");
	return token;
}
/** The origin of a share link, for `--join` without a URL argument. */
export function joinLinkOrigin(value: string): URL {
	let link: URL;
	try {
		link = new URL(value.trim());
	} catch {
		throw new Error("Invalid share link");
	}
	return ownerOrigin(link.origin);
}

/** A display name as the join page accepts it: one line, at most 40 characters, not verified by anyone. */
export function guestName(value: string): string {
	const name = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: names never carry terminal controls.
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
		.trim()
		.slice(0, 40);
	if (!name) throw new Error("Enter a name");
	return name;
}

/** Redeems a share link (POST /join): exact Origin, no redirects, bounded body; keeps an existing guest identity. */
export async function redeemJoin(url: URL, token: string, name: string, guest?: TuiGuest): Promise<TuiGuest> {
	const response = await fetch(new URL("/join", url), {
		method: "POST",
		headers: { ...connectionHeaders(url, { cookie: guest?.cookie }), "Content-Type": "application/json" },
		body: JSON.stringify({ token, name }),
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	const text = await readLimited(response, 2048);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid join response");
	}
	const field = (key: string): unknown =>
		value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
	if (!response.ok) {
		const error = field("error");
		// The server's own short message ("This share has ended", "You were removed ..."), as one plain line.
		throw new Error(typeof error === "string" ? guestName(error) : "Could not join this session");
	}
	const session = field("session");
	if (typeof session !== "string" || !SESSION.test(session)) throw new Error("Invalid join response");
	const cookie =
		response.headers
			.getSetCookie()
			.map((header) => header.split(";", 1)[0]!)
			.find((pair) => /^p2_guest_\d+=/.test(pair)) ?? guest?.cookie;
	if (!cookie || !COOKIE.test(cookie)) throw new Error("Join did not return a guest cookie");
	return { cookie, session };
}
async function readLimited(response: Response, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("Join response exceeds its size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Whether a guest cookie is still admitted: `/__p2_tui` serves admitted guests only (401/403 when it ended). */
export async function checkGuest(url: URL, guest: TuiGuest): Promise<boolean> {
	const response = await fetch(new URL("/__p2_tui", url), {
		method: "HEAD",
		headers: connectionHeaders(url, guest),
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	await response.arrayBuffer().catch(() => {});
	if (response.ok) return true;
	if (response.status === 401 || response.status === 403) return false;
	throw new Error("Cannot check guest access");
}

/** Asks for a link or a name; `reason` says why a link is needed (shown before the question). */
export type TuiPrompt = (kind: "link" | "name", reason?: string) => Promise<string>;

/**
 * Sign-in (section 4.1). An expired or remotely revoked cookie leads back to sign-in, not an endless unauthenticated
 * reconnect. A valid saved owner cookie comes first. On loopback the server's own user then signs in with the owner key
 * of its data directory (`dataDir`, default `P2_DATA_DIR` or `~/.pi/p2`; a server with another data directory refuses
 * that with a clear error), unless `--join` explicitly asks for a guest view; a stored guest cookie never downgrades
 * it. Remote origins use a valid guest cookie next. Everyone else is asked for either link.
 */
export async function authenticateTui(
	options: { url: URL; ownerLink?: string; joinLink?: string; dataDir?: string },
	config: TuiConfig,
	prompt: TuiPrompt,
): Promise<TuiAdmission> {
	const { url } = options;
	const loopback = isLoopback(url);
	const stored = config.connections[url.origin] ?? {};
	const join = async (link: string): Promise<TuiAdmission> => {
		const token = joinLinkToken(link, url);
		let name: string | undefined;
		while (name === undefined) {
			try {
				name = guestName(await prompt("name"));
			} catch (error) {
				if ((error as Error).message !== "Enter a name") throw error;
			}
		}
		const guest = await redeemJoin(url, token, name, stored.guest);
		config.connections[url.origin] = { ...(config.connections[url.origin] ?? {}), guest };
		return { cookie: guest.cookie, role: "guest", session: guest.session };
	};
	if (options.joinLink) return join(options.joinLink);
	let credentials: TuiCredentials = { cookie: stored.cookie };
	if (!options.ownerLink && credentials.cookie) {
		const response = await fetch(new URL("/owner/check", url), {
			headers: connectionHeaders(url, credentials),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (response.ok) {
			const value: unknown = await response.json();
			if (value && typeof value === "object" && "owner" in value && value.owner === true)
				return { ...credentials, role: "owner" };
			throw new Error("Invalid owner-access response");
		}
		await response.arrayBuffer().catch(() => {});
		if (response.status !== 401 && response.status !== 403) throw new Error("Cannot check owner access");
	}
	let reason: string | undefined;
	if (loopback && !options.ownerLink) {
		const local = await localOwnerSignIn(url, options.dataDir ?? dataDirectory());
		if (local.kind === "signed-in") return { cookie: local.cookie, role: "owner", local: true };
		reason = local.message;
	}
	if (!options.ownerLink && !loopback && stored.guest) {
		if (await checkGuest(url, stored.guest))
			return { cookie: stored.guest.cookie, role: "guest", session: stored.guest.session };
		// Reset or removed share, or an archived session: forget the cookie and ask for a new link.
		const { guest: _ended, ...rest } = config.connections[url.origin] ?? {};
		config.connections[url.origin] = rest;
	}
	const link = options.ownerLink ?? (await prompt("link", reason));
	if (!options.ownerLink && /\/join\//.test(link)) return join(link);
	credentials = await claimOwner(url, ownerLinkToken(link, url), credentials);
	config.connections[url.origin] = { ...(config.connections[url.origin] ?? {}), ...credentials };
	return { ...credentials, role: "owner" };
}

/** Forgets a guest cookie the server no longer admits (revocation while running). */
export function forgetGuest(config: TuiConfig, origin: string): void {
	const connection = config.connections[origin];
	if (connection?.guest) {
		const { guest: _ended, ...rest } = connection;
		config.connections[origin] = rest;
	}
}

/** The launcher's own notice when the server stops admitting the stored cookie (the web page's wording). */
export const endedNotice = (role: TuiAdmission["role"]): string =>
	role === "guest" ? "This share has ended." : "Signed out on this device.";

/**
 * After a refused reconnect: forget the cookie kind the launcher stored (it knows which; the worker's role is not
 * consulted), then offer to continue with a new link for this origin. Undefined when the visitor quits (empty line).
 */
export async function resumeAfterEnded(
	role: TuiAdmission["role"],
	url: URL,
	config: TuiConfig,
	ask: (question: string) => Promise<string>,
): Promise<{ joinLink?: string; ownerLink?: string } | undefined> {
	if (role === "guest") forgetGuest(config, url.origin);
	else {
		const { cookie: _ended, ...rest } = config.connections[url.origin] ?? {};
		config.connections[url.origin] = rest;
	}
	let question =
		role === "guest"
			? "Paste a new share link to join again (Enter to quit): "
			: "Owner link to sign in again (npm run owner-link on the host; Enter to quit): ";
	for (;;) {
		const link = (await ask(question)).trim();
		if (!link) return undefined;
		try {
			if (/\/join\//.test(link)) {
				joinLinkToken(link, url);
				return { joinLink: link };
			}
			ownerLinkToken(link, url);
			return { ownerLink: link };
		} catch (error) {
			question = `${(error as Error).message}. Try again (Enter to quit): `;
		}
	}
}

export function parseTuiArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
	let urlText: string | undefined;
	let ownerLink = env.P2_TUI_OWNER_LINK;
	let joinLink: string | undefined;
	let theme: string | undefined;
	let noThemes = false;
	let radius: { server?: string } | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--radius") {
			// Optionally followed by the server's ID; without it, the user's only online server.
			const next = args[i + 1];
			radius = next !== undefined && SERVER_ID.test(next) ? { server: args[++i] } : {};
		} else if (arg === "--owner-link") {
			ownerLink = args[++i];
			if (!ownerLink) throw new Error("--owner-link needs a value");
		} else if (arg === "--join") {
			joinLink = args[++i];
			if (!joinLink) throw new Error("--join needs a share link");
		} else if (arg === "--theme") {
			// pi's --theme: this run's theme setting (a name or "light/dark" pair).
			theme = args[++i];
			if (!theme) throw new Error("--theme needs a value");
		} else if (arg === "--no-themes") noThemes = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown TUI option: ${arg}`);
		else urlText = arg;
	}
	if (joinLink && ownerLink && args.includes("--owner-link")) throw new Error("Use either --join or --owner-link");
	if (radius && (urlText !== undefined || joinLink || args.includes("--owner-link")))
		throw new Error("--radius signs in through Radius: no URL, owner link or share link");
	if (joinLink || radius) ownerLink = undefined;
	// Without a URL argument, --join takes the origin from its link; otherwise the link must match the URL.
	const url =
		urlText === undefined && joinLink
			? joinLinkOrigin(joinLink)
			: ownerOrigin(urlText ?? `http://127.0.0.1:${env.PORT ?? 8788}`);
	if (ownerLink) ownerLinkToken(ownerLink, url);
	if (joinLink) joinLinkToken(joinLink, url);
	return { url, ownerLink, joinLink, theme, noThemes, radius };
}

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
