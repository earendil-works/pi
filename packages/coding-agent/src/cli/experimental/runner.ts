/**
 * Experimental CLI execution layer.
 *
 * Wires the parsed experimental commands to concrete implementations:
 * - `runServer` starts a PiServer on the requested transport addresses.
 * - `runClient` connects a PiClient to a remote PiServer.
 * - `runPi` is not yet implemented; the legacy interactive session flow
 *   remains the entry point for ordinary usage.
 *
 * The server uses the in-memory TestServerService as a minimal
 * PiServerService implementation until a durable harness-backed service is
 * wired in.
 */

import { PiClient } from "@earendil-works/pi-client";
import { createTcpTransportFactory } from "@earendil-works/pi-client/tcp";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { createWebSocketTransportFactory } from "@earendil-works/pi-client/ws";
import { PiServer, type PiServerListener } from "@earendil-works/pi-server";
import { createTcpListener } from "@earendil-works/pi-server/tcp";
import { createUnixListener } from "@earendil-works/pi-server/unix";
import { createWsListener } from "@earendil-works/pi-server/ws";
import { createCodingAgentPiServerService } from "../../server/pi-server-service.ts";
import type { ClientCommand } from "./commands/client.ts";
import type { PiCommand } from "./commands/pi.ts";
import type { ServerCommand } from "./commands/server.ts";
import type { TransportAddress } from "./transport-address.ts";

function listenerFor(address: TransportAddress): PiServerListener {
	switch (address.transport) {
		case "unix":
			return createUnixListener({ path: address.path });
		case "tcp":
			return createTcpListener({ host: address.host, port: address.port });
		case "ws": {
			const parsed = new URL(address.url);
			return createWsListener({
				host: parsed.hostname || "127.0.0.1",
				port: parsed.port ? Number(parsed.port) : defaultWsPort(parsed.protocol),
			});
		}
	}
}

function defaultWsPort(protocol: string): number {
	return protocol === "wss:" ? 443 : 80;
}

function transportFactory(address: TransportAddress) {
	switch (address.transport) {
		case "unix":
			return createUnixTransportFactory({ path: address.path });
		case "tcp":
			return createTcpTransportFactory({ host: address.host, port: address.port });
		case "ws":
			return createWebSocketTransportFactory({ url: address.url });
	}
}

async function waitForShutdown(): Promise<void> {
	await new Promise<void>((resolve) => {
		const stop = (): void => resolve();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

export async function runServer(command: ServerCommand): Promise<void> {
	const addresses = command.listen ?? [];
	if (addresses.length === 0) {
		console.error("server requires at least one --listen address");
		process.exitCode = 1;
		return;
	}
	const service = await createCodingAgentPiServerService();
	const servers: PiServer[] = [];
	for (const address of addresses) {
		const piServer = new PiServer(service, { listeners: [listenerFor(address)] });
		await piServer.start();
		servers.push(piServer);
		console.log(`PiServer listening on ${piServer.addresses.join(", ")}`);
	}
	console.log("Press Ctrl+C to stop");
	await waitForShutdown();
	await Promise.all(servers.map((server) => server.close()));
}

export async function runClient(command: ClientCommand): Promise<void> {
	if (!command.connect) {
		console.error("client requires --connect");
		process.exitCode = 1;
		return;
	}
	const client = new PiClient({ transportFactory: transportFactory(command.connect) });
	try {
		await client.connect();
		console.log("Connected");
		const sessions = await client.listSessions();
		console.log(`Sessions: ${sessions.length}`);
		for (const session of sessions) {
			console.log(`  ${session.id} (${session.sessionName ?? "unnamed"}) @ ${session.cwd}`);
		}
		const handle = await client.createSession({ cwd: process.cwd() });
		console.log(`Created session ${handle.id}`);
		console.log(JSON.stringify(handle.snapshot, null, 2));
	} finally {
		client.disconnect();
	}
}

export function runPi(_command: PiCommand): void {
	console.error("experimental pi command execution is not implemented yet");
	process.exitCode = 1;
}
