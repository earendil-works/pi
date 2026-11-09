// The discord plugin's worker facet: what the server hands a session's worker. A batch becomes one input of the main
// conversation (or a thread's subagent), its attachments downloaded into the session's uploads first; a turn's answer is
// read from Durable when the server asks; a thread gets a subagent forked from the main conversation.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	type ConversationId,
	defineDoc,
	defineExtension,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type SubmissionId,
	section,
} from "@earendil-works/pi-durable";
import {
	type Context,
	type Ctx,
	contribute,
	defineFacet,
	forbidden,
	type MessageData,
	type Ref,
	safeFileName,
} from "@p2/app/v1";
import { DOWNLOADS, displayName, durableContext, FILE_CHUNK, Files, findDownload, UPLOADS } from "@p2/app/v1/node";
import { Extensions, harnessOf, isTopLevel, mainConversation } from "@p2/app/v1/worker";
import { Conversation } from "../chat/contract.ts";
import { Attachments, FilesMirror } from "../files/contract.ts";
import { offeredBy } from "../send-file/contract.ts";
import { mirrorLock } from "../sessions/lock-worker.ts";
import { Subagents } from "../subagents/contract.worker.ts";
import { DISCORD_BATCH, DiscordIngress } from "./contract.ts";

/** Attachments up to this size are downloaded (the composer's upload limit). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The image types the model may get inline (the composer's: files/uploads.ts). */
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/**
 * The session's Discord link as its agents learn it (session-scoped): the channel, and the conversations of its threads'
 * subagents with their threads' names. Written at each delivery, cleared when the session is unlinked.
 */
export const DiscordLinkDoc = defineDoc<{
	link: { channel: string; guild: string } | null;
	threads: Record<string, string>;
}>({
	kind: "p2.discord-link",
	version: 1,
	scope: "session",
	initial: () => ({ link: null, threads: {} }),
	checkpointWhen: () => true,
});

/**
 * What an agent answering Discord must know, in two sentences: stable for a link (it changes only with the channel or
 * thread), so the prompt's cached prefix stays.
 */
export function discordPrompt(where: string): string {
	return [
		`Your input comes from ${where}; your final answer of each turn is posted there as the reply, with the files you`,
		"offer with send_file during the turn attached. Nothing else is posted (not intermediate text, thinking or tool",
		"output), so make the final answer complete on its own.",
	].join(" ");
}

/** The Discord section: on for the main agent of a linked session and for its threads' subagents. */
export const discordExtension = defineExtension({
	name: "p2-discord",
	sections: [
		section("discord", async (input, context) => {
			const doc = await input.read.snapshot(DiscordLinkDoc, context);
			if (!doc?.link) return undefined;
			const channel = `the Discord channel #${doc.link.channel} (${doc.link.guild})`;
			const thread = doc.threads[String(input.conversationId)];
			if (thread !== undefined) return discordPrompt(`the thread "${thread}" of ${channel}`);
			return (await isTopLevel(input.read, input.conversationId, context)) ? discordPrompt(channel) : undefined;
		}),
	],
});

export default defineFacet((host) => {
	contribute(host, "p2.discord-extension", (self) => {
		self.contribute(Extensions, { [discordExtension.name]: discordExtension });
	});

	host.serve(DiscordIngress, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const files = self.get(Files, {});
		const attachments = self.get(Attachments, {});
		const mirror = self.get(FilesMirror, {});
		return {
			variant: "server",
			members: {
				deliver: async ({ conversation, requestId, author, text, context, files: downloads, lock }, ctx) => {
					const durable = harness().durable;
					await mirrorLock(durable, lock, durableContext(ctx));
					const target = conversation ?? (await mainConversation(durable, durableContext(ctx)));
					await durable.commit(async (tx) => {
						const doc = await tx.doc(DiscordLinkDoc);
						doc.link = { channel: context.channel, guild: context.guild };
						if (conversation !== undefined && context.thread !== undefined)
							doc.threads[String(conversation)] = context.thread;
					}, durableContext(ctx));
					const ids: { id: string; name: string }[] = [];
					for (const file of downloads) {
						const id = await download(files, file, ctx);
						if (id) ids.push({ id, name: file.name });
					}
					// The Files sheet lists them as it lists the composer's uploads.
					if (ids.length) await mirror.push(UPLOADS, ctx);
					const resolved = ids.length
						? await attachments.resolve({ ids: ids.map((entry) => entry.id), conversation: target }, ctx)
						: [];
					const who = { kind: "guest" as const, id: `discord:${author.id}`, name: `${author.name} · Discord` };
					const data: MessageData & { discord: typeof context } = {
						author: who,
						text,
						attachments: ids,
						discord: context,
					};
					const chat = await ctx.get(Conversation, { conversation: target });
					const { submissionId } = await chat.submit(
						{
							text,
							requestId,
							whenBusy: "followUp",
							author: who,
							...(resolved.length ? { files: resolved } : {}),
							entry: { kind: DISCORD_BATCH, data },
						},
						ctx,
					);
					return { conversation: target, submissionId };
				},
				unlinked: async (ctx) => {
					await harness().durable.commit(async (tx) => {
						const doc = await tx.doc(DiscordLinkDoc);
						doc.link = null;
						doc.threads = {};
					}, durableContext(ctx));
					return null;
				},
				turn: async ({ submissionId }, ctx) => {
					const durable = harness().durable;
					const context = durableContext(ctx);
					const submission = await durable.submission(submissionId as SubmissionId, context);
					// Gone: withdrawn while queued (a stop).
					if (!submission) return { state: "stopped" as const };
					const record = await submission.status(context);
					if (record.type !== "input") return { state: "unanswered" as const, reason: "Not an input.", files: [] };
					if (record.status === "queued" || record.status === "placed") return { state: "pending" as const };
					if (record.status === "unanswered" && record.reason === "aborted") return { state: "stopped" as const };
					// The turn's span: from its input (its message's time) to its answer, or until now without one.
					const input =
						record.entry === undefined
							? undefined
							: await entryOf(durable, record.conversationId, record.entry, context);
					const start = input?.model?.[0]?.timestamp ?? 0;
					if (record.status === "unanswered")
						return {
							state: "unanswered" as const,
							reason: record.reason || "The turn ended without an answer.",
							files: await offered(files, record.conversationId, start, Date.now(), ctx),
						};
					const answer = await entryOf(durable, record.conversationId, record.answer, context);
					const message = answer?.model?.[0] as AssistantMessage | undefined;
					if (message?.stopReason === "aborted") return { state: "stopped" as const };
					const text = (message?.content ?? [])
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("")
						.trim();
					const sent = await offered(files, record.conversationId, start, message?.timestamp ?? Date.now(), ctx);
					return text || sent.length
						? { state: "answered" as const, text, files: sent }
						: {
								state: "unanswered" as const,
								reason:
									message?.stopReason === "error"
										? (message.errorMessage ?? "The model failed.")
										: "The answer has no text.",
								files: sent,
							};
				},
				read: async ({ id, offset, length }, ctx) => {
					const found = await findDownload(files, id, ctx);
					if (!found) throw new Error("No such file");
					return files.read({ id: found.file.id, offset, length }, ctx);
				},
				command: async ({ conversation, command }, ctx) => {
					const durable = harness().durable;
					const context = durableContext(ctx);
					const target = conversation ?? (await mainConversation(durable, context));
					const chat = await ctx.get(Conversation, { conversation: target });
					// From Durable itself: the conversation's view may not have caught up with a compaction just started.
					const live = await durable.snapshot(LiveDoc, target as ConversationId, context);
					const inbox = await durable.snapshot(InboxDoc, target as ConversationId, context);
					const queued = (inbox?.items ?? []).filter((item) => item.mode !== "write").length;
					const working = Boolean(live?.run);
					const compacting = live?.compactions?.length ?? 0;
					if (command === "stop") {
						if (!working && !queued && !compacting) return { text: "Nothing is running." };
						const replies: string[] = [];
						if (working || queued) {
							// The web's Stop: queued inputs withdrawn first, then the run aborted.
							const withdrawn = (await chat.stop(ctx)).restored.length;
							replies.push(
								withdrawn
									? `Stopped; ${withdrawn} queued message${withdrawn === 1 ? "" : "s"} withdrawn.`
									: "Stopped.",
							);
						}
						// A compaction is a task of its own, which Stop leaves running: aborted as the web's Escape does.
						let aborted = 0;
						for (const { taskId } of live?.compactions ?? [])
							if ((await durable.abortTask(taskId, context)) === "marked") {
								await durable.waitForTask(taskId, context);
								aborted++;
							}
						if (aborted) replies.push("Stopped compaction.");
						return { text: replies.join(" ") || "Nothing is running." };
					}
					if (command === "compact") {
						await chat.compact({}, ctx);
						return { text: "Compacting the context." };
					}
					const model = chat.model.value;
					const tokens = chat.stats.value?.contextTokens;
					// The cost sheet's data: each response of the active range with its cost.
					const costs = await chat.costs(ctx);
					const total = costs.reduce((sum, entry) => sum + entry.cost, 0);
					const since = await lastInputTime(durable, target as ConversationId, context);
					const lastTurn =
						since === undefined
							? undefined
							: costs.filter((entry) => entry.timestamp >= since).reduce((sum, entry) => sum + entry.cost, 0);
					const usage =
						tokens === undefined
							? "unknown"
							: model?.contextWindow
								? `${tokens.toLocaleString("en-US")} of ${model.contextWindow.toLocaleString("en-US")} tokens (${Math.round((tokens / model.contextWindow) * 100)}%)`
								: `${tokens.toLocaleString("en-US")} tokens`;
					return {
						text: [
							`Model: ${model ? `${model.name} (${model.provider}/${model.modelId})` : "none"}`,
							`Working: ${working ? "yes" : "no"}`,
							...(compacting ? ["Compacting: yes"] : []),
							`Queued: ${queued}`,
							`Context: ${usage}`,
							`Cost: ${dollars(total)} so far${lastTurn === undefined ? "" : `, last turn ${dollars(lastTurn)}`}`,
						].join("\n"),
					};
				},
				thread: async ({ name, before }, ctx) => {
					const conversation = await forkThread(harness().durable, name, before, durableContext(ctx));
					return { conversation };
				},
			},
		};
	});
});

/** Downloads a Discord attachment into the session's uploads (its key makes a retry find it); its upload ID. */
async function download(
	files: Ref<typeof Files>,
	file: { url: string; name: string; size: number; key: string; ref: string },
	ctx: Ctx,
): Promise<string | undefined> {
	const existing = await files.byKey({ space: UPLOADS, key: file.key }, ctx);
	if (existing) return file.key;
	if (file.size > MAX_UPLOAD_BYTES) return undefined;
	const path = `${file.key.replaceAll(":", "-")}-${safeFileName(file.name)}`;
	const begun = await files.begin(
		{
			space: UPLOADS,
			path,
			mime: IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream",
			source: "discord",
			key: file.key,
			ref: file.ref,
			meta: { name: file.name },
		},
		ctx,
	);
	if (begun.kind === "exists") return file.key;
	try {
		const response = await fetch(file.url, { signal: ctx.abortSignal });
		if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
		let offset = 0;
		let pending = Buffer.alloc(0);
		const reader = response.body.getReader();
		for (;;) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= FILE_CHUNK) {
				await files.append({ upload: begun.upload, offset, bytes: pending.subarray(0, FILE_CHUNK) }, ctx);
				offset += FILE_CHUNK;
				pending = pending.subarray(FILE_CHUNK);
				if (offset > MAX_UPLOAD_BYTES) throw new Error("Attachment too large");
			}
		}
		if (pending.length) await files.append({ upload: begun.upload, offset, bytes: pending }, ctx);
		await files.finish(begun.upload, ctx);
		return file.key;
	} catch (error) {
		await files.cancel(begun.upload, ctx).catch(() => {});
		console.error(`p2 discord: could not download ${file.name}:`, error instanceof Error ? error.message : error);
		return undefined;
	}
}

/**
 * The files conversation `conversation` offered (`send_file`, also from scripts) between `start` and `end` (ms since
 * the epoch): a turn's, oldest first.
 */
async function offered(
	files: Ref<typeof Files>,
	conversation: number,
	start: number,
	end: number,
	ctx: Ctx,
): Promise<{ id: string; name: string; size: number }[]> {
	const found: { id: string; name: string; size: number }[] = [];
	let after: string | undefined;
	do {
		const page = await files.byRef(
			{ space: DOWNLOADS, ref: offeredBy(conversation), ...(after ? { after } : {}) },
			ctx,
		);
		for (const file of page.items)
			if (file.key && file.created >= start && file.created <= end)
				found.push({ id: file.key, name: displayName(file), size: file.size });
		after = page.next;
	} while (after !== undefined);
	return found;
}

/** When the newest input of `conversation` was sent (its user message's time): where its last turn began. */
async function lastInputTime(
	durable: Harness,
	conversation: ConversationId,
	context: Context,
): Promise<number | undefined> {
	const handle = await durable.conversation(conversation, context);
	// Newest first; a turn's tail fits one page.
	const page = await handle?.entries({}, 200, undefined, context);
	return page?.items.find((entry) => entry.model?.[0]?.role === "user")?.model?.[0]?.timestamp;
}

/** A cost in dollars, as the cost sheet writes it. */
function dollars(value: number): string {
	return `$${value.toFixed(value >= 0.01 || value === 0 ? 4 : 6)}`;
}

async function entryOf(
	durable: Harness,
	conversationId: ConversationId,
	id: EntryId,
	context: Context,
): Promise<EntryRecord | undefined> {
	const conversation = await durable.conversation(conversationId, context);
	const page = await conversation?.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context);
	return page?.items[0];
}

/** When an entry was written, if it is a finished answer (an assistant message that ended its turn). */
function finished(entry: EntryRecord): number | undefined {
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	const stop = (message as AssistantMessage).stopReason;
	return stop === "stop" || stop === "length" ? message.timestamp : undefined;
}

/**
 * A subagent for a Discord thread, forked from the main conversation at its last finished answer before `before`, or a
 * new conversation with the main agent's configuration when there is none; registered as subagent `name` (unique).
 * It follows the session's location and has no reporter: its answers go back to the thread.
 */
async function forkThread(durable: Harness, label: string, before: number, context: Context) {
	const main = await mainConversation(durable, context);
	const conversation = await durable.conversation(main, context);
	if (!conversation) throw new Error("No main conversation");
	// Newest first (the default order), a page at a time, until an answer before the thread's creation.
	let point: EntryRecord | undefined;
	let cursor: Parameters<typeof conversation.entries>[2];
	do {
		const page = await conversation.entries({}, 200, cursor, context);
		point = page.items.find((entry) => (finished(entry) ?? Number.POSITIVE_INFINITY) < before);
		cursor = page.next;
	} while (!point && cursor !== undefined);
	const base = `discord-${
		safeFileName(label)
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "thread"
	}`;
	return durable.commit(async (tx) => {
		const state = await tx.doc(Subagents, ROOT_CONVERSATION_ID);
		let name = base;
		for (let index = 2; Object.hasOwn(state.agents, name); index++) name = `${base}-${index}`;
		const owner = { ownership: { kind: "ownerless" as const } };
		// A fork carries the agent as it was at its entry (AgentDoc forks as of it); a new conversation gets today's.
		const agent = JSON.parse(JSON.stringify(await tx.doc(AgentDoc, main))) as AgentState;
		let child: ConversationId;
		if (point) child = (await tx.forkConversation(main, point.id, owner)).id;
		else {
			child = (await tx.createConversation(owner)).id;
			Object.assign(await tx.doc(AgentDoc, child), agent);
		}
		state.agents[name] = {
			conversationId: child,
			model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "",
			thinkingLevel: agent.thinkingLevel ?? "off",
			tools: Array.isArray(agent.tools) ? [...agent.tools] : [],
			reported: [],
		};
		return child;
	}, context);
}
