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
import { requireTuiNode } from "./tui-sandbox.ts";

const ask = async (question: string): Promise<string> => {
	const input = createInterface({ input: stdin, output: stdout });
	try {
		return await input.question(question);
	} finally {
		input.close();
	}
};

let client: TuiClient | undefined;
let stopping = false;
/** Ends the current run's wait; a signal closes the client without its exit callback. */
let finish: () => void = () => {};
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		stopping = true;
		void (client?.close() ?? Promise.resolve()).finally(() => finish());
	});
try {
	requireTuiNode();
	let options = parseTuiArgs(process.argv.slice(2));
	const config = readConfig();
	// The visitor's own pi keybindings/settings/themes and p2 prefs, read here and sent to the worker as data.
	const sources = localPreferenceSources({ theme: options.theme, noThemes: options.noThemes });
	const current = loadLocalPreferences(sources);
	while (!stopping) {
		const admission: TuiAdmission = await authenticateTui(options, config, (kind) =>
			ask(
				kind === "name"
					? "Your name (shown to the owner and other guests; not verified): "
					: "Owner link (npm run owner-link on the host) or share link: ",
			),
		);
		saveConfig(config);
		const local = launcherPreferences(sources);
		const failures: string[] = [];
		let ended = false;
		let startError: unknown;
		const exited = new Promise<void>((resolve) => {
			finish = resolve;
			void startTuiClient({
				terminal: new ProcessTerminal(),
				url: options.url,
				credentials: { cookie: admission.cookie },
				mouse: local.mouse,
				actions: launcherActions({
					url: options.url,
					credentials: { cookie: admission.cookie },
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
		// Launcher-drawn, on the restored terminal: the same words as the web page, then a way back in.
		console.error(endedNotice(admission.role));
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
