import {
	type ConversationId,
	defineExtension,
	type EntryDraft,
	type EntryId,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { defineFacet, expectVariant, forbidden, local } from "@p2/app/v1";
import {
	defineP2Tool,
	Extensions,
	harnessOf,
	isTopLevel,
	type P2Tool,
	type WorkerParts,
	workerOf,
} from "@p2/app/v1/worker";
import { MAX_TITLE, Sessions, SessionTransfer } from "./contract.ts";

/** Contributes the `rename_session` tool: the agent keeps the session's title naming its overall task. */
const SessionTools = local("p2.session-tools", { version: 1, params: {}, members: {} });

/**
 * The tool runs outside Chord calls (a Durable tool), so each call opens a short root of the worker's. Only top-level
 * conversations (the main conversation and its `/tree` branches) may rename the session.
 */
const renameSession = (root: () => WorkerParts["root"]) =>
	defineExtension<P2Tool>({
		name: "p2-session-title",
		tools: [
			defineP2Tool({
				name: "rename_session",
				description: [
					"Rename the current session: its title in the session list, which is how the user finds it again.",
					"Keep the title naming the overall task of the session. Call this whenever that overall task changes: the user moves on to a different piece of work, or the work turns out to be something other than what the title says. Also call it when the current title does not describe the task, for example when it is just the start of the first message.",
					'Do not rename for sub-steps, follow-up questions, fixes or progress within the same task. Example: "Migrate pi-mobile to the monorepo" stays while you fix its build and push it; it becomes "Fix the terminal on Android" when the user turns to the terminal.',
					`The title: a short noun or verb phrase of 3 to 8 words, at most ${MAX_TITLE} characters, in the user's language, no trailing period, no quotes.`,
				].join("\n"),
				parameters: obj({ title: str({ minLength: 1, maxLength: MAX_TITLE }) }, { open: true }),
				// Renaming to the same title again is harmless.
				replay: "safe",
				scope: "main",
				execute: async (args, _api, context) => {
					const reply = (text: string, isError = false) => ({
						output: [{ type: "text" as const, text }],
						isError,
					});
					const title = args.title.replace(/\s+/g, " ").trim();
					if (!title) return reply("The title is empty.", true);
					try {
						// A Durable tool is not a Chord call: it pushes the title in a short root of the worker's, under its
						// own context.
						const { previous } = await root()(
							async (ctx) => expectVariant(await ctx.get(Sessions, {}), "worker").renameSelf({ title }, ctx),
							context,
						);
						return reply(
							previous === title
								? `Session title: ${JSON.stringify(title)}.`
								: `Renamed the session from ${JSON.stringify(previous)} to ${JSON.stringify(title)}.`,
						);
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return reply(error instanceof Error ? error.message : String(error), true);
					}
				},
			}),
		],
	});

export default defineFacet((host) => {
	// `Sessions.fork`: the server reads a conversation's active context here and seeds the new session's worker.
	host.serve(SessionTransfer, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		return {
			variant: "server",
			members: {
				history: async ({ conversation, before }, ctx) => {
					const durable = harness().durable;
					// A subagent's history as a session of its own needs its cwd and tools: not yet.
					if (!(await isTopLevel(durable, conversation as ConversationId, ctx)))
						throw new Error("Forking a subagent conversation is not supported yet");
					const found = await durable.conversation(conversation as ConversationId, ctx);
					if (!found) throw new Error(`Unknown conversation ${conversation}`);
					const [chosen] = (await found.entries({ maxEntryId: before as EntryId }, 1, undefined, ctx)).items;
					if (chosen?.id !== before) throw new Error("Unknown message");
					// The fork holds what came before the chosen message, as the context stood at the entry before it.
					const [previous] = (await found.entries({ maxEntryId: (before - 1) as EntryId }, 1, undefined, ctx))
						.items;
					if (!previous) return { entries: [] };
					const view = await found.context(ctx, { at: previous.id });
					// Edits are applied in `contributions` (their targets' IDs change); a head marker starts the copy's context.
					const entries: EntryDraft[] = view.entries.map((entry, index) => {
						const model = view.contributions[index] ?? [];
						return {
							kind: entry.kind,
							...(entry.data === undefined ? {} : { data: entry.data }),
							...(model.length ? { model: [...model] } : {}),
							...(index === 0 && view.head ? { head: "self" as const } : {}),
						};
					});
					return { entries };
				},
				copyFiles: async ({ to }, ctx) => {
					await worker().copyFilesTo(to, ctx);
					return null;
				},
				seed: async ({ entries }, ctx) => {
					const durable = harness().durable;
					const root = await durable.conversation(ROOT_CONVERSATION_ID, ctx);
					if (!root) throw new Error("No main conversation");
					if ((await root.entries({}, 1, undefined, ctx)).items.length)
						throw new Error("The session has history already");
					await durable.commit(async (tx) => {
						for (const entry of entries) await tx.appendEntry(ROOT_CONVERSATION_ID, entry as EntryDraft);
					}, ctx);
					return null;
				},
			},
		};
	});
	host.serve(SessionTools, (_params, self) => {
		const worker = workerOf(self);
		const extension = renameSession(() => worker().root);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});
