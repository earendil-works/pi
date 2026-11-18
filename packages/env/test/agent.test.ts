// `pi-env agent` against a fake Radius (fixtures/agent-relay.ts): enrollment and refresh, env channels running pi-env
// sessions, the forward operations and proxy, reconnecting, replacement and revocation.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";
import { FakeRelay, MEMBER, OWNER, PUBLIC_ORIGIN } from "./fixtures/agent-relay.ts";
import { acceptUpgrade, offeredProtocols } from "./fixtures/agent-ws.ts";

const context = BACKGROUND_CONTEXT;
const bridge = resolve(import.meta.dirname, "fixtures/agent-bridge.ts");
const cleanups: (() => void)[] = [];
afterAll(() => {
	for (const cleanup of cleanups.reverse()) cleanup();
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-env-agent-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Run a setup command of the daemon; resolves with its output and exit code. */
function cli(args: string[], input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(daemon, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
		child.stdin.end(input);
	});
}

function lastJson(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

/** A running `pi-env agent`; killed when the tests end. */
function startAgent(state: string): { child: ChildProcess; log: () => string } {
	const child = spawn(daemon, ["agent", "--state", state], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		log += chunk.toString("utf8");
	});
	cleanups.push(() => child.kill("SIGKILL"));
	return { child, log: () => log };
}

async function until<T>(
	check: () => T | undefined | false | Promise<T | undefined | false>,
	what: string,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resume) => setTimeout(resume, 50));
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A local HTTP server for forwards: answers with what it received, or as `routes` say. */
async function localServer(
	routes: (
		request: IncomingMessage,
		body: Buffer,
	) => { status?: number; headers?: Record<string, string>; body: Buffer | string } | undefined = () => undefined,
): Promise<{ server: Server; port: number }> {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks);
			const answer = routes(request, body) ?? {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					method: request.method,
					url: request.url,
					headers: request.headers,
					length: body.length,
				}),
			};
			response.writeHead(answer.status ?? 200, answer.headers ?? {});
			response.end(answer.body);
		});
	});
	server.on("upgrade", (request, socket, head) => {
		const protocols = offeredProtocols(request);
		const peer = acceptUpgrade(request, socket, head, protocols[0]);
		peer.send(JSON.stringify({ protocols, headers: request.headers, url: request.url }));
		peer.onMessage((message) => {
			if ("text" in message && message.text.startsWith("close:")) peer.close(Number(message.text.slice(6)), "bye");
			else peer.send("text" in message ? `echo:${message.text}` : message.binary);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return { server, port: (server.address() as AddressInfo).port };
}

describe.skipIf(process.platform === "win32")("pi-env agent", () => {
	let relay: FakeRelay;
	let state: string;
	let agent: ReturnType<typeof startAgent>;

	beforeAll(async () => {
		relay = await new FakeRelay().start();
		cleanups.push(() => relay.close());
		state = stateDir();
	});

	describe("enrollment", () => {
		it("installs without a service: enrolls by code, copies the binary, writes the state", async () => {
			const code = relay.code();
			const result = await cli(
				[
					"install",
					"--gateway",
					relay.url,
					"--code-stdin",
					"--name",
					"test machine",
					"--state",
					state,
					"--no-service",
				],
				`${code}\n`,
			);
			expect(result.code, result.stderr).toBe(0);
			const output = lastJson(result.stdout);
			expect(output).toEqual({
				server_id: relay.serverId,
				organization_id: OWNER.organization_id,
				public_origin: PUBLIC_ORIGIN,
				service: "none",
			});
			expect(relay.serverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(relay.tokenRequests.at(-1)).toMatchObject({ code, name: "test machine", server_id: relay.serverId });
			expect(result.stderr).toContain("nohup");
			const binary = join(state, "bin", "pi-env");
			expect(statSync(binary).mode & 0o111).not.toBe(0);
			expect(readFileSync(binary).equals(readFileSync(daemon))).toBe(true);
			const config = JSON.parse(readFileSync(join(state, "agent.json"), "utf8"));
			expect(config).toMatchObject({
				gateway: relay.url,
				serverId: relay.serverId,
				organizationId: OWNER.organization_id,
				principalId: OWNER.id,
				publicOrigin: PUBLIC_ORIGIN,
				name: "test machine",
				service: { kind: "none" },
			});
			expect(statSync(join(state, "credentials.json")).mode & 0o777).toBe(0o600);
			// Already enrolled: the server and credentials stay, nothing is requested.
			const requests = relay.tokenRequests.length;
			const again = await cli(["install", "--state", state, "--no-service"]);
			expect(again.code, again.stderr).toBe(0);
			expect(lastJson(again.stdout).server_id).toBe(relay.serverId);
			expect(relay.tokenRequests.length).toBe(requests);
		});

		it("refuses a used code", async () => {
			const fake = await new FakeRelay().start();
			cleanups.push(() => fake.close());
			const code = fake.code();
			expect((await cli(["enroll", "--gateway", fake.url, "--code", code, "--state", stateDir()])).code).toBe(0);
			const used = await cli(["enroll", "--gateway", fake.url, "--code", code, "--state", stateDir()]);
			expect(used.code).toBe(1);
			expect(used.stderr).toContain("invalid_grant");
		});

		it("enrolls through the device flow without a code", async () => {
			const fake = await new FakeRelay().start();
			cleanups.push(() => fake.close());
			const child = spawn(daemon, ["enroll", "--gateway", fake.url, "--state", stateDir()], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let stdout = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			const exited = new Promise<number | null>((done) => child.on("close", done));
			await until(() => stderr.includes("ABCD-EFGH"), "the device code");
			expect(stderr).toContain(`${fake.url}/pair/ABCD-EFGH`);
			fake.deviceApproved = true;
			expect(await exited).toBe(0);
			expect(lastJson(stdout)).toMatchObject({ server_id: fake.serverId, organization_id: OWNER.organization_id });
		});
	});

	describe("relay host", () => {
		beforeAll(async () => {
			const connected = relay.waitForHost();
			agent = startAgent(state);
			await connected;
		}, 30_000);

		it("connects with its token, the host protocol, replace and its name", async () => {
			const connect = relay.connects.at(-1);
			expect(connect?.serverId).toBe(relay.serverId);
			expect(connect?.protocol).toBe("pi-server.host.v5");
			expect(connect?.query.get("replace")).toBe("1");
			expect(connect?.query.get("name")).toBe("test machine");
			const status = await until(async () => {
				const result = lastJson((await cli(["status", "--state", state])).stdout);
				return (result.relay as { relay?: string } | null)?.relay === "connected" ? result : undefined;
			}, "status connected");
			expect(status).toMatchObject({
				enrolled: true,
				serverId: relay.serverId,
				gateway: relay.url,
				service: { kind: "none" },
			});
		});

		it("serves a pi-env session over an env channel", async () => {
			const connection = new Connection({ command: [process.execPath, bridge, relay.clientUrl("owner")] });
			cleanups.push(() => connection.close());
			const info = await connection.info();
			expect(info.features).toContain("forwards");
			expect(info.features).toContain("process");
			const cwd = realpathSync(stateDir());
			const env = new RemoteExecutionEnv({ connection, id: "pi-env:agent", cwd });
			getOrThrow(await env.writeFile("hello.txt", "through the relay", context));
			expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("through the relay");
			expect(getOrThrow(await env.readTextFile("hello.txt", context))).toBe("through the relay");
			let output = "";
			const result = await env.exec(
				[process.execPath, "-e", "process.stdout.write(process.cwd() + ':' + 'x'.repeat(200000))"],
				{ onOutput: (text: string) => void (output += text) },
				context,
			);
			expect(getOrThrow(result).exitCode).toBe(0);
			expect(output).toBe(`${cwd}:${"x".repeat(200_000)}`);
			const listing = getOrThrow(await env.listFiles(".", {}, context));
			expect(listing.entries).toEqual([{ path: "hello.txt", kind: "file" }]);
		});

		it("kills what a session started when its channel ends", async () => {
			const connection = new Connection({ command: [process.execPath, bridge, relay.clientUrl("owner")] });
			const cwd = stateDir();
			const env = new RemoteExecutionEnv({ connection, id: "pi-env:agent-kill", cwd });
			const running = env.exec(
				[
					process.execPath,
					"-e",
					"require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)",
				],
				{},
				context,
			);
			const pid = Number(
				await until(() => existsSync(join(cwd, "pid")) && readFileSync(join(cwd, "pid"), "utf8"), "the pid"),
			);
			expect(alive(pid)).toBe(true);
			connection.close();
			await running.catch(() => {});
			await until(() => !alive(pid), "the command to be killed");
		}, 30_000);

		it("manages forwards over an env channel", async () => {
			const connection = new Connection({ command: [process.execPath, bridge, relay.clientUrl("owner")] });
			cleanups.push(() => connection.close());
			const tag = { p2: "instance", session: "s1" };
			const set = await connection.request("forwardSet", { port: 5173, name: "vite", tag });
			const forward = set.json.forward as Record<string, unknown>;
			expect(forward).toMatchObject({ port: 5173, name: "vite", public: false, tag });
			expect(forward.id).toMatch(/^[a-z0-9]{10}$/);
			expect(forward.url).toBe(
				PUBLIC_ORIGIN.replace("https://", "https://fwd--").replace(".rdtun", `--${forward.id}.rdtun`),
			);
			const again = await connection.request("forwardSet", { port: 5173, tag, public: true });
			expect((again.json.forward as Record<string, unknown>).id).toBe(forward.id);
			expect((again.json.forward as Record<string, unknown>).publicUrl).toBe(
				PUBLIC_ORIGIN.replace("https://", "https://pub--").replace(".rdtun", `--${forward.id}.rdtun`),
			);
			const list = await connection.request("forwards", {});
			expect(list.json).toMatchObject({ origin: PUBLIC_ORIGIN, forwards: [{ id: forward.id, public: true }] });
			const saved = JSON.parse(readFileSync(join(state, "forwards.json"), "utf8"));
			expect(saved.forwards).toEqual([{ id: forward.id, port: 5173, name: "vite", public: true, tag }]);
			expect((await connection.request("forwardRemove", { tag })).json).toEqual({ removed: 1 });
			expect((await connection.request("forwards", {})).json.forwards).toEqual([]);
			await expect(connection.request("forwardSet", { port: 70_000 })).rejects.toMatchObject({ code: "EINVAL" });
		});

		it("refuses channels of anyone but the owner, and channels without a valid head", async () => {
			expect((await relay.openChannel({ principal: MEMBER })).refused).toBe(1008);
			expect((await relay.openChannel({})).refused).toBe(1008);
			const noHead = await relay.openChannel({ principal: OWNER });
			noHead.channel?.send(JSON.stringify({ type: "pi-env", token: "NOT-HEX" }));
			expect((await noHead.channel?.closed)?.code).toBe(1008);
			const textAfter = await relay.openChannel({ principal: OWNER });
			textAfter.channel?.send(JSON.stringify({ type: "pi-env", token: "abc123" }));
			const first = await textAfter.channel?.next();
			expect(first && "binary" in first && first.binary.toString()).toBe("PI-ENV abc123\n");
			textAfter.channel?.send("text is not allowed after the head");
			expect((await textAfter.channel?.closed)?.code).toBe(1008);
		});

		it("answers the owner's requests to the machine's own origin with 404", async () => {
			const result = await relay.http({ principal: OWNER, path: "/" });
			expect(result.status).toBe(404);
			expect(result.body.toString()).toBe("This machine runs pi-env without Pi.\n");
			expect((await relay.http({ principal: MEMBER, path: "/" })).closed).toBe(1008);
		});
	});

	describe("forward proxy", () => {
		let connection: Connection;
		const forwards: Record<string, string> = {};

		async function forward(port: number, isPublic = false): Promise<string> {
			const reply = await connection.request("forwardSet", {
				port,
				public: isPublic,
				tag: { test: port, isPublic },
			});
			return (reply.json.forward as { id: string }).id;
		}

		beforeAll(async () => {
			await relay.waitForHost(true);
			connection = new Connection({ command: [process.execPath, bridge, relay.clientUrl("owner")] });
			cleanups.push(() => connection.close());
			const echo = await localServer((request, body) => {
				if (request.url === "/redirect")
					return { status: 302, headers: { location: `http://localhost:${echoPort}/next?a=1` }, body: "" };
				if (request.url === "/big") return { headers: { "content-type": "application/octet-stream" }, body: big };
				if (request.url === "/upload") return { body: `${body.length}:${body.equals(upload)}` };
				return undefined;
			});
			const echoPort = echo.port;
			forwards.echo = await forward(echoPort);
			forwards.public = await forward(echoPort, true);
			const closed = await localServer();
			const closedPort = closed.port;
			await new Promise<void>((done) => closed.server.close(() => done()));
			forwards.nothing = await forward(closedPort);
			forwards.nothingPort = String(closedPort);
			forwards.echoPort = String(echoPort);
		}, 30_000);

		const big = Buffer.alloc(3 * 1024 * 1024 + 7);
		for (let index = 0; index < big.length; index++) big[index] = (index * 31) % 251;
		const upload = Buffer.alloc(1024 * 1024 + 3, 7);

		it("relays a request to the forward's port with the local Host and Origin", async () => {
			const origin = PUBLIC_ORIGIN.replace("https://", "https://fwd--").replace(
				".rdtun",
				`--${forwards.echo}.rdtun`,
			);
			const result = await relay.http({
				principal: OWNER,
				forward: forwards.echo,
				path: "/path?q=1",
				headers: [
					["Origin", origin],
					["Cookie", "a=b"],
					["Host", "ignored"],
				],
			});
			expect(result.status).toBe(200);
			const seen = JSON.parse(result.body.toString());
			expect(seen).toMatchObject({ method: "GET", url: "/path?q=1", length: 0 });
			expect(seen.headers).toMatchObject({
				host: `localhost:${forwards.echoPort}`,
				origin: `http://localhost:${forwards.echoPort}`,
				cookie: "a=b",
				"x-forwarded-host": new URL(origin).host,
				"x-forwarded-proto": "https",
			});
		});

		it("streams bodies both ways within the credit window", async () => {
			const window = 64 * 1024;
			const download = await relay.http({
				principal: OWNER,
				forward: forwards.echo,
				path: "/big",
				window,
				creditDelayMs: 2,
			});
			expect(download.status).toBe(200);
			expect(download.body.equals(big)).toBe(true);
			expect(download.maxOutstanding).toBeLessThanOrEqual(window);
			const sent = await relay.http({
				principal: OWNER,
				forward: forwards.echo,
				method: "POST",
				path: "/upload",
				headers: [["content-length", String(upload.length)]],
				body: upload,
				window,
			});
			expect(sent.body.toString()).toBe(`${upload.length}:true`);
			const chunked = await relay.http({
				principal: OWNER,
				forward: forwards.echo,
				method: "PUT",
				path: "/upload",
				body: upload,
				window,
			});
			expect(chunked.body.toString()).toBe(`${upload.length}:true`);
		});

		it("points redirects to the local address at the public origin", async () => {
			const result = await relay.http({ principal: OWNER, forward: forwards.echo, path: "/redirect" });
			expect(result.status).toBe(302);
			const location = result.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
			const origin = PUBLIC_ORIGIN.replace("https://", "https://fwd--").replace(
				".rdtun",
				`--${forwards.echo}.rdtun`,
			);
			expect(location).toBe(`${origin}/next?a=1`);
		});

		it("serves anonymous visitors only public forwards; unknown forwards are 404", async () => {
			expect((await relay.http({ forward: forwards.public, path: "/" })).status).toBe(200);
			const hidden = await relay.http({ forward: forwards.echo, path: "/" });
			expect(hidden.status).toBe(404);
			expect(hidden.body.toString()).toBe("This port forward does not exist (any more).\n");
			expect((await relay.http({ principal: OWNER, forward: "unknown123", path: "/" })).status).toBe(404);
			expect((await relay.http({ principal: MEMBER, forward: forwards.echo, path: "/" })).closed).toBe(1008);
		});

		it("answers 502 when nothing listens on the port", async () => {
			const result = await relay.http({ principal: OWNER, forward: forwards.nothing, path: "/" });
			expect(result.status).toBe(502);
			expect(result.body.toString()).toBe(`Nothing is listening on port ${forwards.nothingPort} of this machine.\n`);
		});

		it("pipes a WebSocket with the client's first subprotocol", async () => {
			const origin = PUBLIC_ORIGIN.replace("https://", "https://fwd--").replace(
				".rdtun",
				`--${forwards.echo}.rdtun`,
			);
			const { channel } = await relay.openChannel({
				principal: OWNER,
				forward: forwards.echo,
				request: {
					method: "GET",
					path: "/socket?x=1",
					headers: [
						["Sec-WebSocket-Protocol", "chat, other"],
						["Origin", origin],
					],
				},
			});
			expect(channel).toBeDefined();
			const hello = await channel?.next();
			const seen = JSON.parse(hello && "text" in hello ? hello.text : "{}");
			expect(seen.protocols).toEqual(["chat"]);
			expect(seen.url).toBe("/socket?x=1");
			expect(seen.headers).toMatchObject({
				host: `localhost:${forwards.echoPort}`,
				origin: `http://localhost:${forwards.echoPort}`,
			});
			channel?.send("ping");
			expect(await channel?.next()).toEqual({ text: "echo:ping" });
			channel?.send(Buffer.from([0, 1, 2, 255]));
			expect(await channel?.next()).toEqual({ binary: Buffer.from([0, 1, 2, 255]) });
			channel?.send("close:4001");
			expect(await channel?.closed).toEqual({ code: 4001, reason: "bye" });
			expect(
				(
					await relay.openChannel({
						principal: OWNER,
						forward: "unknown123",
						request: { method: "GET", path: "/", headers: [] },
					})
				).refused,
			).toBe(1008);
			expect(
				(await relay.openChannel({ forward: forwards.echo, request: { method: "GET", path: "/", headers: [] } }))
					.refused,
			).toBe(1008);
		});
	});

	describe("connection lifecycle", () => {
		it("reconnects after the relay drops the host socket", async () => {
			const host = await relay.waitForHost(true);
			const next = relay.waitForHost();
			host.terminate();
			await next;
			expect(relay.connects.at(-1)?.query.get("replace")).toBe("1");
		}, 20_000);

		it("yields to another instance that replaced it, and takes over once it is gone", async () => {
			const host = await relay.waitForHost(true);
			const before = relay.connects.length;
			relay.otherHost = true;
			host.close(1012, "Server host replaced");
			await until(() => relay.connects.length > before, "a reconnect");
			expect(relay.connects[before]?.query.has("replace")).toBe(false);
			// Refused with 409 while the other instance holds the server; then it connects without replace.
			await new Promise((resume) => setTimeout(resume, 1500));
			expect(relay.host).toBeUndefined();
			const connected = relay.waitForHost();
			relay.otherHost = false;
			await connected;
			const last = relay.connects.at(-1);
			expect(last?.query.has("replace")).toBe(false);
			// Once connected, the next reconnect replaces again.
			const again = relay.waitForHost();
			relay.host?.terminate();
			await again;
			expect(relay.connects.at(-1)?.query.get("replace")).toBe("1");
		}, 60_000);

		it("refreshes a token the gateway refuses, and one about to expire", async () => {
			const refreshes = () => relay.tokenRequests.filter((request) => request.grant_type === "refresh_token").length;
			const before = refreshes();
			relay.invalidateAccess();
			const next = relay.waitForHost();
			relay.host?.terminate();
			await next;
			expect(refreshes()).toBe(before + 1);
			const credentials = JSON.parse(readFileSync(join(state, "credentials.json"), "utf8"));
			expect(relay.connects.at(-1)?.token).toBe(credentials.access_token);
			// Tokens expiring within five minutes are refreshed before they are used.
			relay.expiresIn = 60;
			relay.invalidateAccess();
			const refreshed = relay.waitForHost();
			relay.host?.terminate();
			await refreshed;
			const count = refreshes();
			const again = relay.waitForHost();
			relay.host?.terminate();
			await again;
			expect(refreshes()).toBe(count + 1);
			relay.expiresIn = 86_400;
		}, 60_000);

		it("reports a revoked machine", async () => {
			relay.revoke();
			relay.host?.terminate();
			await until(async () => {
				const status = lastJson((await cli(["status", "--state", state])).stdout);
				return (status.relay as { relay?: string } | null)?.relay === "revoked";
			}, "status revoked");
			expect(agent.log()).toContain("refused this machine's grant");
			expect(agent.child.exitCode).toBeNull();
		}, 30_000);
	});

	it("uninstalls, removing its state", async () => {
		agent.child.kill("SIGTERM");
		const dir = stateDir();
		writeFileSync(
			join(dir, "agent.json"),
			JSON.stringify({ gateway: relay.url, serverId: "s", organizationId: "o", principalId: "p" }),
		);
		const kept = await cli(["uninstall", "--state", dir, "--keep-state"]);
		expect(lastJson(kept.stdout)).toEqual({ uninstalled: true, stateRemoved: false });
		expect(existsSync(join(dir, "agent.json"))).toBe(true);
		const removed = await cli(["uninstall", "--state", dir]);
		expect(lastJson(removed.stdout)).toEqual({ uninstalled: true, stateRemoved: true });
		expect(existsSync(dir)).toBe(false);
	});
});
