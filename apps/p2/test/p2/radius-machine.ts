// A stand-in for a machine running `pi-env agent`, for the tests of Radius machines before (and beside) the real agent:
// it connects to the fake relay (radius-fixture.ts) as the host of its server and serves each owner's env channel with
// a real `pi-env serve` (the daemon the agent embeds), answering the agent-only forward operations itself. Forward
// channels are not proxied here; the real agent's test covers them.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { OWNER } from "./radius-fixture.ts";

const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const FORWARD_OPS = new Set(["forwards", "forwardSet", "forwardRemove"]);

/** A forward as the agent keeps it. */
export type FakeForward = { id: string; port: number; name?: string; public: boolean; tag?: unknown };

function frame(type: number, id: number, json: object): Buffer {
	const body = Buffer.from(JSON.stringify(json));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body]);
}

/**
 * Connects as the host of `serverId` with its host `token`; each env channel runs `daemon serve` until it closes.
 * `forwards` is the machine's forward list; `channels` counts the env channels served so far.
 */
export async function fakeMachine(options: {
	gateway: string;
	serverId: string;
	token: string;
	daemon: string;
	origin?: string;
}) {
	const forwards: FakeForward[] = [];
	const children = new Set<ChildProcessWithoutNullStreams>();
	let channels = 0;
	const url = new URL(`/v1/servers/${options.serverId}/connect?replace=1`, options.gateway);
	url.protocol = "ws:";
	const host = new WebSocket(url, "pi-server.host.v5", { headers: { authorization: `Bearer ${options.token}` } });
	await new Promise<void>((resolve, reject) => {
		host.once("open", resolve);
		host.once("error", reject);
	});
	const origin = options.origin ?? "https://0123456789abcdef0123456789abcdef.rdtun.com";
	const view = (forward: FakeForward) => {
		const label = origin.replace(/^https:\/\/([^.]+)\..*$/, "$1");
		const domain = origin.replace(/^https:\/\/[^.]+\./, "");
		return {
			...forward,
			url: `https://fwd--${label}--${forward.id}.${domain}`,
			...(forward.public ? { publicUrl: `https://pub--${label}--${forward.id}.${domain}` } : {}),
		};
	};
	const answer = (op: string, json: Record<string, unknown>): object => {
		if (op === "forwards") return { origin, forwards: forwards.map(view) };
		if (op === "forwardSet") {
			const existing = forwards.find((forward) =>
				json.id === undefined
					? forward.port === json.port && JSON.stringify(forward.tag) === JSON.stringify(json.tag)
					: forward.id === json.id,
			);
			const next: FakeForward = {
				id: existing?.id ?? randomBytes(5).toString("hex"),
				port: Number(json.port),
				...(typeof json.name === "string" ? { name: json.name } : {}),
				public: json.public === true,
				...(json.tag === undefined ? {} : { tag: json.tag }),
			};
			if (existing) forwards.splice(forwards.indexOf(existing), 1, next);
			else forwards.push(next);
			return { forward: view(next) };
		}
		const before = forwards.length;
		const kept = forwards.filter((forward) =>
			json.id !== undefined ? forward.id !== json.id : JSON.stringify(forward.tag) !== JSON.stringify(json.tag),
		);
		forwards.splice(0, forwards.length, ...kept);
		return { removed: before - kept.length };
	};
	const serve = (connection: string) => {
		const channelUrl = new URL(`/v1/servers/${options.serverId}/channels/${connection}`, options.gateway);
		channelUrl.protocol = "ws:";
		const channel = new WebSocket(channelUrl, "pi-server.channel.v1", {
			headers: { authorization: `Bearer ${options.token}` },
		});
		channel.on("error", () => {});
		let child: ChildProcessWithoutNullStreams | undefined;
		let pending = Buffer.alloc(0);
		channel.on("message", (data: Buffer, binary) => {
			if (!child) {
				const head = binary ? undefined : (JSON.parse(data.toString("utf8")) as { type?: string; token?: string });
				if (head?.type !== "pi-env" || !/^[0-9a-f]{1,64}$/.test(head.token ?? "")) return channel.close(1008);
				channels++;
				const started = spawn(options.daemon, ["serve", "--token", head.token!], { stdio: "pipe" });
				child = started;
				children.add(started);
				started.stdout.on("data", (chunk: Buffer) => channel.send(chunk));
				started.stdin.on("error", () => {});
				started.on("close", () => {
					children.delete(started);
					channel.close(1000);
				});
				return;
			}
			if (!binary) return channel.close(1008);
			// Requests for the agent's own operations are answered here, everything else goes to the daemon unchanged.
			pending = Buffer.concat([pending, data]);
			while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
				const length = pending.readUInt32BE(0);
				const raw = pending.subarray(0, 4 + length);
				pending = pending.subarray(4 + length);
				const type = raw.readUInt8(4);
				const id = raw.readUInt32BE(5);
				const json = JSON.parse(raw.subarray(13, 13 + raw.readUInt32BE(9)).toString("utf8")) as {
					op?: string;
				} & Record<string, unknown>;
				if (type === REQUEST && json.op !== undefined && FORWARD_OPS.has(json.op)) {
					try {
						channel.send(frame(RESULT, id, answer(json.op, json)));
					} catch (error) {
						channel.send(frame(ERROR, id, { code: "EINVAL", message: String(error) }));
					}
				} else child.stdin.write(raw);
			}
		});
		channel.on("close", () => child?.kill());
	};
	host.on("message", (data: Buffer, binary) => {
		if (binary) return;
		const message = JSON.parse(data.toString("utf8")) as {
			type: string;
			connection_id: string;
			kind?: string;
			forward?: string;
			principal?: { id: string };
		};
		if (message.type === "ping") return host.send(JSON.stringify({ version: 2, type: "pong" }));
		if (message.type !== "connection_open") return;
		if (message.kind === "ws" && message.forward === undefined && message.principal?.id === OWNER.id)
			return serve(message.connection_id);
		host.send(
			JSON.stringify({ version: 2, type: "connection_close", connection_id: message.connection_id, code: 1008 }),
		);
	});
	return {
		forwards,
		get channels() {
			return channels;
		},
		/** Disconnects from the relay and ends every daemon, as when the machine goes offline. */
		close: () => {
			host.terminate();
			for (const child of children) child.kill();
		},
	};
}
