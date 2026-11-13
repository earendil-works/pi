// Unrestricted launcher: authentication, terminal and fixed-origin transport stay outside downloaded code.
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { editorArgv, launcherActions } from "./tui-actions.ts";
import { startTuiClient, type TuiClient } from "./tui-client.ts";
import {
	authenticateTui,
	endedNotice,
	parseTuiArgs,
	readConfig,
	resumeAfterEnded,
	saveConfig,
	type TuiAdmission,
} from "./tui-config.ts";
import {
	launcherPreferences,
	loadLocalPreferences,
	localPreferenceSources,
	watchLocalPreferences,
} from "./tui-local-preferences.ts";
import { RADIUS_POLL_MS, type RadiusTransport, radiusClient, radiusServer, radiusTransport } from "./tui-radius.ts";
import { requireTuiNode } from "./tui-sandbox.ts";
import { cookieTransport } from "./tui-transport.ts";

const ask = async (question: string): Promise<string> => {
	const input = createInterface({ input: stdin, output: stdout });
	try {
		return await input.question(question);
	} finally {
		input.close();
	}
};

/**
 * Through Radius (`--radius`): sign in to Radius, find the server, and check that it admits this user as its owner.
 * The server's answer names its origin, which the launcher shows and builds browser links from.
 */
async function connectRadius(
	server: string | undefined,
	signal: AbortSignal,
): Promise<{ url: URL; transport: RadiusTransport }> {
	const client = await radiusClient((text) => console.log(text), signal);
	const transport = radiusTransport(client, await radiusServer(client, server));
	const response = await transport.request("/owner/check", { signal: AbortSignal.timeout(30_000) });
	const value: unknown = response.ok ? await response.json() : undefined;
	if (!value || typeof value !== "object" || !("owner" in value) || value.owner !== true || !transport.origin)
		throw new Error(`This server does not admit you as its owner through Radius (${response.status})`);
	return { url: new URL(transport.origin), transport };
}

let client: TuiClient | undefined;
let stopping = false;
const stopped = new AbortController();
/** Ends the current run's wait; a signal closes the client without its exit callback. */
let finish: () => void = () => {};
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		stopping = true;
		stopped.abort();
		void (client?.close() ?? Promise.resolve()).finally(() => finish());
	});
try {
	requireTuiNode();
	let options = parseTuiArgs(process.argv.slice(2));
	const config = readConfig();
	// The visitor's own pi keybindings/settings/themes and p2 prefs, read here and sent to the worker as data.
	const sources = localPreferenceSources({ theme: options.theme, noThemes: options.noThemes });
	const current = loadLocalPreferences(sources);
	const radius = options.radius && (await connectRadius(options.radius.server, stopped.signal));
	while (!stopping) {
		const admission: TuiAdmission = radius
			? { role: "owner" }
			: await authenticateTui(options, config, (kind, reason) =>
					ask(
						kind === "name"
							? "Your name (shown to the owner and other guests; not verified): "
							: `${reason ? `${reason}.\n` : ""}Owner link (npm run owner-link on the host) or share link: `,
					),
				);
		if (!radius) saveConfig(config);
		const url = radius ? radius.url : options.url;
		const credentials = { cookie: admission.cookie };
		const transport = radius ? radius.transport : cookieTransport(url, credentials);
		const local = launcherPreferences(sources);
		const failures: string[] = [];
		let ended = false;
		let startError: unknown;
		const exited = new Promise<void>((resolve) => {
			finish = resolve;
			void startTuiClient({
				terminal: new ProcessTerminal(),
				url,
				transport,
				...(radius ? { pollMs: RADIUS_POLL_MS } : {}),
				mouse: local.mouse,
				role: admission.role,
				actions: launcherActions({
					url,
					credentials,
					transport,
					role: admission.role,
					downloads: local.downloads,
					editor: editorArgv(local.editor),
				}),
				preferences: { current, subscribe: (listener) => watchLocalPreferences(sources, listener, current) },
				onFailure: (message) => failures.push(message),
				// The server no longer admits the stored cookie (a refused reconnect, confirmed by the launcher itself).
				onAccessEnded: () => {
					ended = true;
				},
				onExit: () => void client?.close().finally(resolve),
			}).then(
				(started) => {
					client = started;
				},
				(error: unknown) => {
					startError = error;
					resolve();
				},
			);
		});
		await exited;
		// A client that could not start (no bundle, refused sign-in) is an error, not a quiet exit.
		if (startError) throw startError;
		client = undefined;
		for (const message of failures) console.error(message);
		if (!ended || stopping) break;
		if (radius) {
			console.error("The server no longer admits you through Radius.");
			break;
		}
		// Launcher-drawn, on the restored terminal: the same words as the web page, then a way back in.
		console.error(endedNotice(admission.role));
		// A local sign-in ended (all devices signed out): the data directory's owner key signs in again.
		if (admission.local) continue;
		const next = await resumeAfterEnded(admission.role, options.url, config, ask);
		saveConfig(config);
		if (!next) break;
		options = { ...options, joinLink: next.joinLink, ownerLink: next.ownerLink };
	}
} catch (error) {
	await client?.close();
	// Launcher errors are its own text (server join errors arrive sanitized to one plain line).
	console.error(
		error instanceof Error && !(error instanceof TypeError)
			? `p2 TUI could not start: ${error.message}`
			: "p2 TUI could not start. Check URL, sign-in and the server TUI bundle.",
	);
	process.exitCode = 1;
}
