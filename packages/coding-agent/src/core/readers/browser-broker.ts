// Own a sandboxed persistent browser until the last authenticated Pi client releases its lease.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { lock } from "proper-lockfile";
import { Compile } from "typebox/compile";
import { launchProjectBrowser } from "./browser-launch.ts";
import {
	MAX_BROWSER_MESSAGE_BYTES,
	type ProjectBrowserInit,
	type ProjectBrowserMetadata,
	ProjectBrowserRequestSchema,
	type ProjectBrowserResponse,
} from "./browser-protocol.ts";

const requestValidator = Compile(ProjectBrowserRequestSchema);

/** Serve authenticated project/tab leases; onStopped owns final process teardown after browser cleanup. */
export async function serveProjectBrowser(
	init: ProjectBrowserInit,
	onStopped: () => void,
): Promise<{ metadata: ProjectBrowserMetadata; close: () => Promise<void> }> {
	const token = randomBytes(32).toString("hex");
	const clients = new Set<Socket>();
	const sockets = new Set<Socket>();
	let browser: ReturnType<typeof launchProjectBrowser> | undefined;
	let closing = false;
	let stopping: Promise<void> | undefined;
	let idle: ReturnType<typeof setTimeout>;
	const metadataPath = join(init.profileDir, "broker.json");
	const reply = (socket: Socket, response: ProjectBrowserResponse) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
	};
	const scheduleIdle = (milliseconds = 250) => {
		clearTimeout(idle);
		if (!clients.size && !closing) idle = setTimeout(() => void stop(false), milliseconds);
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		let page: Page | undefined;
		let buffer = "";
		socket.on("error", () => {});
		socket.on("end", () => socket.destroy());
		socket.once("close", () => {
			sockets.delete(socket);
			clients.delete(socket);
			void page?.close().catch(() => {});
			scheduleIdle();
		});
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => socket.destroy());
		const onData = (data: string) => {
			buffer += data;
			if (Buffer.byteLength(buffer) > MAX_BROWSER_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			if (!buffer.includes("\n")) return;
			socket.removeListener("data", onData);
			void (async () => {
				try {
					const request: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
					// Authenticate this control connection before handing out tabs or the CDP endpoint.
					if (!requestValidator.Check(request)) throw new Error("Invalid project browser request");
					const received = Buffer.from(request.token);
					const expected = Buffer.from(token);
					if (received.length !== expected.length || !timingSafeEqual(received, expected))
						throw new Error("Project browser authentication failed");
					if (request.settingsKey !== init.settingsKey)
						throw new Error(
							"Project browser already uses different browser/proxy settings or Pi version; close Pi sessions using this project before changing them",
						);
					if (closing) throw new Error("Project browser is shutting down");
					socket.setTimeout(0);
					clients.add(socket);
					clearTimeout(idle);
					if (!browser) {
						browser = launchProjectBrowser(init.profileDir, init.executablePath);
						void browser.then(
							({ context }) =>
								context.once("close", () => {
									for (const client of clients) client.destroy();
								}),
							() => {},
						);
					}
					const owned = await browser;
					if (socket.destroyed) return;
					let pageUrl = "";
					if (request.action === "page") {
						page = await owned.context.newPage();
						if (socket.destroyed) {
							await page.close();
							return;
						}
						page.on("popup", (popup) => void popup.close().catch(() => {}));
						// Interception belongs to the owning CDP connection, not a later extraction attachment.
						await page.route("**/*", async (route) => {
							const protocol = new URL(route.request().url()).protocol;
							if (["http:", "https:", "data:", "blob:"].includes(protocol)) await route.continue();
							else await route.abort();
						});
						pageUrl = `about:blank#pi-${randomUUID()}`;
						await page.goto(pageUrl);
					}
					reply(socket, { ok: true, endpoint: owned.endpoint, pageUrl });
				} catch (error) {
					reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
					socket.end();
				}
			})();
		};
		socket.on("data", onData);
	});
	const stop = async (force: boolean): Promise<void> => {
		if (stopping) return stopping;
		stopping = (async () => {
			const unlock = await lock(init.profileDir, {
				lockfilePath: join(init.profileDir, "control.lock"),
				retries: { retries: 200, factor: 1, minTimeout: 100, maxTimeout: 100 },
			});
			try {
				if (clients.size && !force) return;
				closing = true;
				clearTimeout(idle);
				// Playwright's exit hook kills only the browser it launched if graceful close stalls.
				const deadline = setTimeout(onStopped, 5000);
				try {
					for (const socket of sockets) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					await browser?.then(
						({ context }) => context.close(),
						() => {},
					);
					const current: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
					if (current && typeof current === "object" && "token" in current && current.token === token)
						await rm(metadataPath, { force: true });
				} finally {
					clearTimeout(deadline);
				}
			} finally {
				await unlock();
			}
			if (closing) onStopped();
		})();
		try {
			await stopping;
		} finally {
			if (!closing) stopping = undefined;
		}
	};
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Project browser did not bind a loopback port");
	const metadata = { port: address.port, token };
	try {
		await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
	} catch (error) {
		server.close();
		throw error;
	}
	scheduleIdle(5000);
	return { metadata, close: () => stop(true) };
}
