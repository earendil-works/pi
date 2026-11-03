// A speech service as sts-server answers (for the voice tests), with a fixed token. /voices lists two engines;
// POST /speak answers a short WAV tone. /room is a voice room as rooms.py specifies, reduced to what p2 relies on: a
// welcome with the members; reset and vad (acknowledged) from anyone; owner-only config, speak (stable IDs, repeats
// acknowledged as duplicates) and cancel; each utterance as tts_start, 0.3 s of a quiet tone as kind-1 frames
// (ID-prefixed, padded to an even offset), tts_done, to every connection; microphone audio relayed as kind-2 frames to
// the other participants, and, with `utterance`, once per connection after a second of audio: speech_start, talking,
// an interim with the utterance's first word, speech_end, then a final with that text to the speaker. It records each
// upgrade's headers, what it was asked to say, and the text commands it received.
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export const VOICES = {
	engines: [
		{
			id: "supertonic",
			name: "Supertonic",
			streaming: false,
			sampleRate: 16000,
			voices: [
				{ id: "supertonic-F1", name: "F1" },
				{ id: "supertonic-F2", name: "F2" },
			],
			languages: [
				{ id: "en", name: "English" },
				{ id: "fr", name: "Français" },
				{ id: "de", name: "Deutsch" },
			],
			defaultLanguage: "en",
		},
		{
			id: "kokoro",
			name: "Kokoro",
			streaming: false,
			sampleRate: 24000,
			voices: [{ id: "kokoro-af_heart", name: "Heart" }],
			languages: [{ id: "en", name: "English" }],
			defaultLanguage: "en",
		},
	],
	default: { engine: "supertonic", voice: "supertonic-F1", language: "en" },
};

/** `seconds` of a quiet 440 Hz tone, 16-bit mono PCM. */
function tone(seconds: number, rate: number): Buffer {
	const samples = Math.round(seconds * rate);
	const pcm = Buffer.alloc(samples * 2);
	for (let index = 0; index < samples; index++)
		pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 3000), index * 2);
	return pcm;
}

function wav(pcm: Buffer, rate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** A binary room frame: kind, the ID's length, the ID, a pad byte to an even offset, then PCM. */
export function roomFrame(kind: number, id: string, pcm: Buffer): Buffer {
	const pad = (2 + id.length) & 1;
	return Buffer.concat([Buffer.from([kind, id.length]), Buffer.from(id, "ascii"), Buffer.alloc(pad), pcm]);
}

type Member = { id: string; name: string; role: string };
type Connection = { ws: WebSocket; member: Member; room: string; bytes: number; said: boolean };

export async function fakeSpeechService(token: string, options: { utterance?: string } = {}) {
	const upgrades: IncomingHttpHeaders[] = [];
	const spoken: { id: string; text: string; room: string; voice?: string; engine?: string }[] = [];
	const commands: { from: string; command: Record<string, unknown> }[] = [];
	const received: Buffer[] = [];
	const samples: Record<string, unknown>[] = [];
	const connections = new Set<Connection>();
	const rooms = new Map<string, { config: { engine: string; voice: string; speed: number }; said: Set<string> }>();
	const server: Server = createServer((request, response) => {
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401).end();
			return;
		}
		if (request.url === "/voices") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(VOICES));
			return;
		}
		if (request.url === "/speak" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				samples.push(JSON.parse(body) as Record<string, unknown>);
				response.writeHead(200, { "Content-Type": "audio/wav" });
				response.end(wav(tone(0.3, 16000), 16000));
			});
			return;
		}
		response.writeHead(404).end();
	});
	const sockets = new WebSocketServer({ noServer: true });
	const others = (connection: Connection) =>
		[...connections].filter((other) => other.room === connection.room && other.member.id !== connection.member.id);
	const everyone = (room: string) => [...connections].filter((other) => other.room === room);
	const send = (ws: WebSocket, event: unknown) => ws.send(JSON.stringify(event));
	server.on("upgrade", (request, socket, head) => {
		const headers = request.headers;
		if (request.url !== "/room" || headers.authorization !== `Bearer ${token}`) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return;
		}
		upgrades.push(headers);
		const room = String(headers["x-room"]);
		const member = {
			id: String(headers["x-participant-id"]),
			name: decodeURIComponent(String(headers["x-participant-name"])),
			role: String(headers["x-participant-role"]),
		};
		sockets.handleUpgrade(request, socket, head, (ws) => {
			const connection: Connection = { ws, member, room, bytes: 0, said: false };
			const state = rooms.get(room) ?? {
				config: { engine: VOICES.default.engine, voice: VOICES.default.voice, speed: 1 },
				said: new Set<string>(),
			};
			rooms.set(room, state);
			connections.add(connection);
			send(ws, {
				type: "welcome",
				room,
				you: { ...member, connections: 1, connectionId: String(connections.size) },
				members: everyone(room).map((other) => ({ ...other.member, connections: 1 })),
				tts: state.config,
				current: null,
				micSampleRate: 16000,
				limits: {},
			});
			for (const other of others(connection))
				send(other.ws, { type: "member_joined", member: { ...member, connections: 1 } });
			ws.on("close", () => {
				connections.delete(connection);
				for (const other of others(connection))
					send(other.ws, { type: "member_left", member: { ...member, connections: 0 } });
			});
			ws.on("message", (data: Buffer, binary: boolean) => {
				if (binary) {
					received.push(data);
					connection.bytes += data.length;
					for (const other of others(connection)) other.ws.send(roomFrame(2, member.id, data));
					if (options.utterance !== undefined && !connection.said && connection.bytes >= 32000) {
						connection.said = true;
						send(ws, { type: "speech_start" });
						for (const other of everyone(room))
							send(other.ws, { type: "talking", participant: member.id, on: true });
						send(ws, { type: "interim", text: options.utterance.split(" ")[0], ms: 1 });
						send(ws, { type: "speech_end" });
						for (const other of everyone(room))
							send(other.ws, { type: "talking", participant: member.id, on: false });
						send(ws, { type: "final", text: options.utterance, ms: 1 });
					}
					return;
				}
				const command = JSON.parse(data.toString()) as { type: string; id?: string; text?: string } & Record<
					string,
					unknown
				>;
				commands.push({ from: member.id, command });
				if (command.type === "reset") return;
				if (command.type === "vad") {
					send(ws, { type: "vad", silence: command.silence });
					return;
				}
				if (member.role !== "owner") {
					send(ws, { type: "error", code: "forbidden", message: "owner only" });
					return;
				}
				if (command.type === "config") {
					state.config = { ...state.config, ...(command as Partial<typeof state.config>) };
					for (const other of everyone(room)) send(other.ws, { type: "config", ...state.config });
				} else if (command.type === "speak" && command.id && command.text) {
					const duplicate = state.said.has(command.id);
					send(ws, { type: "speak_ack", id: command.id, duplicate });
					if (duplicate) return;
					state.said.add(command.id);
					const { id, text } = command;
					spoken.push({ id, text, room, engine: state.config.engine, voice: state.config.voice });
					const rate = VOICES.engines.find((engine) => engine.id === state.config.engine)?.sampleRate ?? 16000;
					const pcm = tone(0.3, rate);
					for (const other of everyone(room)) {
						send(other.ws, {
							type: "tts_start",
							id,
							engine: state.config.engine,
							voice: state.config.voice,
							sampleRate: rate,
						});
						other.ws.send(roomFrame(1, id, pcm.subarray(0, 1000)));
						other.ws.send(roomFrame(1, id, pcm.subarray(1000)));
						send(other.ws, { type: "tts_done", id, cancelled: false });
					}
				}
			});
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		upgrades,
		spoken,
		commands,
		received,
		samples,
		close: () => {
			for (const client of sockets.clients) client.terminate();
			server.close();
		},
	};
}
