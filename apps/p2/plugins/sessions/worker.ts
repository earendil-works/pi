import type { Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineExtension,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	type Harness,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import {
	agentMessage,
	type Ctx,
	contribute,
	defineFacet,
	expectVariant,
	forbidden,
	local,
	messageData,
	peerMessage,
	SHELL_ENTRY,
	signalOf,
} from "@p2/app/v1";
import {
	AUTO_TITLE_LENGTH,
	editSessionInfo,
	readSessionInfo,
	SessionInfoDoc,
	type SessionInfoEdit,
	type SessionInfoState,
	sessionInfoSeed,
} from "@p2/app/v1/node";
import {
	CommitSignal,
	defineP2Tool,
	Extensions,
	harnessOf,
	isTopLevel,
	type P2Tool,
	workerOf,
} from "@p2/app/v1/worker";
import { MAX_TITLE, SessionInfo, Sessions, SessionTransfer } from "./contract.ts";
import { serveLockMirror } from "./lock-worker.ts";

/** The placeholder title of a session nobody titled yet. */
const UNTITLED = "New session";

/** Contributes the `rename_session` tool: the agent keeps the session's title naming its overall task. */
const SessionTools = local("p2.session-tools", { version: 1, params: {}, members: {} });

/**
 * The tool commits to the session's own description (`p2.session-info`) in its own task's commit; the worker reports
 * the change to the catalog. Only top-level conversations (the main conversation and its `/tree` branches) may rename
 * the session.
 */
const renameSession = (
	edit: (
		session: Pick<Harness, "commit">,
		change: SessionInfoEdit,
		context: Context,
	) => Promise<{ readonly previous: string }>,
) =>
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
				execute: async (args, api, context) => {
					const reply = (text: string, isError = false) => ({
						output: [{ type: "text" as const, text }],
						isError,
					});
					const title = args.title.replace(/\s+/g, " ").trim();
					if (!title) return reply("The title is empty.", true);
					try {
						// The session's own description is the authority; the catalog follows the worker's report of it.
						const { previous } = await edit(api, { title, titleEdited: true }, context);
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
	serveLockMirror(host);
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
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const extension = renameSession(async (session, change, context) => {
			const seed = sessionInfoSeed(worker().init.values.session);
			const before = (await readSessionInfo(harness().durable, context)) ?? seed;
			await editSessionInfo(session, change, seed, context);
			return { previous: before.title };
		});
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});

	// The server edits the session's description through its running worker. Not a `liveness.call`: the server edits
	// under its own lifecycle steps, a relocation's included, whose fence refuses calls; an edit runs no work, so
	// admitting it under the fence changes nothing a relocation checked.
	host.serve(SessionInfo, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		return {
			variant: "server",
			members: {
				edit: (change, ctx) =>
					editSessionInfo(harness().durable, change, sessionInfoSeed(worker().init.values.session), ctx),
			},
		};
	});

	// The description is written at start when the session has none (from its catalog row), titled from the first user
	// message while untitled, and reported to the catalog at start and after every change (`Sessions.describeSelf`).
	contribute(host, "p2.session-info-report", (self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const changes = self.open(
			async () =>
				new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							(change.type === "document" && change.record.kind === SessionInfoDoc.definition.kind) ||
							(change.type === "entry" && change.value.conversationId === ROOT_CONVERSATION_ID),
					),
				),
			(signal) => signal.close(),
		);
		self.onLive(async (ctx) => {
			const signal = signalOf(ctx);
			while (!signal.aborted) {
				const seen = changes.value.version;
				try {
					await describe(harness().durable, sessionInfoSeed(worker().init.values.session), ctx);
				} catch (error) {
					if (signal.aborted) return;
					console.error("p2 sessions: reporting the session's description failed:", error);
				}
				await changes.value.next(seen, signal).catch(() => {});
			}
		});
	});
});

/**
 * Writes the description when the session has none (its seed: the catalog row), gives an untitled session its first
 * user message as title, and reports the description to the catalog (which ignores an unchanged report).
 */
async function describe(durable: Harness, seed: SessionInfoState, ctx: Ctx): Promise<void> {
	let state = await readSessionInfo(durable, ctx);
	// Only an untitled session takes its first user message as title: once titled, nothing changes it but a rename.
	const untitled =
		state === undefined
			? !seed.titleEdited && seed.title === UNTITLED
			: !state.titleEdited && state.title === UNTITLED;
	const automatic = untitled ? await firstUserText(durable, ctx) : undefined;
	if (state === undefined || automatic !== undefined)
		state = await editSessionInfo(durable, automatic === undefined ? {} : { title: automatic }, seed, ctx);
	await expectVariant(await ctx.get(Sessions, {}), "worker").describeSelf(state, ctx);
}

/** The automatic title: the main conversation's first user message, line breaks as spaces, at most 100 characters. */
async function firstUserText(durable: Harness, context: Context): Promise<string | undefined> {
	const root = await durable.conversation(ROOT_CONVERSATION_ID, context);
	if (!root) return undefined;
	const page = await root.entries({ order: "ascending" }, 20, undefined, context);
	for (const entry of page.items) {
		const text = userText(entry);
		if (text !== undefined) return text.replace(/[\r\n]/g, " ").slice(0, AUTO_TITLE_LENGTH);
	}
	return undefined;
}

/** An input of the main conversation as search indexed it for the title: typed, a peer's or an agent's; not a shell command. */
function userText(entry: EntryRecord): string | undefined {
	if (entry.kind === SHELL_ENTRY) return undefined;
	if (entry.model?.[0]?.role !== "user") return undefined;
	if (entry.kind.startsWith("pi.") && entry.kind !== "pi.user") return undefined;
	const typed =
		messageData(entry.data)?.text ??
		peerMessage(entry.kind, entry.data)?.text ??
		agentMessage(entry.kind, entry.data)?.text;
	const text =
		typed ??
		entry.model
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
			)
			.join("\n");
	return text.trim() ? text : undefined;
}
