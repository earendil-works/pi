// The MCP supervisor, a native of the manager: one client per instance the placement needs, started when a lease first
// needs it and closed when nothing needs it any more (a shared instance stays while its server is configured). A lost
// connection (a crashed server, or an environment's connection whose daemon killed it) reconnects with backoff,
// keeping its tools listed; a server's tool-list change refreshes its tools.

import {
	type CallToolResult,
	McpAuthRequiredError,
	McpClient,
	type McpTransport,
	PipeTransport,
	StdioTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { PluginError } from "@p2/app/v1";
import { type Instance, type McpTool, signInLink } from "./contract.ts";
import { type ConnectEnv, EnvConnections } from "./environments.ts";
import type { InstanceSpec, Placement } from "./placement.ts";
import { type AuthProviders, DaemonTooOldError, type Opened, type Transports, transportsFor } from "./transports.ts";

/** How the p2 server names itself to MCP servers (`initialize`'s `clientInfo`). */
export type ClientInfo = { readonly name: string; readonly version: string };

/** Reconnect waits: the first, the cap of their doubling, and how long a connection lasts to start over at the first. */
export type Backoff = { readonly firstMs: number; readonly maxMs: number; readonly stableMs: number };

/** The manager's backoff: 1 s doubling to 60 s, from 1 s again after a connection that was up for a minute. */
export const RECONNECT: Backoff = { firstMs: 1000, maxMs: 60_000, stableMs: 60_000 };

/** The running instances; subscribers hear of every change of what `list` returns. */
export class Instances {
	readonly #client: ClientInfo;
	readonly #backoff: Backoff;
	/**
	 * Tools and instructions last listed per instance ID (a reload's previous supervisor): listed until the server
	 * answers again, so the prompt does not change meanwhile.
	 */
	readonly #seed: ReadonlyMap<string, Seed>;
	readonly #envs: EnvConnections;
	readonly #auth: AuthProviders;
	readonly #running = new Map<string, Connection>();
	readonly #listeners = new Set<() => void>();
	#closed = false;

	/**
	 * `connect` opens the connection to an environment its instances share; `auth` gives the auth provider of an HTTP
	 * server that signs in with OAuth.
	 */
	constructor(
		client: ClientInfo,
		backoff: Backoff,
		seed: readonly Instance[],
		connect: ConnectEnv,
		auth: AuthProviders,
	) {
		this.#client = client;
		this.#backoff = backoff;
		this.#seed = new Map(
			seed.map(({ id, tools, instructions }) => [
				id,
				{ tools, ...(instructions === undefined ? {} : { instructions }) },
			]),
		);
		this.#envs = new EnvConnections(connect);
		this.#auth = auth;
	}

	/** `listener` is called after every change of `list`; the result stops it. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Starts the instances `placement`'s leases use and closes the others, except shared ones still configured. */
	reconcile(placement: Placement): void {
		if (this.#closed) return;
		const needed = new Set(placement.leases.flatMap((lease) => [...lease.servers.values()]));
		for (const id of placement.kept) if (this.#running.has(id)) needed.add(id);
		let changed = false;
		for (const [id, connection] of this.#running)
			if (!needed.has(id)) {
				this.#running.delete(id);
				void connection.close();
				changed = true;
			}
		for (const id of needed)
			if (!this.#running.has(id)) {
				// Every leased ID comes from the same placement's instances.
				const spec = placement.instances.get(id)!;
				const transports = transportsFor(spec.connect, this.#envs, this.#auth);
				const connection = new Connection(
					spec,
					transports,
					this.#client,
					this.#backoff,
					this.#seed.get(id) ?? { tools: [] },
					() => this.#changed(),
				);
				this.#running.set(id, connection);
				connection.start();
				changed = true;
			}
		if (changed) this.#changed();
	}

	/** The instances as the manager shows them, by server name, then ID. */
	list(): Instance[] {
		return [...this.#running.values()]
			.map((connection) => connection.view())
			.sort((a, b) => (a.server === b.server ? (a.id < b.id ? -1 : 1) : a.server < b.server ? -1 : 1));
	}

	/** Calls `tool` on instance `id`; throws while it is not connected. */
	async call(id: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
		const connection = this.#running.get(id);
		if (connection === undefined) throw new Error("This MCP server is not running");
		return await connection.call(tool, args, signal);
	}

	/** Connects instance `id` again now, its backoff reset (a connect under way is closed first). */
	restart(id: string): void {
		const connection = this.#running.get(id);
		if (connection === undefined) throw new PluginError("not_found", `No MCP server instance ${id}`);
		connection.restart();
	}

	/** Connects every HTTP instance of owner server `server` again now (its credentials changed). */
	reconnect(server: string): void {
		for (const connection of this.#running.values()) if (connection.isHttp(server)) connection.restart();
	}

	/** Closes every instance (stdio servers get MCP's shutdown: stdin closed, then killed) and so every connection. */
	async close(): Promise<void> {
		this.#closed = true;
		const connections = [...this.#running.values()];
		this.#running.clear();
		await Promise.allSettled(connections.map((connection) => connection.close()));
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

/** What an instance lists before its server answers: its tools and instructions as last listed. */
type Seed = { readonly tools: readonly McpTool[]; readonly instructions?: string };

/** How much of a stdio server's stderr the owner's error shows. */
const STDERR_TAIL_CHARS = 300;

/**
 * Where one connection is: not trying (before its start, unplaced, failed for good, waiting for a sign-in), opening its
 * transport (an environment's connection may start first), connecting, connected, waiting to reconnect, or closed.
 */
type State =
	| { readonly kind: "idle" }
	| { readonly kind: "opening" }
	| { readonly kind: "connecting"; readonly client: McpClient }
	| { readonly kind: "connected"; readonly client: McpClient; readonly since: number }
	| { readonly kind: "waiting"; readonly timer: ReturnType<typeof setTimeout> }
	| { readonly kind: "closed" };

/** Why the last attempt failed: the message for everybody, the stderr tail for the owner only. */
type Failure = { readonly message: string; readonly stderr?: string };

/** The status message of an instance waiting for a sign-in. */
const SIGN_IN_NEEDED: Failure = { message: "This server needs a sign-in" };

/** One instance: its connection state, and its status, failure and tools as listed. */
class Connection {
	readonly #spec: InstanceSpec;
	readonly #transports: Transports;
	readonly #info: ClientInfo;
	readonly #backoff: Backoff;
	readonly #changed: () => void;
	#state: State = { kind: "idle" };
	#status: Instance["status"] = "starting";
	#failure: Failure | undefined;
	#tools: readonly McpTool[];
	/** The server's instructions from its last `initialize`, kept while it reconnects. */
	#instructions: string | undefined;
	#delayMs: number;

	constructor(
		spec: InstanceSpec,
		transports: Transports,
		info: ClientInfo,
		backoff: Backoff,
		seed: Seed,
		changed: () => void,
	) {
		this.#spec = spec;
		this.#transports = transports;
		this.#info = info;
		this.#backoff = backoff;
		this.#tools = seed.tools;
		this.#instructions = seed.instructions;
		this.#changed = changed;
		this.#delayMs = backoff.firstMs;
	}

	start(): void {
		if (this.#spec.connect.kind === "unplaced") this.#show("failed", { message: this.#spec.connect.reason });
		else void this.#connect();
	}

	/** Whether this is an instance of HTTP server `server`. */
	isHttp(server: string): boolean {
		return this.#spec.server === server && this.#spec.connect.kind === "http";
	}

	view(): Instance {
		const { id, server, source, location, runsOn, connect, description } = this.#spec;
		const failure = this.#failure;
		return {
			id,
			server,
			source,
			location,
			runsOn,
			...(connect.kind === "http" && connect.oauth !== undefined ? { auth: "oauth" as const } : {}),
			status: this.#status,
			...(failure === undefined
				? {}
				: { error: failure.stderr ? `${failure.message} (stderr: ${failure.stderr})` : failure.message }),
			tools: [...this.#tools],
			...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
			...(description === undefined ? {} : { description }),
		};
	}

	/**
	 * The error says why it is not connected, never the server's stderr (the model reads it); for a sign-in, where the
	 * user signs in. Tokens refused for good during a call (revoked, say) make it wait for a sign-in.
	 */
	async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
		const { server } = this.#spec;
		const signInNeeded = () =>
			new Error(
				`MCP server "${server}" needs a sign-in: ask the user to sign in from the MCP panel in p2's sidebar (or at ${signInLink(server)} on p2)`,
			);
		if (this.#status === "sign-in") throw signInNeeded();
		const state = this.#state;
		if (state.kind !== "connected") {
			const why = this.#failure === undefined ? "" : `: ${this.#failure.message}`;
			throw new Error(`MCP server "${server}" is not connected${why}`);
		}
		try {
			return await state.client.callTool(tool, args, { signal, timeoutMs: this.#spec.timeoutMs });
		} catch (error) {
			// A restart meanwhile (a sign-in that just finished) decides on its own.
			if (!this.#needsSignIn(error) || this.#state !== state) throw error;
			void this.#stop();
			this.#show("sign-in", SIGN_IN_NEEDED);
			throw signInNeeded();
		}
	}

	restart(): void {
		if (this.#spec.connect.kind === "unplaced" || this.#state.kind === "closed") return;
		this.#stop();
		this.#delayMs = this.#backoff.firstMs;
		void this.#connect();
	}

	/** Closes the client, then lets go of what its transports held (an environment's connection, maybe its last user). */
	async close(): Promise<void> {
		const closing = this.#stop();
		this.#state = { kind: "closed" };
		await closing;
		this.#transports.release();
	}

	/** Ends what the state holds (a connect under way, a client, a timer) and goes idle. */
	#stop(): Promise<void> {
		const state = this.#state;
		this.#state = { kind: "idle" };
		switch (state.kind) {
			case "connecting":
			case "connected":
				return state.client.close().catch(() => {});
			case "waiting":
				clearTimeout(state.timer);
				return Promise.resolve();
			default:
				return Promise.resolve();
		}
	}

	async #connect(): Promise<void> {
		const opening: State = { kind: "opening" };
		this.#state = opening;
		this.#show("starting", this.#failure);
		let opened: Opened;
		try {
			opened = await this.#transports.open();
		} catch (error) {
			if (this.#state === opening) this.#failed(error, undefined);
			return;
		}
		// Closed or restarted meanwhile: the transport never started, so there is nothing to close.
		if (this.#state === opening) await this.#initialize(opened);
	}

	async #initialize({ transport, roots }: Opened): Promise<void> {
		const client = new McpClient({
			...this.#info,
			...(this.#spec.timeoutMs === undefined ? {} : { requestTimeoutMs: this.#spec.timeoutMs }),
			...(roots.length ? { roots: roots.map((uri) => ({ uri })) } : {}),
		});
		const state: State = { kind: "connecting", client };
		this.#state = state;
		try {
			// Only a connection that was up is lost; a failed connect closes its client too.
			client.onClose(() => {
				if (this.#state.kind === "connected" && this.#state.client === client) this.#lost(transport);
			});
			client.onNotification("notifications/tools/list_changed", () => void this.#refresh(client));
			await client.connect(transport);
			const tools = await client.listTools();
			// Closed or restarted meanwhile: that already closed this client.
			if (this.#state !== state) return;
			this.#state = { kind: "connected", client, since: Date.now() };
			this.#tools = tools.map(toolOf);
			this.#instructions = client.instructions?.trim() || undefined;
			this.#show("connected", undefined);
		} catch (error) {
			await client.close().catch(() => {});
			if (this.#state === state) this.#failed(error, transport);
		}
	}

	/**
	 * A connect failed: wait for a sign-in (an OAuth server without usable tokens), stay failed (a daemon too old), or
	 * try again after the backoff (a server refusing its configured headers too).
	 */
	#failed(error: unknown, transport: McpTransport | undefined): void {
		if (this.#needsSignIn(error)) {
			this.#state = { kind: "idle" };
			this.#show("sign-in", SIGN_IN_NEEDED);
			return;
		}
		if (error instanceof DaemonTooOldError) {
			this.#state = { kind: "idle" };
			this.#show("failed", { message: error.message });
			return;
		}
		this.#show("failed", failureOf(error, transport));
		this.#wait();
	}

	/** Whether `error` means the user has to sign in: an OAuth server refusing the request with the tokens it has. */
	#needsSignIn(error: unknown): boolean {
		const { connect } = this.#spec;
		return (
			connect.kind === "http" &&
			connect.oauth !== undefined &&
			(error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError)
		);
	}

	/** The connection dropped (a stdio server exited, say): reconnect after the backoff, tools still listed. */
	#lost(transport: McpTransport): void {
		if (this.#state.kind === "connected" && Date.now() - this.#state.since >= this.#backoff.stableMs)
			this.#delayMs = this.#backoff.firstMs;
		this.#show("starting", failureOf(new Error("the connection was lost"), transport));
		this.#wait();
	}

	#wait(): void {
		const timer = setTimeout(() => {
			if (this.#state === state) void this.#connect();
		}, this.#delayMs);
		timer.unref();
		const state: State = { kind: "waiting", timer };
		this.#state = state;
		this.#delayMs = Math.min(this.#delayMs * 2, this.#backoff.maxMs);
	}

	async #refresh(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.#state.kind !== "connected" || this.#state.client !== client) return;
			this.#tools = tools.map(toolOf);
			this.#changed();
		} catch (error) {
			console.error(`p2 mcp: refreshing the tools of "${this.#spec.server}" failed:`, error);
		}
	}

	#show(status: Instance["status"], failure: Failure | undefined): void {
		this.#status = status;
		this.#failure = failure;
		this.#changed();
	}
}

/** A tool as instances list it: plain JSON, without the fields p2 does not use. */
function toolOf(tool: Tool): McpTool {
	return {
		name: tool.name,
		...(tool.title === undefined ? {} : { title: tool.title }),
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema,
		...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
		...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
	};
}

/** `error`'s message, and the end of a stdio server's stderr (on the p2 host or an environment). */
function failureOf(error: unknown, transport: McpTransport | undefined): Failure {
	const message = error instanceof Error ? error.message : String(error);
	const stderr =
		transport instanceof StdioTransport || transport instanceof PipeTransport
			? transport.stderr.trim().slice(-STDERR_TAIL_CHARS)
			: "";
	return stderr ? { message, stderr } : { message };
}
