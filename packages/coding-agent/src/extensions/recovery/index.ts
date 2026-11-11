// Offer interrupted-session recovery before execution and park live work through /pause.
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { getSessionRecovery } from "../../core/session-recovery.ts";
import { type RecoveryChoice, RecoveryMenu } from "./menu.ts";

/** Register /pause with Enter-to-continue, preserving /resume as the existing session picker. */
export function createRecoveryExtension(): ExtensionFactory {
	return (pi) => {
		let opening: Promise<void> | undefined;
		let unsubscribe: (() => void) | undefined;

		function open(ctx: ExtensionContext): Promise<void> {
			if (opening) return opening;
			opening = (async () => {
				if (ctx.mode !== "tui")
					throw new Error(
						"The /pause menu requires interactive mode. SDK hosts can use session.recovery.pause(), resume(), recover(), or discard().",
					);
				const recovery = getSessionRecovery(ctx.sessionManager);
				if (!recovery.needsRecovery)
					void recovery
						.pause()
						.catch((error: unknown) => ctx.ui.notify(`Cannot pause: ${String(error)}`, "error"));
				const choice = await ctx.ui.custom<RecoveryChoice>(
					(tui, theme, keys, done) => new RecoveryMenu(recovery, tui, theme, keys, done),
					{ blocked: { kind: "permission", message: "Session paused; choose whether to continue" } },
				);
				if (choice === "continue") {
					if (recovery.needsRecovery) {
						const uncertain = recovery.info().tools.filter((tool) => tool.outcome === "unknown");
						if (
							uncertain.length &&
							!(await ctx.ui.confirm(
								"Unknown tool outcomes",
								`${uncertain.length} ${uncertain.length === 1 ? "tool was" : "tools were"} interrupted and may already have changed files or external state. Their calls will not be replayed automatically. Continue with a warning to inspect actual state before repeating operations?`,
							))
						)
							return;
						// A startup handler must return before the approved main continuation starts its model call.
						void recovery
							.recover()
							.catch((error: unknown) => ctx.ui.notify(`Cannot recover: ${String(error)}`, "error"));
					} else recovery.resume();
				} else if (
					choice === "discard" &&
					(await ctx.ui.confirm(
						"Discard pending work?",
						"Keep saved conversation history and completed tool evidence, but abandon queued inputs and unfinished sub-agent runs. Already completed side effects are not undone.",
					))
				) {
					await recovery.discard();
				}
			})().finally(() => {
				opening = undefined;
			});
			return opening;
		}

		pi.registerCommand("pause", {
			description: "Pause the main agent and sub-agents safely; Enter continues, background jobs keep running",
			handler: async (_args, ctx) => {
				await open(ctx);
			},
		});
		pi.on("session_start", async (_event, ctx) => {
			unsubscribe?.();
			const recovery = getSessionRecovery(ctx.sessionManager);
			let pendingApproval = recovery.needsRecovery;
			const update = () => {
				// Normal tool events must not reread every saved child's catalog.
				if (pendingApproval && !recovery.isPaused) pendingApproval = recovery.needsRecovery;
				ctx.ui.setStatus(
					"recovery",
					recovery.isPaused || pendingApproval ? "Paused · /pause to continue" : undefined,
				);
			};
			unsubscribe = recovery.subscribe(update);
			update();
			if (!pendingApproval) return;
			if (ctx.mode === "tui") await open(ctx);
			else
				ctx.ui.notify(
					"Interrupted session: execution is held until explicit recovery approval. Use the interactive /pause menu or the SDK session.recovery API.",
					"warning",
				);
		});
		pi.on("session_shutdown", () => {
			unsubscribe?.();
			unsubscribe = undefined;
		});
	};
}

export default createRecoveryExtension();
