// Keep one process lease per project and borrow separately owned tabs from its browser broker.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { Compile } from "typebox/compile";
import { getAgentDir, getReaderInvocation, VERSION } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import {
	MAX_BROWSER_MESSAGE_BYTES,
	type ProjectBrowserConnection,
	type ProjectBrowserInit,
	type ProjectBrowserMetadata,
	ProjectBrowserMetadataSchema,
	ProjectBrowserResponseSchema,
} from "./browser-protocol.ts";

const metadataValidator = Compile(ProjectBrowserMetadataSchema);
const responseValidator = Compile(ProjectBrowserResponseSchema);
interface ProjectLease {
	settingsKey: string;
	pending: number;
	retained: boolean;
	connection: Promise<{ socket: Socket; metadata: ProjectBrowserMetadata }>;
	pages: Set<Socket>;
}
const projects = new Map<string, ProjectLease>();
process.once("exit", closeProjectBrowsers);

/** Borrow a tab in the project's persistent browser; releasing it never closes another client's tab. */
export async function borrowProjectBrowser(
	cwd: string,
	executablePath: string | undefined,
	signal: AbortSignal,
): Promise<{ connection: ProjectBrowserConnection; release: () => void }> {
	signal.throwIfAborted();
	const project = await realpath(cwd);
	const key = createHash("sha256").update(project).digest("hex").slice(0, 24);
	const profileDir = join(getAgentDir(), "browser", key);
	const settingsKey = createHash("sha256")
		.update(
			JSON.stringify([
				VERSION,
				executablePath,
				process.env.HTTPS_PROXY,
				process.env.https_proxy,
				process.env.HTTP_PROXY,
				process.env.http_proxy,
				process.env.NO_PROXY,
				process.env.no_proxy,
			]),
		)
		.digest("hex");
	let lease = projects.get(profileDir);
	if (lease && lease.settingsKey !== settingsKey)
		throw new Error(
			"Project browser settings changed; close Pi sessions using this project before changing the browser or proxy",
		);
	if (!lease) {
		lease = {
			settingsKey,
			pending: 0,
			retained: false,
			connection: openProject({ profileDir, settingsKey, executablePath }),
			pages: new Set(),
		};
		projects.set(profileDir, lease);
		const entry = lease;
		void entry.connection.then(
			({ socket }) =>
				socket.once("close", () => {
					if (projects.get(profileDir) === entry) projects.delete(profileDir);
				}),
			() => {
				if (projects.get(profileDir) === entry) projects.delete(profileDir);
			},
		);
	}
	lease.pending++;
	try {
		const { metadata } = await raceWithAbortSignal(lease.connection, signal);
		const { socket, response } = await requestBrowser(metadata, settingsKey, "page", signal);
		lease.retained = true;
		lease.pages.add(socket);
		const entry = lease;
		return {
			connection: { endpoint: response.endpoint, pageUrl: response.pageUrl },
			release: () => {
				entry.pages.delete(socket);
				socket.destroy();
			},
		};
	} finally {
		lease.pending--;
		if (!lease.pending && !lease.retained) {
			if (projects.get(profileDir) === lease) projects.delete(profileDir);
			void lease.connection.then(
				({ socket }) => socket.destroy(),
				() => {},
			);
		}
	}
}

/** Drop this process's browser leases; other Pi processes retain their own leases. */
export function closeProjectBrowsers(): void {
	for (const lease of projects.values()) {
		for (const socket of lease.pages) socket.destroy();
		void lease.connection.then(
			({ socket }) => socket.destroy(),
			() => {},
		);
	}
	projects.clear();
}

async function openProject(init: ProjectBrowserInit): Promise<{ socket: Socket; metadata: ProjectBrowserMetadata }> {
	await mkdir(init.profileDir, { recursive: true, mode: 0o700 });
	// The same lock protects startup and shutdown, so a new client cannot race profile teardown.
	const unlock = await lock(init.profileDir, {
		lockfilePath: join(init.profileDir, "control.lock"),
		retries: { retries: 200, factor: 1, minTimeout: 100, maxTimeout: 100 },
	});
	try {
		let metadata: ProjectBrowserMetadata | undefined;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(init.profileDir, "broker.json"), "utf8"));
			if (metadataValidator.Check(parsed)) metadata = parsed;
		} catch (error) {
			if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw error;
		}
		if (metadata) {
			try {
				const { socket } = await requestBrowser(metadata, init.settingsKey, "lease");
				return { socket, metadata };
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ECONNREFUSED")) throw error;
				// A dead broker's metadata is not evidence that any saved PID is safe to kill.
			}
		}
		metadata = await startBroker(init);
		const { socket } = await requestBrowser(metadata, init.settingsKey, "lease");
		return { socket, metadata };
	} finally {
		await unlock();
	}
}

function startBroker(init: ProjectBrowserInit): Promise<ProjectBrowserMetadata> {
	const invocation = getReaderInvocation("browser");
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.executable, invocation.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			serialization: "advanced",
			env: invocation.bunBinary ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
		});
		let ready = false;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Project browser broker did not start within 5 seconds"));
		}, 5000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			if (!ready) reject(new Error("Project browser broker exited before becoming ready"));
		});
		child.once("message", (message: unknown) => {
			clearTimeout(timer);
			if (!metadataValidator.Check(message)) {
				child.kill("SIGTERM");
				reject(new Error("Invalid project browser broker handshake"));
				return;
			}
			ready = true;
			child.unref();
			resolve(message);
		});
		child.send(init, (error) => {
			if (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
	});
}

async function requestBrowser(
	metadata: ProjectBrowserMetadata,
	settingsKey: string,
	action: "lease" | "page",
	signal?: AbortSignal,
): Promise<{ socket: Socket; response: ProjectBrowserConnection }> {
	signal?.throwIfAborted();
	const socket = createConnection({ host: "127.0.0.1", port: metadata.port });
	try {
		const response = await new Promise<ProjectBrowserConnection>((resolve, reject) => {
			let buffer = "";
			const abort = () => socket.destroy(new Error("Read operation aborted"));
			const cleanup = () => {
				socket.setTimeout(0);
				signal?.removeEventListener("abort", abort);
				socket.removeListener("data", onData);
			};
			const onData = (data: string) => {
				buffer += data;
				if (Buffer.byteLength(buffer) > MAX_BROWSER_MESSAGE_BYTES) {
					socket.destroy(new Error("Project browser handshake exceeds its size limit"));
					return;
				}
				if (!buffer.includes("\n")) return;
				try {
					const parsed: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
					if (!responseValidator.Check(parsed)) throw new Error("Invalid project browser response");
					if (!parsed.ok) throw new Error(parsed.error);
					cleanup();
					socket.unref();
					resolve({ endpoint: parsed.endpoint, pageUrl: parsed.pageUrl });
				} catch (error) {
					cleanup();
					reject(error);
				}
			};
			socket.setEncoding("utf8");
			socket.setTimeout(20_000, () => socket.destroy(new Error("Project browser handshake timed out")));
			socket.once("connect", () =>
				socket.write(`${JSON.stringify({ token: metadata.token, settingsKey, action })}\n`),
			);
			socket.on("data", onData);
			socket.on("error", (error) => {
				cleanup();
				reject(error);
			});
			socket.on("end", () => socket.destroy());
			socket.once("close", () => {
				cleanup();
				reject(new Error("Project browser connection closed"));
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
		return { socket, response };
	} catch (error) {
		socket.destroy();
		throw error;
	}
}
