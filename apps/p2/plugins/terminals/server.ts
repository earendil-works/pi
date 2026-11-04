import {
	type Ctx,
	contribute,
	defineFacet,
	forbidden,
	isOwner,
	isWorker,
	nativeOf,
	type Ref,
	serveNative,
	signalOf,
	until,
	type WorkerPrincipal,
} from "@p2/app/v1";
import { Hosts, Server, serverOf, Upgrades, type WorkerState } from "@p2/app/v1/server";
import { Catalog, SessionArchived } from "../sessions/contract.ts";
import { ChildStore, conversationLocation } from "../subagents/contract.ts";
import { AgentTerminals, TerminalServiceObject, TerminalServices, Terminals } from "./contract.ts";
import type { HostCall, HostResult, TerminalRequest } from "./protocol.ts";
import { TerminalService } from "./service.ts";

/** The size of a terminal the agent opens; the owner's panel resizes it to fit once it shows it. */
const AGENT_COLS = 120;
const AGENT_ROWS = 30;

export default defineFacet((host) => {
	serveNative(host, TerminalServices);
	// Archiving a session ends its programs, whether or not anyone holds its terminals now (the service connects to
	// the host only when it runs); archiving goes on when the host cannot be reached.
	contribute(host, "p2.terminals-archived", (self) => {
		self.get(TerminalServiceObject, {});
		const services = nativeOf(self, TerminalServices, "The terminal service");
		self.contribute(SessionArchived, {
			terminals: (session) =>
				services()
					.service.closeSession(session)
					.catch((error: unknown) =>
						console.error(`p2 terminals: closing session ${session}'s terminals:`, error),
					),
		});
	});
	host.serve(TerminalServiceObject, (_params, self) => {
		const server = self.get(Server, {});
		const serviceResource = self.open(
			async () => new TerminalService(server.info.value.dataDir, server.info.value.app),
			(service) => service.close(),
		);
		self.contribute(TerminalServices, {
			get service() {
				return serviceResource.value;
			},
		});
		self.contribute(Upgrades, {
			"/terminal": (request, socket, head, principal) => {
				if (!isOwner(principal)) {
					socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
					return;
				}
				serviceResource.value.upgrade(request, socket, head);
			},
		});
		return {};
	});

	host.serve(Terminals, ({ session: id }, principal, self) => {
		if (!isOwner(principal)) throw forbidden("terminals are owner-only");
		self.get(TerminalServiceObject, {});
		const services = nativeOf(self, TerminalServices, "The terminal service");
		const service = () => services().service;
		const catalog = self.get(Catalog, {});
		const children = self.get(ChildStore, {});
		const server = serverOf(self);
		const viewResource = self.open(
			async () => {
				await server().root((ctx) => catalog.get({ id }, ctx));
				return service().open(id);
			},
			(view) => service().release(view),
		);
		/** Each call is one request of the terminal host's protocol, for this session's view. */
		const command = async (request: TerminalRequest): Promise<null> => {
			await viewResource.value.command(request);
			return null;
		};
		return {
			variant: "owner",
			members: {
				channel: async () => service().channel(viewResource.value),
				list: () => command({ type: "list", sessionId: id }),
				open: async ({ cols, rows, conversation }, ctx) => {
					const session = await catalog.get({ id }, ctx);
					if (session.archivedAt !== null) throw new Error("Session is archived");
					// Where the conversation works: a subagent's own location stays where it is when the session moves.
					const child = children.children.value[id]?.find((each) => each.conversationId === conversation);
					if (conversation !== 1 && conversation !== session.main && !child)
						throw new Error("Unknown conversation");
					const { cwd, env } = conversationLocation(session, child)!;
					return command({ type: "open", sessionId: id, cwd, env, cols, rows });
				},
				attach: ({ terminalId }) => command({ type: "attach", terminalId }),
				close: ({ force }) => command({ type: "close", force }),
				resize: ({ cols, rows }) => command({ type: "resize", cols, rows }),
				theme: (theme) => command({ type: "theme", ...theme }),
				ack: ({ bytes }) => command({ type: "ack", bytes }),
				restartHost: () => command({ type: "shutdown" }),
			},
		};
	});

	host.serve(AgentTerminals, (_params, principal, self) => {
		if (!isWorker(principal)) throw forbidden("agent terminals are for session workers");
		self.get(TerminalServiceObject, {});
		const services = nativeOf(self, TerminalServices, "The terminal service");
		const catalog = self.get(Catalog, {});
		const children = self.get(ChildStore, {});
		const current = currentWorker(self.get(Hosts, {}), principal);
		const sessionId = principal.session;
		/** The session's live, current worker only, never in an archived session. */
		const admitted = async (ctx: Ctx) => {
			await current(ctx);
			const session = await catalog.get({ id: sessionId }, ctx);
			if (session.archivedAt !== null) throw forbidden("Session is archived");
			return session;
		};
		const call = async <K extends HostResult["kind"]>(
			kind: K,
			request: HostCall,
			ctx: Ctx,
		): Promise<Omit<Extract<HostResult, { kind: K }>, "kind">> => {
			await admitted(ctx);
			const result = await services().service.call(request, signalOf(ctx));
			if (result.kind !== kind) throw new Error(`The terminal host answered ${result.kind} to ${request.op}`);
			const { kind: _kind, ...rest } = result as Extract<HostResult, { kind: K }>;
			return rest;
		};
		return {
			variant: "worker",
			members: {
				list: (_args, ctx) => call("list", { op: "list", sessionId }, ctx),
				open: async ({ key, location, name, command }, ctx) => {
					const session = await admitted(ctx);
					// Only where the session's conversations work: the session's environment or a subagent's own.
					const own = children.children.value[sessionId] ?? [];
					const envs = new Set([
						session.env ?? null,
						...own.map((child) => conversationLocation(session, child)?.env),
					]);
					if (!envs.has(location.env))
						throw forbidden(
							`This session does not work on ${location.env ? `"${location.env}"` : "this device"}`,
						);
					const opened = await call(
						"terminal",
						{
							op: "open",
							sessionId,
							key,
							cwd: location.cwd,
							env: location.env,
							...(name ? { name } : {}),
							...(command ? { command } : {}),
							cols: AGENT_COLS,
							rows: AGENT_ROWS,
						},
						ctx,
					);
					return opened.terminal;
				},
				send: async ({ key, target, keys, literal }, ctx) =>
					(await call("terminal", { op: "send", sessionId, key, target, keys, literal }, ctx)).terminal,
				cursor: ({ target }, ctx) => call("cursor", { op: "cursor", sessionId, target }, ctx),
				read: ({ target, from, wait }, ctx) =>
					call(
						"read",
						{
							op: "read",
							sessionId,
							target,
							...(from === undefined ? {} : { from }),
							...(wait === undefined ? {} : { wait }),
						},
						ctx,
					),
				capture: ({ target, scrollback, escapes }, ctx) =>
					call("capture", { op: "capture", sessionId, target, scrollback, ...(escapes ? { escapes } : {}) }, ctx),
				close: ({ key, target }, ctx) => call("closed", { op: "close", sessionId, key, target }, ctx),
			},
		};
	});
});

/**
 * Refuses all but the session's running current generation, as MCP's worker view does. A worker may ask before the
 * server published its start: the check waits for that (the wait ends with the caller's call).
 */
function currentWorker(
	hosts: Ref<typeof Hosts>,
	{ session, generation }: WorkerPrincipal,
): (ctx: Ctx) => Promise<void> {
	const known = (state: WorkerState | undefined) =>
		state !== undefined && (state.generation > generation || (state.generation === generation && state.running));
	return async (ctx) => {
		const published = hosts.workers.value[session];
		const state = known(published)
			? published
			: (await until(hosts.workers, (workers) => known(workers[session]), ctx))[session];
		if (!state?.running || state.generation !== generation) throw forbidden("stale worker");
	};
}
