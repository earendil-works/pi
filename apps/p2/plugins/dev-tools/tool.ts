import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context, DevResult } from "@p2/app/v1";
import { defineP2Tool, isTopLevel, type P2Tool } from "@p2/app/v1/worker";

export function createReloadExtension(
	reload: (plugins: readonly string[] | undefined, context: Context) => Promise<DevResult>,
	project: boolean | (() => boolean),
) {
	const permitted = () => (typeof project === "function" ? project() : project);
	return defineExtension<P2Tool>({
		name: "p2-dev-tools",
		sections: [
			section("p2-development", async (input, context) =>
				permitted() && (await isTopLevel(input.read, input.conversationId, context))
					? "p2 backend saves only mark dirty. After editing p2 plugins, use reload_plugins to apply dirty plugins (or name plugins). Web/UI edits are plugin edits too: reload_plugins rebuilds the web bundle and open pages reload onto it. Runtime edits need an explicit `npm run reload -- --restart` from apps/p2 with this server's P2_DATA_DIR. Only turns the owner started may use reload_plugins."
					: undefined,
			),
		],
		tools: [
			defineP2Tool({
				name: "reload_plugins",
				description:
					"Explicitly reload p2's dirty backend plugins on the server and all running workers; optional plugins selects names. Returns the committed selection or refusal reason. Only owner-initiated root turns in a local p2 checkout. Runtime code needs npm run reload -- --restart instead.",
				parameters: obj(
					{
						plugins: opt(arr(str({ minLength: 1, maxLength: 100 }), { maxItems: 100 })),
					},
					{ open: true },
				),
				// Do not replay a code upgrade after a crash; the caller can explicitly request another reload.
				replay: "unsafe",
				origin: "owner",
				scope: "main",
				execute: async (args, _api, context) => {
					const reply = (message: string, ok: boolean) => ({
						output: [{ type: "text" as const, text: message }],
						details: { ok },
						isError: !ok,
					});
					if (!permitted())
						return reply("reload_plugins requires a session working on a local p2 checkout", false);
					try {
						const result = await reload(args.plugins, context);
						return reply(result.message, result.ok);
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return reply(error instanceof Error ? error.message : String(error), false);
					}
				},
			}),
		],
	});
}
