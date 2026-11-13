// Voice mode (server): browsers reach the speech service (sts-server) only through p2, which signs it in and tells it
// who is talking (the token never leaves the server). `voice.json` in the data dir names the service and its token;
// without it voice mode is off. Each conversation is a voice room: the owner's browser has Pi's speech synthesized
// once for everyone, each person's microphone becomes their own messages and is relayed to the others. The owner and
// read/write guests of the session take part (a guest's grant is rechecked while its socket lives); only the owner
// speaks for Pi or sets the voice. View-only guests get nothing.
//
// The configuration is pushed, not asked for: VoiceService (contract.ts) publishes the service's engines and default
// (the service's /voices), or null without a valid voice.json. While anyone holds it, the data dir is watched, and each
// change of voice.json (written, replaced, removed) fetches the voices again, so the composer's button follows it live.
//
//   WS   /voice/room?session=…&conversation=…  bridged to the service's /room (room p2-<session>-<conversation>)
//   POST /voice/sample  { engine?, voice?, speed } -> audio/wav of a short sample (the owner's settings sheet)
//   POST /voice/log     { client, events: [{ t, message }] } -> 204; each event becomes a `[voice …]` line of the log
import { type FSWatcher, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { compile, nul, obj, type Static, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	type Ctx,
	canSend,
	contribute,
	DEFAULT_OWNER_NAME,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	type P2Principal,
	principalKey,
	signalOf,
} from "@p2/app/v1";
import { optionalText, stripJsonComments } from "@p2/app/v1/node";
import {
	fromOrigin,
	mayReach,
	type RequestAccess,
	Routes,
	Server,
	SessionAccess,
	sendJson,
	serverOf,
	Upgrades,
} from "@p2/app/v1/server";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { ModelConfig } from "../models/contract.ts";
import { VoiceService, VoiceServiceStore } from "./contract.ts";
import {
	LogSchema,
	MAX_LOG_EVENTS,
	MAX_LOG_MESSAGE,
	RoomCommandSchema,
	RoomPersonalSchema,
	roomName,
	SAMPLE_TEXT,
	SampleSchema,
	type Voices,
	VoicesSchema,
} from "./protocol.ts";

const ConfigSchema = obj(
	{
		/** The speech service's base URL, `https://voice.example.com`. */
		url: str({ pattern: "^https?://" }),
		token: str({ minLength: 1 }),
	},
	{ open: true },
);
type Config = Static<typeof ConfigSchema>;
const isConfig = compile(ConfigSchema).check;
const isVoices = compile(VoicesSchema).check;
const isLog = compile(LogSchema).check;
const isSample = compile(SampleSchema).check;
const isRoomCommand = compile(RoomCommandSchema).check;
const isRoomPersonal = compile(RoomPersonalSchema).check;

/** `voice.json`, read on every request so edits apply at once; undefined when missing or invalid. */
async function readConfig(dataDir: string): Promise<Config | undefined> {
	const text = await optionalText(join(dataDir, "voice.json"));
	if (text === undefined) return undefined;
	try {
		const config: unknown = JSON.parse(stripJsonComments(text));
		return isConfig(config) ? { ...config, url: config.url.replace(/\/+$/, "") } : undefined;
	} catch {
		return undefined;
	}
}

/** The service's engines and default (its `/voices`). */
async function fetchVoices(config: Config, signal: AbortSignal): Promise<Voices> {
	const reply = await fetch(`${config.url}/voices`, {
		headers: { Authorization: `Bearer ${config.token}` },
		signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
	});
	if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
	const voices: unknown = await reply.json();
	if (!isVoices(voices)) throw new Error("unexpected /voices answer");
	return { engines: voices.engines, default: voices.default };
}

/** How long voice.json must be quiet before it is read (editors and `mv` change it in several steps). */
const SETTLE_MS = 200;

/** Counts changes of `voice.json` (and refresh requests) and wakes the task waiting for the next one. */
class ConfigChanges {
	version = 0;
	readonly #waiters = new Set<() => void>();
	readonly #watcher: FSWatcher;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(dataDir: string) {
		// The directory, not the file: the file may not exist yet, and a replaced or removed file ends a file watch.
		this.#watcher = watch(dataDir, (_event, name) => {
			if (name !== null && name !== "voice.json") return;
			clearTimeout(this.#timer);
			this.#timer = setTimeout(() => this.bump(), SETTLE_MS);
		});
		this.#watcher.on("error", (error) => console.error(`[voice] Watching voice.json failed: ${error.message}`));
	}

	bump(): void {
		this.version++;
		for (const wake of [...this.#waiters]) wake();
	}

	next(seen: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			if (this.version !== seen) return resolve();
			const wake = (): void => {
				this.#waiters.delete(wake);
				signal.removeEventListener("abort", abort);
				resolve();
			};
			const abort = (): void => {
				this.#waiters.delete(wake);
				reject(signal.reason);
			};
			this.#waiters.add(wake);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	close(): void {
		clearTimeout(this.#timer);
		this.#watcher.close();
		for (const wake of [...this.#waiters]) wake();
	}
}

async function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > limit) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const refuse = (socket: Duplex, status: string): void => {
	socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
};

/** Sockets one principal may hold per route (tabs and reconnects; more is abuse of the speech service). */
const MAX_SOCKETS = 4;
/** How often a guest's open socket checks that its grant still holds. */
const GUEST_RECHECK_MS = 30_000;

/** The speech service's voices and why they are unknown (in memory). */
const Service = defineTypedState("p2.voice-service-store", {
	schema: obj({ voices: union([VoicesSchema, nul()]), failure: union([str(), nul()]) }),
	version: 2,
	initial: () => ({ voices: null, failure: null }),
});

export default defineFacet((host) => {
	host.serve(VoiceServiceStore, (_params, self) => {
		const server = self.get(Server, {});
		const service = self.state(Service);
		const changes = self.open(
			async () => new ConfigChanges(server.info.value.dataDir),
			(changes) => changes.close(),
		);
		// Subscribed before reading, so no change is missed; a change during a fetch reads again.
		self.onLive(async (ctx) => {
			while (!signalOf(ctx).aborted) {
				const seen = changes.value.version;
				let next: { voices: Voices | null; failure: string | null };
				try {
					const current = await readConfig(server.info.value.dataDir);
					next = { voices: current ? await fetchVoices(current, signalOf(ctx)) : null, failure: null };
				} catch (failure) {
					if (signalOf(ctx).aborted) return;
					next = { voices: null, failure: `Speech service unreachable: ${(failure as Error).message}` };
				}
				if (changes.value.version === seen)
					await service.change((draft) => {
						// A draft's arrays are mutable; the fetched voices are the same JSON.
						draft.voices = next.voices as typeof draft.voices;
						draft.failure = next.failure;
					}, ctx);
				await changes.value.next(seen, signalOf(ctx)).catch(() => {});
			}
		});
		return {
			voices: deriveTyped(self, [service], ([value]) => value.voices),
			failure: self.derive([service], ([value]) => value.failure),
			refresh: async () => {
				changes.value.bump();
				return null;
			},
		};
	});

	// Guests' objects are per grant revision, so a revoked grant ends this one.
	host.serve(VoiceService, (_params, principal, self) => {
		if (!isOwner(principal) && !(isGuest(principal) && Object.values(principal.sessions).includes("full")))
			throw forbidden("owners and read/write guests only");
		const store = self.get(VoiceServiceStore, {});
		// A service that was unreachable is asked again whenever someone starts looking.
		self.onLive(async (ctx) => {
			if (store.failure.value !== null) await store.refresh(ctx);
		});
		return { variant: "talker", members: { voices: store.voices, failure: store.failure } };
	});

	contribute(host, "p2.voice-routes", (self) => {
		const server = self.get(Server, {});
		const access = self.registry(SessionAccess);
		const natives = serverOf(self);
		const config = () => readConfig(server.info.value.dataDir);
		/** The owner, or a guest `session` (by default its home) is shared with read/write, whose grant is current. */
		const mayTalk = async (principal: P2Principal | undefined, ctx: Ctx, session?: string): Promise<boolean> => {
			if (isOwner(principal)) return true;
			if (!isGuest(principal)) return false;
			const target = session ?? principal.home;
			return canSend(principal, target) && (await mayReach(access.value, principal, target, ctx));
		};
		const models = self.get(ModelConfig, {});
		/** settings.json's `ownerName`, read when the owner joins a room. */
		const ownerName = (): string => {
			try {
				return models.snapshot.value.settings.ownerName ?? DEFAULT_OWNER_NAME;
			} catch {
				return DEFAULT_OWNER_NAME;
			}
		};
		/** Open sockets per route and principal. */
		const open = new Map<string, number>();
		/**
		 * Counts `browser` against its principal's limit until it closes; false (and closed) beyond it. A guest's socket
		 * closes once its grant no longer holds.
		 */
		const admit = (route: string, principal: P2Principal, browser: WebSocket, session?: string): boolean => {
			const key = `${route} ${principalKey(principal)}`;
			const count = open.get(key) ?? 0;
			if (count >= MAX_SOCKETS) {
				browser.close(1008, "Too many voice connections");
				return false;
			}
			open.set(key, count + 1);
			const recheck = isGuest(principal)
				? setInterval(() => {
						// A timer of the socket, nothing at hand: the background context.
						void natives()
							.root((ctx) => mayTalk(principal, ctx, session), BACKGROUND_CONTEXT)
							.catch(() => false)
							.then((allowed) => {
								if (!allowed) browser.close(1008, "Access ended");
							});
					}, GUEST_RECHECK_MS)
				: undefined;
			browser.once("close", () => {
				clearInterval(recheck);
				const left = (open.get(key) ?? 1) - 1;
				if (left > 0) open.set(key, left);
				else open.delete(key);
			});
			return true;
		};
		const sockets = self.open(
			async () => new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }),
			(wss) => {
				for (const client of wss.clients) client.terminate();
				wss.close();
			},
		);

		// The browser's diagnostics: the phone's console is out of reach, the server's log (stdout) is not.
		const log = async (
			request: IncomingMessage,
			response: ServerResponse,
			{ principal, origin }: RequestAccess,
			ctx: Ctx,
		) => {
			if (!fromOrigin(request, origin) || !(await mayTalk(principal, ctx)))
				return sendJson(response, 403, { error: "Forbidden" });
			// A guest's lines say whose they are (its client ID is its own choice).
			const who = isGuest(principal) ? `guest:${principal.id} ` : "";
			const body = await readBody(request, MAX_LOG_EVENTS * (4 * MAX_LOG_MESSAGE + 64) + 1024);
			let input: unknown;
			try {
				input = body === undefined ? undefined : JSON.parse(body);
			} catch {
				input = undefined;
			}
			if (!isLog(input)) return sendJson(response, 400, { error: "Expected { client, events: [{ t, message }] }" });
			for (const { t, message } of input.events)
				console.log(
					`[voice ${who}${input.client}] ${new Date(t).toISOString().slice(11, 23)} ${message.replace(/\p{Cc}/gu, " ")}`,
				);
			response.writeHead(204).end();
		};

		// The owner tries a voice: synthesized whole for this browser alone (the room would play it to everyone).
		const sample = async (
			request: IncomingMessage,
			response: ServerResponse,
			{ principal, origin }: RequestAccess,
		) => {
			if (!isOwner(principal) || !fromOrigin(request, origin))
				return sendJson(response, 403, { error: "Forbidden" });
			const current = await config();
			if (!current) return sendJson(response, 503, { error: "Voice is not configured (voice.json)" });
			const body = await readBody(request, 4096);
			let input: unknown;
			try {
				input = body === undefined ? undefined : JSON.parse(body);
			} catch {
				input = undefined;
			}
			if (!isSample(input)) return sendJson(response, 400, { error: "Expected { engine?, voice?, speed }" });
			try {
				const reply = await fetch(`${current.url}/speak`, {
					method: "POST",
					headers: { Authorization: `Bearer ${current.token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ text: SAMPLE_TEXT, ...input }),
					signal: AbortSignal.timeout(30_000),
				});
				const audio = Buffer.from(await reply.arrayBuffer());
				response.writeHead(reply.status, {
					"Content-Type": reply.headers.get("content-type") ?? "application/octet-stream",
					"Content-Length": audio.byteLength,
					"Cache-Control": "no-store",
				});
				response.end(audio);
			} catch (error) {
				if (!response.headersSent)
					sendJson(response, 502, { error: `Speech service failed: ${(error as Error).message}` });
				else response.destroy();
			}
		};

		self.contribute(Routes, {
			"POST /voice/sample": sample,
			"POST /voice/log": log,
		});
		self.contribute(Upgrades, {
			// The conversation's voice room. The service trusts the identity headers because of the token, so they are
			// p2's alone: set from the authenticated principal, never taken from the browser's request.
			"/voice/room": async (request, socket, head, principal, ctx) => {
				const query = new URL(request.url ?? "/", "http://p2").searchParams;
				const session = query.get("session") ?? "";
				const conversation = Number(query.get("conversation"));
				const room =
					Number.isInteger(conversation) && conversation >= 1 ? roomName(session, conversation) : undefined;
				if (!room) return refuse(socket, "400 Bad Request");
				if (!principal || !(await mayTalk(principal, ctx, session))) return refuse(socket, "403 Forbidden");
				const current = await config();
				if (!current) return refuse(socket, "503 Service Unavailable");
				const participant = isOwner(principal)
					? { id: "owner", name: ownerName(), role: "owner" }
					: isGuest(principal)
						? { id: principal.id, name: principal.name, role: "guest" }
						: undefined;
				if (!participant || !/^[A-Za-z0-9_-]{1,64}$/.test(participant.id)) return refuse(socket, "403 Forbidden");
				const owner = participant.role === "owner";
				sockets.value.handleUpgrade(request, socket, head, (browser) => {
					if (!admit("room", principal, browser, session)) return;
					const upstream = new WebSocket(`${current.url.replace(/^http/, "ws")}/room`, {
						headers: {
							Authorization: `Bearer ${current.token}`,
							"X-Room": room,
							"X-Participant-Id": participant.id,
							"X-Participant-Name": encodeURIComponent(participant.name.slice(0, 64)),
							"X-Participant-Role": participant.role,
						},
						maxPayload: 4 * 1024 * 1024,
						// PCM hardly compresses; deflating every 21 ms frame and every speech chunk only costs the
						// host CPU and adds jitter (ws offers it by default, the service accepts it).
						perMessageDeflate: false,
					});
					// Commands sent before the service answers wait for it (microphone frames are dropped: a few ms).
					const early: string[] = [];
					const closeBoth = () => {
						browser.close();
						upstream.close();
					};
					upstream.on("open", () => {
						for (const command of early.splice(0)) upstream.send(command);
					});
					upstream.on("message", (data: RawData, binary: boolean) => {
						if (browser.readyState !== WebSocket.OPEN) return;
						if (binary) browser.send(data as Buffer, { binary: true });
						else browser.send(data.toString());
					});
					upstream.on("unexpected-response", (_request, response) => {
						if (browser.readyState === WebSocket.OPEN)
							browser.send(
								JSON.stringify({
									type: "error",
									code: "unavailable",
									message: `Speech service refused the room (HTTP ${response.statusCode})`,
								}),
							);
						closeBoth();
					});
					upstream.on("close", closeBoth);
					upstream.on("error", () => {
						if (browser.readyState === WebSocket.OPEN)
							browser.send(
								JSON.stringify({ type: "error", code: "unavailable", message: "Speech service unreachable" }),
							);
						closeBoth();
					});
					browser.on("message", (data: RawData, binary: boolean) => {
						if (binary) {
							// Microphone audio passes as it is (the service checks its size and rate).
							if (upstream.readyState === WebSocket.OPEN) upstream.send(data as Buffer);
							return;
						}
						const text = data.toString();
						let command: unknown;
						try {
							command = JSON.parse(text);
						} catch {
							command = undefined;
						}
						// A guest may only tune its own microphone; the owner also speaks for Pi and sets the voice.
						const allowed = owner ? isRoomCommand(command) : isRoomPersonal(command);
						if (!allowed) {
							browser.send(
								JSON.stringify({
									type: "error",
									code: owner ? "invalid_message" : "forbidden",
									message: owner
										? "Expected reset, vad, config, speak or cancel"
										: "Guests may only send reset or vad (silence 0.5-2 s)",
								}),
							);
							return;
						}
						if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
						else if (upstream.readyState === WebSocket.CONNECTING && early.length < 64) early.push(text);
					});
					browser.on("close", closeBoth);
					browser.on("error", closeBoth);
				});
			},
		});
	});
});
