// The `reload_plugins` tool: builds and rolls out p2 plugins (the built-in ones of a p2 checkout, the user root's that
// agents write) and reports per plugin; and, in a session working on the p2 checkout, how p2 development applies edits.
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@p2/app/v1";
import { defineP2Tool, isTopLevel, type P2Tool } from "@p2/app/v1/worker";
import type { PluginReloadResult } from "./contract.ts";

/** The tool, reloading through `reload`; `onCheckout`: the session works on the p2 checkout (the section's hint). */
export function createReloadExtension(
	reload: (plugins: readonly string[] | undefined, context: Context) => Promise<PluginReloadResult>,
	onCheckout: () => boolean,
) {
	return defineExtension<P2Tool>({
		name: "p2-dev-tools",
		sections: [
			section("p2-development", async (input, context) =>
				onCheckout() && (await isTopLevel(input.read, input.conversationId, context))
					? "p2 backend saves only mark dirty. After editing p2 plugins, use reload_plugins to apply dirty plugins (or name plugins). Web/UI edits are plugin edits too: reload_plugins rebuilds the web bundle and open pages reload onto it. Runtime edits need an explicit `npm run reload -- --restart` from apps/p2 with this server's P2_DATA_DIR."
					: undefined,
			),
		],
		tools: [
			defineP2Tool({
				name: "reload_plugins",
				description:
					"Builds p2's changed plugins (the user plugin root's and the built-in ones) and rolls them out to the server, every session's worker and the page; optional plugins names them. Reports per plugin: applied, removed, failed with the errors (file:line:column: message), or refused with the reason; and errors logged meanwhile. A failed build applies nothing: the old code keeps running. Runtime code needs npm run reload -- --restart instead.",
				parameters: obj(
					{ plugins: opt(arr(str({ minLength: 1, maxLength: 100 }), { maxItems: 100 })) },
					{ open: true },
				),
				// Do not replay a code upgrade after a crash; the caller can explicitly request another reload.
				replay: "unsafe",
				execute: async (args, _api, context) => {
					try {
						const result = await reload(args.plugins, context);
						const ok =
							!result.refused &&
							result.plugins.every((each) => each.outcome === "applied" || each.outcome === "removed");
						return {
							output: [{ type: "text" as const, text: resultText(result) }],
							details: { ok },
							isError: !ok,
						};
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						const text = error instanceof Error ? error.message : String(error);
						return { output: [{ type: "text" as const, text }], details: { ok: false }, isError: true };
					}
				},
			}),
		],
	});
}

/** A reload's result as the agent reads it. */
function resultText(result: PluginReloadResult): string {
	if (result.refused) return `Nothing reloaded: ${result.refused}`;
	const lines = result.plugins.length
		? result.plugins.flatMap(({ plugin, outcome, errors }) => [
				`${plugin}: ${outcome}`,
				...(errors ?? []).map((error) => `  ${error}`),
			])
		: ["No plugin changed since the last reload."];
	if (result.logs.length) lines.push("Errors logged since:", ...result.logs.map((line) => `  ${line}`));
	return lines.join("\n");
}
