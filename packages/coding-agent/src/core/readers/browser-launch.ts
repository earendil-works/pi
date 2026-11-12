// Launch installed Chromium with a dedicated persistent Pi profile, never a personal browser profile.
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { type BrowserContext, chromium } from "playwright-core";

/** Launch a sandboxed project browser and expose its loopback-only CDP endpoint. */
export async function launchProjectBrowser(
	profileDir: string,
	override: string | undefined,
): Promise<{ context: BrowserContext; endpoint: string }> {
	const executablePath = await findBrowser(override);
	const configuredProxy =
		process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	const proxy = configuredProxy ? new URL(configuredProxy) : undefined;
	const context = await chromium.launchPersistentContext(profileDir, {
		executablePath,
		headless: true,
		chromiumSandbox: true,
		acceptDownloads: false,
		serviceWorkers: "block",
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
		...(proxy
			? {
					proxy: {
						server: `${proxy.protocol}//${proxy.host}`,
						username: decodeURIComponent(proxy.username),
						password: decodeURIComponent(proxy.password),
						bypass: process.env.NO_PROXY ?? process.env.no_proxy,
					},
				}
			: {}),
		timeout: 15_000,
	});
	try {
		const [port, target] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n");
		// Chromium's discovery file is a wire boundary, not permission to connect to an arbitrary endpoint.
		if (
			!/^\d+$/.test(port) ||
			Number(port) < 1 ||
			Number(port) > 65535 ||
			!/^\/devtools\/browser\/[a-z0-9-]+$/i.test(target)
		)
			throw new Error("Project browser returned an invalid debugging endpoint");
		// Chromium creates an initial blank page; only leased tabs should stay open.
		await Promise.all(context.pages().map((page) => page.close()));
		return { context, endpoint: `ws://127.0.0.1:${port}${target}` };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function findBrowser(configured: string | undefined): Promise<string> {
	if (configured) {
		const path = resolve(configured);
		await access(path, constants.X_OK);
		return path;
	}
	const candidates =
		process.platform === "darwin"
			? ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Helium"].flatMap((name) => [
					`/Applications/${name}.app/Contents/MacOS/${name}`,
					join(homedir(), "Applications", `${name}.app`, "Contents", "MacOS", name),
				])
			: process.platform === "win32"
				? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
						.filter((root): root is string => Boolean(root))
						.flatMap((root) => [
							join(root, "Google", "Chrome", "Application", "chrome.exe"),
							join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
						])
				: [];
	for (const directory of (process.env.PATH ?? "").split(delimiter))
		for (const name of process.platform === "win32"
			? ["chrome.exe", "msedge.exe", "chromium.exe"]
			: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"])
			if (directory) candidates.push(join(directory, name));
	for (const path of candidates) {
		try {
			await access(path, constants.X_OK);
			return path;
		} catch {
			/* Continue installed-browser discovery. */
		}
	}
	throw new Error(
		"No installed Chromium browser found. Install Chrome/Chromium or set read.browserExecutablePath; pi never downloads a browser.",
	);
}
