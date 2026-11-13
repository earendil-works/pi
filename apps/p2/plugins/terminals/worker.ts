// The terminals plugin's worker facet: the agent's `terminal` tool, calling the server's `AgentTerminals` as this
// session's worker, at the calling conversation's location. It follows the code mode switch as MCP tools do: for
// scripts while code mode is on, loaded with `tool_search` while it is off.

import type { Extension } from "@earendil-works/pi-durable";
import { type Context, type Ctx, contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { AgentTerminals } from "./contract.ts";
import {
	createTerminalExtension,
	TERMINAL_EXTENSION,
	type TerminalBackend,
	type TerminalCaller,
	type TerminalReach,
} from "./tool.ts";

/** The code mode plugin's extension: its switch is on while the `codemode` setting is, absent without the plugin. */
const CODEMODE_EXTENSION = "codemode";

export default defineFacet((host) => {
	contribute(host, "p2.terminal-tools", (self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const terminals = async (ctx: Ctx) => expectVariant(await ctx.get(AgentTerminals, {}), "worker");
		/** One call of the server's object, as this worker, cancelled with `context`. */
		const via = <T>(
			call: (server: Awaited<ReturnType<typeof terminals>>, ctx: Ctx) => Promise<T>,
			context: Context,
		): Promise<T> => worker().root(async (ctx) => call(await terminals(ctx), ctx), context);
		const backend: TerminalBackend = {
			list: async (context) => (await via((server, ctx) => server.list({}, ctx), context)).windows,
			open: (args, context) => via((server, ctx) => server.open(args, ctx), context),
			send: (args, context) => via((server, ctx) => server.send(args, ctx), context),
			cursor: (target, context) => via((server, ctx) => server.cursor({ target }, ctx), context),
			read: (args, context) => via((server, ctx) => server.read(args, ctx), context),
			capture: (args, context) => via((server, ctx) => server.capture(args, ctx), context),
			close: (args, context) => via((server, ctx) => server.close(args, ctx), context),
		};
		const caller: TerminalCaller = async (api, context) => {
			const here = await harness().environments.locate(api.conversationId, context, api);
			const sandbox = await harness().environments.sandbox(here.env);
			return sandbox === undefined ? { here } : { here, sandbox };
		};
		const offer = (reach: TerminalReach) => ({
			[TERMINAL_EXTENSION]: createTerminalExtension(reach, backend, caller),
		});
		let offered: TerminalReach = "codemode";
		const extension = self.writable<Readonly<Record<string, Extension>>>(offer(offered));
		self.contribute(Extensions, extension);
		// Code mode switched off or not loaded: scripts cannot reach the tool, so `tool_search` loads it.
		self.on(self.registry(ExtensionSwitches), ({ value }) => {
			const reach: TerminalReach = value.get(CODEMODE_EXTENSION) === true ? "codemode" : "tool_search";
			if (reach === offered) return;
			offered = reach;
			extension.set(offer(reach));
		});
	});
});
