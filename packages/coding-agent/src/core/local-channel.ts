// Bounded newline-delimited JSON transport for local workers and pane viewers.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

const MAX_PACKET_BYTES = 1024 * 1024;
const PROOF = /^[0-9a-f]{64}$/;
type Purpose = "job-status-request" | "job-stop-request" | "job-reply" | "pane-client" | "pane-server";

/** Prove a local endpoint's role without transmitting its reusable private token. */
export function localProof(token: string, purpose: Purpose): string {
	return createHmac("sha256", token).update(purpose).digest("hex");
}

/** Authenticate a local peer, including servers whose persisted TCP port may have been reused. */
export function verifyLocalProof(token: string, purpose: Purpose, proof: string): boolean {
	return (
		PROOF.test(proof) &&
		timingSafeEqual(Buffer.from(proof, "hex"), createHmac("sha256", token).update(purpose).digest())
	);
}

/** Read complete JSON packets, rejecting malformed or oversized local wire input. */
export function receivePackets(socket: Socket, receive: (packet: unknown) => void): void {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let bytes = 0;
	socket.on("data", (data: Buffer) => {
		bytes += data.length;
		pending += decoder.write(data);
		for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
			const line = pending.slice(0, newline);
			if (Buffer.byteLength(line) > MAX_PACKET_BYTES) {
				socket.destroy(new Error("Local message exceeds 1 MiB"));
				return;
			}
			pending = pending.slice(newline + 1);
			bytes = Buffer.byteLength(pending);
			let packet: unknown;
			try {
				packet = JSON.parse(line);
			} catch {
				socket.destroy(new Error("Invalid local JSON message"));
				return;
			}
			receive(packet);
			if (socket.destroyed) return;
		}
		if (bytes > MAX_PACKET_BYTES) socket.destroy(new Error("Local message exceeds 1 MiB"));
	});
}

/** Send one local message, disconnecting clients that cannot keep up with updates. */
export function sendPacket(socket: Socket, packet: unknown): void {
	if (socket.destroyed) return;
	const encoded = `${JSON.stringify(packet)}\n`;
	if (Buffer.byteLength(encoded) > MAX_PACKET_BYTES || socket.writableLength > MAX_PACKET_BYTES) {
		socket.destroy(new Error("Local client output limit exceeded"));
		return;
	}
	socket.write(encoded);
}
