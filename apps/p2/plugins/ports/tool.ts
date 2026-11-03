import { defineExtension, defineTool, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { Context } from "@p2/app/v1";
import { literal } from "@p2/app/v1";
import { originOf } from "@p2/app/v1/worker";
import type { ConversationOrigin } from "../conversations/contract.ts";
import { type ForwardView, MAX_FORWARD_NAME, type PortsReply, type PortsRequest } from "./protocol.ts";

/** What the agent learns: every forward, its addresses, who opened it, and the public endpoints spelled out. */
function describe(reply: PortsReply, self: string): string {
	const label = (forward: ForwardView) =>
		`port ${forward.port}${forward.name ? ` (${JSON.stringify(forward.name)})` : ""}`;
	const opener = (forward: ForwardView) =>
		forward.session === self
			? "opened by this session"
			: forward.session
				? `opened by session ${JSON.stringify(forward.sessionTitle ?? forward.session)}`
				: "added by the owner";
	const lines = reply.forwards.map(
		(forward) =>
			`- ${label(forward)}, ${forward.public ? "PUBLIC" : "private"}, ${opener(forward)}: ${
				forward.url ?? "address not known yet"
			}${forward.publicUrl ? `, public ${forward.publicUrl}` : ""}`,
	);
	const publicOnes = reply.forwards.filter((forward) => forward.public);
	return [
		reply.forwards.length ? "Forwarded ports:" : "No ports are forwarded.",
		...lines,
		publicOnes.length
			? `Public endpoints, open to anyone with the link without signing in: ${publicOnes
					.map((forward) => `${label(forward)} ${forward.publicUrl ?? "(address not known yet)"}`)
					.join("; ")}.`
			: "No forward is public.",
		...(reply.addressesKnown
			? []
			: [
					"Addresses are not known yet: Pi has not been opened through Radius by its owner. They appear once it has; the owner also finds them under Envs → Ports.",
				]),
	].join("\n");
}

export function createPortsExtension(
	queryServer: (query: PortsRequest, origin: ConversationOrigin, context: Context) => Promise<PortsReply>,
	self: () => string,
) {
	return defineExtension({
		name: "p2-ports",
		sections: [
			section("ports", (input) =>
				input.conversationId === ROOT_CONVERSATION_ID
					? "The ports tool forwards a local web server (a dev server, say) through Radius so the owner can open it from other devices, and lists all forwards and public endpoints. Forwards are private by default: only the owner can open them, after signing in. Never make a port public, by opening it with public: true or switching an existing one, without asking the user first and getting a yes: a public port is reachable by anyone with the link, without signing in."
					: undefined,
			),
		],
		tools: [
			defineTool({
				name: "ports",
				description: [
					"Forward web servers on this device through Radius, so the owner can open them from anywhere.",
					"list: every forward with its addresses and who opened it, and all public endpoints.",
					"open (port; optional name, public): forward a port and return its address. Private by default (owner only, after signing in). public: true also opens it to anyone with the link, without signing in; ask the user before doing that. Opening a port that is already forwarded, by anyone, keeps its address and updates its name and visibility.",
					"close (port): stop forwarding a port, whoever opened it.",
					"Only ports of this device: a session on a remote environment cannot forward its host's ports yet. A session's forwards close when it is archived.",
				].join("\n"),
				parameters: obj(
					{
						action: union([literal("list"), literal("open"), literal("close")]),
						port: opt(int({ minimum: 1, maximum: 65535 })),
						name: opt(str({ minLength: 1, maxLength: MAX_FORWARD_NAME })),
						public: opt(bool()),
					},
					{ open: true },
				),
				// Every action is idempotent: opening twice returns the same forward, closing twice reports it closed.
				replay: "safe",
				execute: async (args, api, context) => {
					const reply = (text: string, details: Record<string, unknown> = {}, isError = false) => ({
						output: [{ type: "text" as const, text }],
						details: { action: args.action, ...(args.port === undefined ? {} : { port: args.port }), ...details },
						isError,
					});
					if (api.conversationId !== ROOT_CONVERSATION_ID)
						return reply("Only top-level conversations can use this tool.", {}, true);
					let request: PortsRequest;
					if (args.action === "list") request = { action: "list" };
					else if (args.port === undefined) return reply(`${args.action} needs a port.`, {}, true);
					else if (args.action === "open")
						request = {
							action: "open",
							port: args.port,
							...(args.name === undefined ? {} : { name: args.name }),
							...(args.public === undefined ? {} : { public: args.public }),
						};
					else request = { action: "close", port: args.port };
					try {
						const origin = await originOf(api, context);
						if (!origin)
							return reply(
								"Forwarding ports requires owner-initiated input or an authenticated peer message; guest input is not permitted.",
								{},
								true,
							);
						const result = await queryServer(request, origin, context);
						const summary =
							request.action === "open" && result.forward
								? `Forwarded port ${result.forward.port}${result.forward.public ? ", public" : ", private"}: ${
										result.forward.url ?? "address not known yet"
									}${result.forward.publicUrl ? ` (public: ${result.forward.publicUrl})` : ""}.`
								: request.action === "close"
									? result.closed
										? `Stopped forwarding port ${request.port}.`
										: `Port ${request.port} was not forwarded.`
									: undefined;
						return reply([summary, describe(result, self())].filter(Boolean).join("\n\n"), {
							...(result.forward ? { forward: result.forward } : {}),
						});
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return reply(error instanceof Error ? error.message : String(error), {}, true);
					}
				},
			}),
		],
	});
}
