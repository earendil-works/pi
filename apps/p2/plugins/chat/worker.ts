import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
	type AgentState,
	type ConversationId,
	type ConversationView,
	type Conversation as DurableConversation,
	type Harness as DurableHarness,
	type EntryId,
	type EntryRecord,
	InboxDoc,
	type InboxItem,
	type SubmissionId,
	type TaskId,
	type UserInput,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import type { JsonValue } from "@p2/app/v1";
import {
	type Author,
	authorIdOf,
	authorOf,
	type Ctx,
	canSend,
	canView,
	DEFAULT_OWNER_NAME,
	defineFacet,
	defineTypedState,
	deriveTyped,
	expectVariant,
	type Factory,
	forbidden,
	INPUT_ENTRY,
	isGuest,
	isOwner,
	type MessageData,
	messageOf,
	SHELL_ENTRY,
	SHELL_MAX_BYTES,
	SHELL_MAX_LINES,
	type ShellData,
	serveKeyed,
	shellContextText,
	shellTail,
	signalOf,
	speakerText,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import {
	ContextTally,
	ConversationConfigured,
	conversationEnvironment,
	HarnessConfig,
	harnessOf,
	InputGates,
	mainConversation,
	ReadOnlyConversations,
	responseCosts,
	workerOf,
} from "@p2/app/v1/worker";
import { DraftStore } from "../drafts/contract.ts";
import { type Attachment, Attachments } from "../files/contract.ts";
import { WorkerModels } from "../models/contract.ts";
import { Sessions } from "../sessions/contract.ts";
import {
	Chat,
	ChatCosts,
	Conversation,
	type EntriesPage,
	type ModelMeta,
	SendRouters,
	SHELL_BUSY,
	type ShellState,
	ShellStateSchema,
	StatsSchema,
} from "./contract.ts";

/** Who wrote a queued input and what they typed, from its entry data; tool-originated input has none. */
function restoredInput(item: InboxItem): { author: Author; text: string } | undefined {
	if (item.mode === "write") return undefined;
	const message = messageOf(item.entry?.data, item.entry ? undefined : (item.content as UserInput));
	return message?.text.trim() ? { author: message.author, text: message.text } : undefined;
}

const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/** A `Chat.entries` page ends once its entries reach about this many bytes of JSON. */
const ENTRIES_PAGE_BYTES = 1_000_000;

/** How often the live output is published at most (the bash tool's sampling, 100 KiB/s). */
const SHELL_SAMPLE_MS = 200;

/** The conversation's live numbers and the running user shell command (in memory). */
const Live = defineTypedState("p2.conversation", {
	schema: obj({ stats: StatsSchema, shell: ShellStateSchema }),
	version: 1,
	initial: () => ({ stats: null, shell: null }),
});

/**
 * The message text plus attachments: a path list the agent can read with its tools (uploads stay outside the
 * project), and images inline when the conversation's model accepts them.
 */
async function content(
	text: string,
	files: readonly Attachment[],
	conversation: DurableConversation,
	models: Models | undefined,
	ctx: Ctx,
	maxImages = Number.POSITIVE_INFINITY,
): Promise<(ImageContent | { type: "text"; text: string })[]> {
	{
		if (!files.length) return [{ type: "text", text }];
		const { model: ref } = await conversation.agent(ctx);
		const model = ref ? models?.getModel(ref.provider, ref.modelId) : undefined;
		const images: ImageContent[] = [];
		const eligible = files.filter(
			(file) => file.mimeType && model?.input.includes("image") && file.size <= MAX_INLINE_IMAGE,
		);
		// With a cap, the newest images (the last ones) are inlined; the rest are only listed.
		for (const file of maxImages > 0 ? eligible.slice(-maxImages) : []) {
			if (!file.mimeType) continue;
			images.push({
				type: "image",
				mimeType: file.mimeType,
				data: (await readFile(file.localPath ?? file.path)).toString("base64"),
			});
		}
		const list = files.map((file) => `- ${file.path} (${file.name}, ${file.size} bytes)`).join("\n");
		const note = `<attachments>\nThe user attached these files:\n${list}\n</attachments>`;
		return [{ type: "text", text: text.trim() ? `${text}\n\n${note}` : note }, ...images];
	}
}

export default defineFacet((host) => {
	serveKeyed(host, SendRouters);
	host.serve(
		Conversation,
		({ conversation }, self) => {
			const id = conversation as ConversationId;
			const harness = harnessOf(self);
			const worker = workerOf(self);
			const config = self.registry(HarnessConfig);
			const gates = self.registry(InputGates);
			const configured = self.registry(ConversationConfigured);
			const models = () => config.value.get("default")?.models();
			const live = self.state(Live);
			const stats = {
				get value() {
					return live.value.stats;
				},
			};
			/** The running command as last set: a change reaches the state asynchronously, the checks need it now. */
			let shellNow: ShellState = null;
			const shell = {
				get value() {
					return shellNow;
				},
			};
			const setStats = (next: Extract<typeof live.value.stats, object>, ctx: Ctx) =>
				live.change((draft) => {
					draft.stats = next;
				}, ctx);
			/** Awaited where `ctx` (a root's) seals right after: a change still pending then would be dropped. */
			const setShell = async (next: ShellState, ctx: Ctx): Promise<void> => {
				shellNow = next;
				await live
					.change((draft) => {
						draft.shell = next;
					}, ctx)
					.catch(() => {});
			};
			/** The view's model from the catalog: name, window and levels, never provider configuration. */
			const modelMeta = (view: ConversationView | null): ModelMeta | null => {
				const ref = (view?.docs["pi.agent"] as AgentState | undefined)?.model;
				const model = ref ? models()?.getModel(ref.provider, ref.modelId) : undefined;
				return model
					? {
							provider: model.provider,
							modelId: model.id,
							name: model.name,
							contextWindow: model.contextWindow,
							reasoning: model.reasoning,
							thinkingLevels: getSupportedThinkingLevels(model),
						}
					: null;
			};
			const conversationResource = self.open(
				async (ctx) => {
					const durable = harness().durable;
					const found = await durable.conversation(id, ctx);
					if (found === undefined) throw new Error(`Unknown conversation ${id}`);
					return { harness: durable, conversation: found };
				},
				() => {},
			);
			// Durable's default window (the newest 50, appends, back to 50 past 100), shared by every viewer.
			const view = deriveTyped(
				self,
				[self.follow((observer, ctx) => harness().durable.observeConversation(id, observer, ctx))],
				([value]) => value as ConversationView | null,
			);
			const modelState = deriveTyped(self, [view, config], ([value]) => modelMeta(value));
			/**
			 * The active context's numbers follow the entries the window appends (a scan of the new ones). A whole context
			 * is read only when the active range changes otherwise (`ContextTally.advance`): at the start, after a
			 * compaction, reset or edit, or when the window skipped entries. Views arriving while it is read are taken from
			 * the newest view after it.
			 */
			const tally = new ContextTally();
			let reading = true;
			let wake: (() => void) | undefined;
			const publish = async (ctx: Ctx) => {
				const next = tally.stats;
				const current = stats.value;
				if (
					current?.contextTokens !== next.contextTokens ||
					current.latestAssistantUsage !== next.latestAssistantUsage
				)
					await setStats(next, ctx);
			};
			self.on(view, async ({ value }, ctx) => {
				if (!value || reading) return;
				if (tally.advance(value)) await publish(ctx);
				else {
					reading = true;
					wake?.();
				}
			});
			self.onLive(async (ctx) => {
				const signal = signalOf(ctx);
				while (!signal.aborted) {
					if (!reading)
						await new Promise<void>((resolve) => {
							const abort = () => resolve();
							wake = () => {
								signal.removeEventListener("abort", abort);
								resolve();
							};
							signal.addEventListener("abort", abort, { once: true });
						});
					wake = undefined;
					if (signal.aborted) return;
					tally.reset(await conversationResource.value.conversation.context(ctx));
					const current = view.value;
					reading = current !== null && !tally.advance(current);
					await publish(ctx);
				}
			});
			const target = (): { harness: DurableHarness; conversation: DurableConversation } =>
				conversationResource.value;
			/** The queued inputs (not writes) by submission order. */
			const queued = async (context: ReturnType<typeof durableContext>) => {
				const { harness: durable, conversation: current } = target();
				const inbox = await durable.snapshot(InboxDoc, current.id, context);
				return (inbox?.items ?? []).filter((item) => item.mode !== "write").toSorted((a, b) => a.id - b.id);
			};
			/**
			 * The running user shell command (one per conversation) and the commands already admitted per author request,
			 * so a retried call runs once. Closing the object (no viewer for its linger time, a reload) cancels it.
			 */
			let running: { id: string; abort: AbortController } | undefined;
			const admitted = new Map<string, string>();
			self.open(
				async () => ({}),
				() => running?.abort.abort(),
			);
			/** Runs `command` and places its entry; the live state follows the output (sampled). */
			const runShell = async (
				shellId: string,
				input: { command: string; includeInContext: boolean; author: Author },
				abort: AbortController,
				ctx: Ctx,
			): Promise<void> => {
				let live: Extract<ShellState, object> = {
					id: shellId,
					command: input.command,
					author: input.author,
					includeInContext: input.includeInContext,
					output: "",
					truncated: false,
					running: true,
					cancelled: false,
				};
				await setShell(live, ctx);
				let output = "";
				let truncated = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const publish = () => {
					timer = undefined;
					if (shell.value?.id !== shellId) return;
					live = { ...live, output, truncated };
					void setShell(live, ctx);
				};
				let ended: Pick<ShellData, "exitCode" | "fullOutputPath" | "error"> = {};
				try {
					// Where the conversation works: a subagent's own location may be on another machine than the session.
					const { location, env } = await conversationEnvironment(harness().environments, id, durableContext(ctx));
					const result = await env.exec(
						input.command,
						{
							cwd: location.cwd,
							inheritEnv: true,
							spill: { afterBytes: SHELL_MAX_BYTES, afterLines: SHELL_MAX_LINES },
							window: {
								maxBytes: SHELL_MAX_BYTES,
								maxLines: SHELL_MAX_LINES,
								minIntervalMs: SHELL_SAMPLE_MS,
								bytesPerSecond: 100 * 1024,
							},
							onOutput: (text, _context, info) => {
								// The environment omitted output outside the kept tail: what follows replaces it.
								if (info.skipped) {
									output = "";
									truncated = true;
								}
								const tail = shellTail(output + text);
								output = tail.text;
								truncated ||= tail.truncated;
								timer ??= setTimeout(publish, SHELL_SAMPLE_MS);
							},
						},
						durableContext(abort.signal),
					);
					if (result.ok)
						ended = {
							exitCode: result.value.exitCode,
							...(result.value.spillPath ? { fullOutputPath: result.value.spillPath } : {}),
						};
					else if (result.error.code !== "aborted")
						ended = {
							error: result.error.code === "timeout" ? "Command timed out" : result.error.message,
							...(result.error.spillPath ? { fullOutputPath: result.error.spillPath } : {}),
						};
				} catch (error) {
					ended = { error: error instanceof Error ? error.message : String(error) };
				} finally {
					clearTimeout(timer);
				}
				const cancelled = abort.signal.aborted;
				// A command's last newline ends its output; it is not an empty last line.
				output = output.replace(/\r?\n$/, "");
				const data: ShellData = {
					author: input.author,
					command: input.command,
					output,
					cancelled,
					truncated,
					includeInContext: input.includeInContext,
					...ended,
				};
				live = {
					...live,
					output,
					truncated,
					running: false,
					cancelled,
					...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
					...(ended.error === undefined ? {} : { error: ended.error }),
				};
				await setShell(live, ctx);
				try {
					// A write never starts a run; while the agent works it is placed at the run's next boundary.
					const submission = await target().conversation.submit(
						{
							type: "write",
							entry: {
								kind: SHELL_ENTRY,
								data: data as unknown as JsonValue,
								...(input.includeInContext
									? {
											model: [
												{
													role: "user" as const,
													content: [
														{ type: "text" as const, text: speakerText(input.author) },
														{ type: "text" as const, text: shellContextText(data) },
													],
													timestamp: Date.now(),
												},
											],
										}
									: {}),
							},
							requestId: `${input.author.id}:shell:${shellId}`,
						},
						durableContext(ctx),
					);
					await submission.wait(durableContext(ctx));
				} finally {
					// The entry shows the command from now on (or the write failed: nothing to keep showing).
					if (shell.value?.id === shellId) await setShell(null, ctx);
				}
			};
			return {
				view,
				stats: deriveTyped(self, [live], ([value]) => value.stats),
				model: modelState,
				shell: deriveTyped(self, [live], ([value]) => value.shell),
				costs: async (ctx) =>
					responseCosts((await target().conversation.context(durableContext(ctx))).entries).map(
						({ cacheHit, ...cost }) => (cacheHit === undefined ? cost : { ...cost, cacheHit }),
					),
				runShell: async ({ command, includeInContext, requestId, author }, ctx) => {
					const key = `${author.id}:${requestId}`;
					const known = admitted.get(key);
					if (known) return { shellId: known };
					if (shell.value?.running) throw new Error(SHELL_BUSY);
					for (const gate of gates.value.values()) await gate(ctx);
					const shellId = crypto.randomUUID();
					admitted.set(key, shellId);
					if (admitted.size > 100) admitted.delete(admitted.keys().next().value!);
					const abort = new AbortController();
					running = { id: shellId, abort };
					// An active call while it runs: the worker stays up, and a move or clone waits for it.
					// The method returns now: the command runs under its own root context, not the call's.
					void worker()
						.liveness.call(() =>
							worker().root((root) => runShell(shellId, { command, includeInContext, author }, abort, root)),
						)
						.catch((error: unknown) => console.error("shell:", error))
						.finally(() => {
							if (running?.id === shellId) running = undefined;
						});
					return { shellId };
				},
				abortShell: async ({ shellId }) => {
					if (running?.id !== shellId || running.abort.signal.aborted) return { aborted: false };
					running.abort.abort();
					return { aborted: true };
				},
				compact: async ({ instructions }, ctx) => {
					const taskId = await target().conversation.compact(
						instructions?.trim() || undefined,
						durableContext(ctx),
					);
					return { taskId };
				},
				reset: async ({ handoff }, ctx) => {
					await target().conversation.reset(handoff?.trim() || undefined, durableContext(ctx));
					return null;
				},
				abortCompaction: async (ctx) => {
					const context = durableContext(ctx);
					const { harness: durable } = target();
					// The live compaction tasks of this conversation, as its view shows them.
					const running = view.value?.docs["pi.live"] as { compactions?: { taskId: number }[] } | undefined;
					let aborted = 0;
					for (const { taskId } of running?.compactions ?? [])
						if ((await durable.abortTask(taskId as TaskId, context)) === "marked") aborted++;
					return { aborted };
				},
				dequeueOwn: async ({ authorId }, ctx) => {
					const context = durableContext(ctx);
					const { harness: durable, conversation: current } = target();
					// Selected by the author stamped into each input's entry, never by client-supplied IDs.
					const restored: { author: Author; text: string }[] = [];
					let skipped = 0;
					for (const item of await queued(context)) {
						const input = restoredInput(item);
						if (input?.author.id !== authorId) continue;
						if ((await durable.abortSubmission(item.id as SubmissionId, context, current.id)) === "aborted")
							restored.push(input);
						else skipped++;
					}
					return { restored, skipped };
				},
				submit: async ({ text, requestId, whenBusy, author, files, maxImages, entry }, ctx) => {
					for (const gate of gates.value.values()) await gate(ctx);
					const { conversation: current } = target();
					const data: MessageData = {
						author,
						text,
						attachments: (files ?? []).map(({ id, name }) => ({ id, name })),
					};
					const submission = await current.submit(
						{
							type: "input",
							// The speaker block stays for the model (the system prompt attributes input by it); readers use the data.
							content: [
								{ type: "text", text: speakerText(author) },
								...(await content(text, files ?? [], current, models(), ctx, maxImages)),
							],
							entry: entry ? { kind: entry.kind, data: entry.data as JsonValue } : { kind: INPUT_ENTRY, data },
							requestId: `${author.id}:${requestId}`,
							whenBusy: whenBusy ?? "steer",
						},
						durableContext(ctx),
					);
					return { submissionId: submission.id };
				},
				write: async ({ kind, data, requestId, author }, ctx) => {
					for (const gate of gates.value.values()) await gate(ctx);
					const submission = await target().conversation.submit(
						{ type: "write", entry: { kind, data: data as JsonValue }, requestId: `${author.id}:${requestId}` },
						durableContext(ctx),
					);
					return { submissionId: submission.id };
				},
				stop: async (ctx) => {
					const context = durableContext(ctx);
					const { harness: durable, conversation: current } = target();
					// Conversation.abort() discards queued inputs. Withdraw them first, one by one, so each author gets
					// their text back; already placed ones are skipped.
					const restored: { author: Author; text: string }[] = [];
					const inbox = await durable.snapshot(InboxDoc, current.id, context);
					for (const item of inbox?.items ?? []) {
						if (item.mode === "write") continue;
						if ((await durable.abortSubmission(item.id as SubmissionId, context, current.id)) !== "aborted")
							continue;
						const input = restoredInput(item);
						if (input) restored.push(input);
					}
					await current.abort(context, { background: false });
					return { restored };
				},
				dequeue: async ({ submissionId, restore }, ctx) => {
					const context = durableContext(ctx);
					const { harness: durable, conversation: current } = target();
					// Removing (no restore) discards the input: its text goes to nobody.
					const item = restore
						? (await durable.snapshot(InboxDoc, current.id, context))?.items.find(
								(entry) => entry.id === submissionId,
							)
						: undefined;
					const result = await durable.abortSubmission(submissionId as SubmissionId, context, current.id);
					if (result === "not_found") throw new Error("Unknown queued message");
					// If it raced into the transcript, it is not returned to the editor (no duplicate).
					const input = result === "aborted" && item ? restoredInput(item) : undefined;
					return { restored: input ? [input] : [] };
				},
				entries: async ({ limit, ...query }, ctx) => {
					const context = durableContext(ctx);
					const { conversation: current } = target();
					const page = await current.entries(
						{
							...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId as EntryId }),
							...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId as EntryId }),
							...(query.order === undefined ? {} : { order: query.order }),
						},
						limit,
						undefined,
						context,
					);
					// Cut at about a megabyte (images make entries large); the loader asks again from where it ends.
					const items: EntryRecord[] = [];
					let bytes = 0;
					for (const entry of page.items) {
						if (items.length > 0 && bytes >= ENTRIES_PAGE_BYTES) break;
						items.push(entry);
						bytes += JSON.stringify(entry).length;
					}
					return {
						items,
						more: items.length < page.items.length || page.next !== undefined,
					} satisfies EntriesPage;
				},
				configure: async ({ model, thinkingLevel }, ctx) => {
					if (model && !models()?.getModel(model.provider, model.modelId)) throw new Error("Unknown model");
					const current = target().conversation;
					await current.configure(
						{ ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}) },
						durableContext(ctx),
					);
					for (const after of configured.value.values()) await after(current, ctx);
					return null;
				},
			};
		},
		// Switching back to a conversation quickly does not reopen its watch.
		{ linger: 30_000 },
	);

	/** A conversation as a principal sees it (a declared factory, so the call below can take options). */
	const chatFactory: Factory<typeof Chat> = ({ session, conversation }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		if (!isOwner(principal) && !isGuest(principal)) throw forbidden("people only");
		const authorId = authorIdOf(principal);
		const chat = self.get(Conversation, { conversation });
		const settings = self.get(WorkerModels, {});
		/** The author an entry records, with the owner's name as settings.json says now. */
		const author = (): Author => authorOf(principal, settings.settings.value.ownerName ?? DEFAULT_OWNER_NAME);
		const worker = workerOf(self);
		const harness = harnessOf(self);
		// Each live Chat object is a viewer: the worker stays up while someone looks.
		self.open(
			async () => worker().liveness.add("viewers", 1),
			() => worker().liveness.add("viewers", -1),
		);
		const entries: typeof chat.entries = (query, ctx) => chat.entries(query, ctx);
		if (!canSend(principal, session))
			return {
				variant: "viewer",
				members: { view: chat.view, stats: chat.stats, model: chat.model, liveShell: chat.shell, entries },
			};
		const call = <T>(fn: () => Promise<T>): Promise<T> => worker().liveness.call(fn);
		/** Refuses writes a plugin does not allow here (a one-shot agent's conversation); Stop is not one of them. */
		const readOnlyConversations = self.registry(ReadOnlyConversations);
		const routers = self.registry(SendRouters);
		const writable = async (ctx: Ctx): Promise<void> => {
			for (const readOnly of readOnlyConversations.value.values()) {
				const reason = await readOnly(conversation, ctx);
				if (reason) throw forbidden(reason);
			}
		};
		/** The caller's own texts; other authors' go to their drafts (restored to their composers). */
		const own = async (restored: readonly { author: Author; text: string }[], ctx: Ctx): Promise<string[]> => {
			const others = restored.filter((item) => item.author.id !== authorId);
			if (others.length) await (await ctx.get(DraftStore, {})).add({ conversation, items: others }, ctx);
			return restored.filter((item) => item.author.id === authorId).map((item) => item.text);
		};
		return {
			variant: "participant",
			members: {
				view: chat.view,
				stats: chat.stats,
				model: chat.model,
				liveShell: chat.shell,
				entries,

				compact: (args, ctx) =>
					call(async () => {
						await writable(ctx);
						return chat.compact(args, ctx);
					}),
				abortCompaction: (ctx) => call(() => chat.abortCompaction(ctx)),
				reset: (args, ctx) =>
					call(async () => {
						// A new context changes what the agent knows for everyone in the session: the owner's choice.
						if (principal.kind !== "owner") throw forbidden("only the owner starts a new context");
						await writable(ctx);
						return chat.reset(args, ctx);
					}),
				shell: (input, ctx) =>
					call(async () => {
						// Anyone who may send may run commands, as tools run them for them (full guests included).
						await writable(ctx);
						if (!input.command.trim()) throw new Error("Invalid command");
						return chat.runShell({ ...input, author: author() }, ctx);
					}),
				abortShell: ({ shellId }, ctx) =>
					call(async () => {
						// Its author or the owner; the command's author comes from the conversation's live state.
						const live = chat.shell.value;
						if (live?.id === shellId && principal.kind !== "owner" && live.author.id !== authorId)
							throw forbidden("only its author or the owner cancels a command");
						return chat.abortShell({ shellId }, ctx);
					}),
				dequeueOwn: (ctx) =>
					call(async () => {
						await writable(ctx);
						const { restored, skipped } = await chat.dequeueOwn({ authorId }, ctx);
						return { restored: restored.map((item) => item.text), skipped };
					}),
				send: ({ attachments, ...input }, ctx) =>
					call(async () => {
						// As Pi Mobile: a message has text or attachments.
						if (!input.text.trim() && !attachments?.length) throw new Error("Invalid content");
						await writable(ctx);
						for (const route of routers.value.values()) {
							const routed = await route(
								{ ...input, conversation, author: author(), attachments: attachments ?? [] },
								ctx,
							);
							if (routed) return routed;
						}
						const files = attachments?.length
							? await (await ctx.get(Attachments, {})).resolve({ ids: attachments, conversation }, ctx)
							: undefined;
						return chat.submit({ ...input, author: author(), ...(files ? { files } : {}) }, ctx);
					}),
				stop: (ctx) =>
					call(async () => {
						const { restored } = await chat.stop(ctx);
						return { restored: await own(restored, ctx) };
					}),
				dequeue: ({ submissionId, restore }, ctx) =>
					call(async () => {
						await writable(ctx);
						// Moving back to the editor returns the caller's own text and files other authors' as their drafts;
						// removing (×) discards it, whoever wrote it.
						const { restored } = await chat.dequeue({ submissionId, restore: restore ?? false }, ctx);
						const [text] = await own(restored, ctx);
						return { text: text ?? null };
					}),
				configure: (change, ctx) =>
					call(async () => {
						// The model and thinking level are the owner's choice (and cost).
						if (principal.kind !== "owner") throw forbidden("only the owner configures the model");
						await writable(ctx);
						await chat.configure(change, ctx);
						// The main conversation's model is the session's: the sidebar and the next worker start use it. Either
						// field alone updates it (Pi Mobile's configure).
						if (
							(change.model || change.thinkingLevel) &&
							conversation === (await mainConversation(harness().durable, durableContext(ctx)))
						) {
							await expectVariant(await ctx.get(Sessions, {}), "worker").configureSelf(
								{
									...(change.model ? { model: change.model } : {}),
									...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
								},
								ctx,
							);
						}
						return null;
					}),
			},
		};
	};
	host.serve(ChatCosts, ({ session, conversation }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const chat = self.get(Conversation, { conversation });
		return { variant: "viewer", members: { costs: (ctx) => chat.costs(ctx) } };
	});
	host.serve(Chat, chatFactory);
});
