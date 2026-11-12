// Hold a second Pi process's project/tab lease until the test disconnects its IPC channel.
import { borrowProjectBrowser, closeProjectBrowsers } from "../../src/core/readers/browser-client.ts";

process.once("message", (input: { cwd: string; executablePath: string }) => {
	void borrowProjectBrowser(input.cwd, input.executablePath, new AbortController().signal).then(
		(tab) => process.send!({ ok: true, connection: tab.connection }),
		(error: unknown) => process.send!({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
});
process.once("disconnect", () => {
	closeProjectBrowsers();
	process.exit(0);
});
