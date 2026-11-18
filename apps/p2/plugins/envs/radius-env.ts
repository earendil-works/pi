// Machines running `pi-env agent` (envs.json type `radius`): a pi-env connection whose byte stream is a client channel
// of this p2's owner to the machine's Radius server ID (src/runtime/radius-client.ts). Its first message is the head
// `{ type: "pi-env", token }`; then the agent's output arrives as binary messages, starting with `PI-ENV <token>\n`, and
// requests go out as binary messages, exactly the stream `pi-env serve` has on stdio. Closing the channel ends what the
// agent started for it. Never local execution: without a Radius sign-in, or while the machine is offline, the start
// fails with the reason and the next request tries again.

import { Connection, type ConnectionOptions, type Transport, type TransportEvents } from "@earendil-works/pi-env";
import { type OwnerRadius, ownerRadiusAccess, radiusClientChannel } from "@p2/app/v1/node";
import type { WebSocket } from "ws";
import type { RadiusEnvConfig } from "./schema.ts";

/** A connection to machine `name` (`config.server` at Radius) that opens its channel at its first request. */
export function radiusEnvConnection(
	directory: string,
	name: string,
	config: RadiusEnvConfig,
	onLog?: ConnectionOptions["onLog"],
): Connection {
	const access = ownerRadiusAccess(directory);
	return new Connection({
		transport: (token, events) => openChannel(access, name, config.server, token, events),
		...(onLog === undefined ? {} : { onLog }),
	});
}

async function openChannel(
	access: () => Promise<OwnerRadius>,
	name: string,
	server: string,
	token: string,
	events: TransportEvents,
): Promise<Transport> {
	const { gateway, token: bearer } = await access();
	const socket = radiusClientChannel(gateway, server, bearer);
	await opened(socket, name);
	socket.send(JSON.stringify({ type: "pi-env", token }));
	socket.on("message", (data: Buffer, binary) => {
		if (binary) return events.data(data);
		// The agent sends bytes only; text means something else answers on this channel.
		socket.terminate();
		events.end(`Machine "${name}" answered with something other than pi-env`);
	});
	socket.on("close", (code, reason) =>
		events.end(
			`The connection to machine "${name}" through Radius closed (${code}${reason.length ? ` ${reason.toString("utf8")}` : ""})`,
		),
	);
	return { write: (data) => socket.send(data), close: () => socket.close(1000) };
}

/** Resolves once Radius paired the channel with the machine; rejects with why it did not. */
function opened(socket: WebSocket, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// A refused connection to a host with several addresses is an AggregateError without a message, only a code.
		socket.on("error", (error) =>
			reject(
				new Error(
					`Could not reach Radius for machine "${name}": ${error.message || (error as NodeJS.ErrnoException).code || error.name}`,
				),
			),
		);
		socket.once("open", () => resolve());
		// With this listener `ws` leaves a refused upgrade open: read why, then end it.
		socket.on("unexpected-response", (_request, response) => {
			let body = "";
			response.on("data", (chunk: Buffer) => {
				if (body.length < 200) body += chunk.toString("utf8");
			});
			response.on("end", () => {
				reject(new Error(refusal(name, response.statusCode ?? 502, body.slice(0, 200).trim())));
				socket.terminate();
			});
		});
		socket.once("close", (code) =>
			reject(new Error(`The connection to machine "${name}" through Radius closed (${code})`)),
		);
	});
}

/** What a refused channel means for the owner (Radius's status, with its message). */
function refusal(name: string, status: number, body: string): string {
	const detail = `${status}${body ? `: ${body}` : ""}`;
	if (status === 503)
		return `Machine "${name}" is not connected to Radius: it is offline or its pi-env agent is not running (${detail})`;
	if (status === 401) return `Radius did not accept this p2's sign-in (${detail}); run npm run radius:login`;
	if (status === 404) return `Radius does not know machine "${name}" (${detail}); it may have been removed`;
	return `Radius refused the connection to machine "${name}" (${detail})`;
}
