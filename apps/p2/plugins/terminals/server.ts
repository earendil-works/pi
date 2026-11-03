import { defineFacet, forbidden, isOwner, nativeOf, serveNative } from "@p2/app/v1";
import { Server, serverOf, Upgrades } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { ChildStore, conversationLocation } from "../subagents/contract.ts";
import { TerminalServiceObject, TerminalServices, Terminals } from "./contract.ts";
import type { TerminalRequest } from "./protocol.ts";
import { TerminalService } from "./service.ts";

export default defineFacet((host) => {
	serveNative(host, TerminalServices);
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
					if (conversation !== 1 && !child) throw new Error("Unknown conversation");
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
});
