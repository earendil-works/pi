/**
 * The presentation host: find or start the session server, attach to a session, run the view.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../../config.ts";
import { socketTransport, type Transport } from "../shared/transport.ts";
import { connect, listSessions } from "./session.ts";
import { runView } from "./view.ts";

const SELF_EXTENSION = extname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL(`../server/entry${SELF_EXTENSION}`, import.meta.url));
const SERVER_START_TIMEOUT_MS = 10_000;

export interface TuiOptions {
	cwd?: string;
	continueSession?: boolean;
}

async function ensureServer(transport: Transport, socketPath: string, sessionsRoot: string): Promise<void> {
	try {
		(await transport.connect()).close();
		return;
	} catch {
		// No server yet; start one.
	}
	// execArgv is forwarded so a parent running under a TypeScript loader produces children that do too.
	const child = spawn(process.execPath, [...process.execArgv, SERVER_ENTRY, socketPath, sessionsRoot], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			(await transport.connect()).close();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("Timed out waiting for the mini session server");
}

export async function runTui(options: TuiOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const root = join(getAgentDir(), "experimental");
	await mkdir(root, { recursive: true });
	const socketPath = join(root, "mini.sock");
	const sessionsRoot = join(root, "mini-sessions");
	const transport = socketTransport(socketPath);
	await ensureServer(transport, socketPath, sessionsRoot);

	let sessionId: string | null = null;
	if (options.continueSession) {
		const sessions = (await listSessions(transport)).filter((session) => session.cwd === cwd);
		sessionId = sessions.sort((left, right) => left.createdAt - right.createdAt).at(-1)?.id ?? null;
	}
	const client = await connect(transport, sessionId, cwd);
	try {
		await runView(client);
	} finally {
		client.close();
	}
}
