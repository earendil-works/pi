import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "../../../context.ts";
import { insertEntry, insertUsage } from "../../commit.ts";
import type {
	JsonValue,
	LaneConfiguration,
	LaneState,
	Session,
	SessionMetadata,
	SessionRepo,
	UsageRow,
} from "../../types.ts";
import {
	appendList,
	branchTip,
	entryLabel,
	laneConfig,
	laneState,
	list,
	operationMeta,
	operationPreparation,
	operationResult,
	operationState,
	operationToolArgs,
	pendingEntry,
	sessionName,
	setValue,
	value,
} from "../../values.ts";
import type { ConformanceCase } from "../types.ts";

const ROOT_ID = "00000000-0000-7000-8000-000000000001";
const CHILD_ID = "00000000-0000-7000-8000-000000000002";
const SIBLING_ID = "00000000-0000-7000-8000-000000000003";
const USAGE_ID = "00000000-0000-7000-8000-000000000004";
const OPERATION_ID = "00000000-0000-7000-8000-000000000005";
const PENDING_ID = "00000000-0000-7000-8000-000000000006";
const UNKNOWN_ID = "00000000-0000-7000-8000-000000000007";
const idleLaneState = {
	currentOperationId: null,
	lastOperationId: null,
	inbox: [],
} satisfies LaneState;
const applicationValue = value<JsonValue>("test.application.value");
const applicationList = list<JsonValue>("test.application.list");
const configuration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;

async function getBranchTip(session: Session, name = "main"): Promise<string | null | undefined> {
	return (await session.branch(name, BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT);
}

function assistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "call", name: "read", arguments: {} }]
				: [{ type: "text", text: stopReason }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "deferred"
			? {
					deferred: {
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						api: "anthropic-messages",
						id: "job",
					},
				}
			: {}),
		timestamp: 1,
	};
}

function usageRow(): Omit<UsageRow, "seq"> {
	return {
		id: USAGE_ID,
		adjustment: true,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

interface RepoCaseContext<TRepo> {
	repo: TRepo;
	close?: () => void | Promise<void>;
}

function prepareRepoCaseFactory<TRepo>(
	factory: () => Promise<TRepo>,
	onClose?: () => void | Promise<void>,
): () => Promise<RepoCaseContext<TRepo>> {
	return async () => ({
		repo: await factory(),
		...(onClose === undefined ? {} : { close: onClose }),
	});
}

function createCase<TRepo>(
	factory: () => Promise<RepoCaseContext<TRepo>>,
	group: string,
	name: string,
	test: (context: { repo: TRepo }) => Promise<void>,
): ConformanceCase {
	return {
		group,
		name,
		async run() {
			const context = await factory();
			try {
				await test(context);
			} finally {
				await context.close?.();
			}
		},
	};
}

/** Creates lifecycle cases for repositories that support creation, discovery, open, and deletion. */
export function createSessionRepoLifecycleConformance<TMetadata extends SessionMetadata>(
	// Require only the methods this group exercises so partial backends can run it independently.
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "open" | "list" | "delete">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(
			factory,
			"lifecycle",
			"creates a session with no implicit branch and rejects duplicate ids",
			async ({ repo }) => {
				const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);

				strictEqual(session.metadata.id, "session");
				strictEqual(Number.isSafeInteger(session.metadata.createdAt), true);
				strictEqual(session.metadata.storageVersion, 1);
				strictEqual(await session.branch("main", BACKGROUND_CONTEXT), undefined);
				strictEqual(await session.getValue(laneState("main"), BACKGROUND_CONTEXT), undefined);
				strictEqual(await session.getValue(laneConfig("main"), BACKGROUND_CONTEXT), undefined);
				await rejects(repo.create({ id: "session" }, BACKGROUND_CONTEXT));
				await session.close(BACKGROUND_CONTEXT);
			},
		),
		createCase(
			factory,
			"lifecycle",
			"close drains an acquired scope and rejects a queued mutation callback",
			async ({ repo }) => {
				const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
				const active = await session.beginMutation(BACKGROUND_CONTEXT);
				let queuedStarted = false;
				const queued = session.mutate(() => {
					queuedStarted = true;
				}, BACKGROUND_CONTEXT);
				void queued.catch(() => {});
				const closing = session.close(BACKGROUND_CONTEXT);

				await active.end(BACKGROUND_CONTEXT);
				await rejects(queued);
				await closing;
				strictEqual(queuedStarted, false);
			},
		),
		createCase(
			factory,
			"lifecycle",
			"lists metadata and preserves state across close and reopen",
			async ({ repo }) => {
				const first = await repo.create({ id: "first" }, BACKGROUND_CONTEXT);
				await first.setName("preserved", BACKGROUND_CONTEXT);
				const second = await repo.create({ id: "second", parentSessionId: "parent" }, BACKGROUND_CONTEXT);
				await second.close(BACKGROUND_CONTEXT);

				const listed = await repo.list(undefined, BACKGROUND_CONTEXT);
				deepStrictEqual(
					listed
						.map(({ id, parentSessionId }) => ({ id, parentSessionId }))
						.sort((left, right) => left.id.localeCompare(right.id)),
					[
						{ id: "first", parentSessionId: undefined },
						{ id: "second", parentSessionId: "parent" },
					],
				);
				await first.close(BACKGROUND_CONTEXT);
				await rejects(first.getName(BACKGROUND_CONTEXT));
				const reopened = await repo.open(first.metadata, BACKGROUND_CONTEXT);
				strictEqual(reopened === first, false);
				strictEqual(await reopened.getName(BACKGROUND_CONTEXT), "preserved");
				await reopened.close(BACKGROUND_CONTEXT);
			},
		),
		createCase(factory, "lifecycle", "deletes closed sessions without affecting other sessions", async ({ repo }) => {
			const removed = await repo.create({ id: "removed" }, BACKGROUND_CONTEXT);
			const retained = await repo.create({ id: "retained" }, BACKGROUND_CONTEXT);
			await Promise.all([removed.close(BACKGROUND_CONTEXT), retained.close(BACKGROUND_CONTEXT)]);

			await repo.delete(removed.metadata, BACKGROUND_CONTEXT);
			deepStrictEqual(
				(await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ id }) => id),
				["retained"],
			);
			await rejects(repo.open(removed.metadata, BACKGROUND_CONTEXT));
			await rejects(repo.delete(removed.metadata, BACKGROUND_CONTEXT));
		}),
	];
}

/** Creates exclusive-open cases for repositories that own active session handles. */
export function createSessionRepoOwnershipConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "open">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(factory, "ownership", "rejects opening an already-open session", async ({ repo }) => {
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await rejects(repo.open(session.metadata, BACKGROUND_CONTEXT));
			await session.close(BACKGROUND_CONTEXT);

			const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
			await rejects(repo.open(session.metadata, BACKGROUND_CONTEXT));
			await reopened.close(BACKGROUND_CONTEXT);
		}),
	];
}

/** Creates message cases for repositories that support session creation. */
export function createSessionRepoMessageConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(
			factory,
			"messages",
			"rejects pending assistant messages without changing the tree",
			async ({ repo }) => {
				const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
				const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);

				await rejects(branch.appendMessage(assistantMessage("pending"), BACKGROUND_CONTEXT));

				strictEqual(await getBranchTip(session), null);
				deepStrictEqual(await session.findEntries(undefined, BACKGROUND_CONTEXT), []);
				await session.close(BACKGROUND_CONTEXT);
			},
		),
		createCase(factory, "messages", "preserves every settled assistant stop reason", async ({ repo }) => {
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const messagesByStopReason = {
				stop: assistantMessage("stop"),
				length: assistantMessage("length"),
				toolUse: assistantMessage("toolUse"),
				error: assistantMessage("error"),
				aborted: assistantMessage("aborted"),
				deferred: assistantMessage("deferred"),
			} satisfies Record<Exclude<StopReason, "pending">, AssistantMessage>;
			const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
			const messages = Object.values(messagesByStopReason);
			const ids: string[] = [];

			for (const message of messages) ids.push(await branch.appendMessage(message, BACKGROUND_CONTEXT));

			const entries = await session.findEntries({ order: "asc", type: "message" }, BACKGROUND_CONTEXT);
			deepStrictEqual(
				entries.map((entry) => entry.id),
				ids,
			);
			for (const [index, entry] of entries.entries()) {
				if (entry.type !== "message") throw new Error("Expected message entry");
				deepStrictEqual(entry.message, messages[index]);
			}
			strictEqual(await getBranchTip(session), ids.at(-1));
			await session.close(BACKGROUND_CONTEXT);
		}),
	];
}

/** Creates fork-content cases that do not require concurrent repository coordination. */
export function createSessionRepoForkBehaviorConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "list" | "fork">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(factory, "forks", "tree-forks a fresh session before first attachment", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			const fork = await repo.fork(source.metadata, { id: "fork", scope: "tree" }, BACKGROUND_CONTEXT);

			strictEqual(fork.metadata.id, "fork");
			strictEqual(fork.metadata.parentSessionId, "source");
			strictEqual(await fork.branch("main", BACKGROUND_CONTEXT), undefined);
			strictEqual(await fork.getValue(laneConfig("main"), BACKGROUND_CONTEXT), undefined);
			strictEqual(await fork.getValue(laneState("main"), BACKGROUND_CONTEXT), undefined);
			deepStrictEqual(await fork.findEntries(undefined, BACKGROUND_CONTEXT), []);
			deepStrictEqual(await fork.getStats(BACKGROUND_CONTEXT), {
				messageCount: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
			});
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		}),
		createCase(factory, "forks", "rejects a data-only branch and releases its destination id", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.createBranch("data", null, BACKGROUND_CONTEXT);

			await rejects(
				repo.fork(source.metadata, { id: "destination", scope: "branch", branch: "data" }, BACKGROUND_CONTEXT),
			);
			deepStrictEqual(
				(await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ id }) => id),
				["source"],
			);

			const destination = await repo.create({ id: "destination" }, BACKGROUND_CONTEXT);
			await Promise.all([source.close(BACKGROUND_CONTEXT), destination.close(BACKGROUND_CONTEXT)]);
		}),
		createCase(
			factory,
			"forks",
			"forks one named configured branch with scoped values and a zero ledger",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
				await source.mutate(
					(mutator) =>
						mutator.commit(
							[
								insertEntry({
									id: ROOT_ID,
									parentId: null,
									type: "custom",
									customType: "root",
								}),
								insertEntry({
									id: CHILD_ID,
									parentId: ROOT_ID,
									type: "message",
									message: { role: "user", content: "child", timestamp: 1 },
								}),
								insertEntry({
									id: SIBLING_ID,
									parentId: ROOT_ID,
									type: "custom",
									customType: "sibling",
								}),
								setValue(branchTip("main"), SIBLING_ID),
								setValue(branchTip("review"), CHILD_ID),
								setValue(laneConfig("review"), configuration),
								setValue(laneState("review"), {
									currentOperationId: OPERATION_ID,
									lastOperationId: "previous",
									inbox: [{ entryId: PENDING_ID, kind: "write" }],
								}),
								setValue(operationResult("previous"), {
									operationId: "previous",
									kind: "navigation",
									status: "completed",
									fromTipId: ROOT_ID,
									tipId: CHILD_ID,
									startedAt: 1,
									endedAt: 2,
								}),
								setValue(sessionName, "source name"),
								setValue(applicationValue, { copied: false }),
								appendList(applicationList, { copied: false }),
								setValue(entryLabel(ROOT_ID), "root label"),
								setValue(entryLabel(SIBLING_ID), "sibling label"),
								setValue(pendingEntry(PENDING_ID), {
									type: "custom",
									customType: "pending",
								}),
								setValue(operationMeta(OPERATION_ID), {
									operationId: OPERATION_ID,
									lane: "review",
									sourceTipId: CHILD_ID,
									startedAt: 1,
									intent: { kind: "compaction" },
								}),
								setValue(operationState(OPERATION_ID), {
									at: "summary.deciding",
									control: { status: "running" },
									settings: {
										compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
										steeringMode: "all",
										followUpMode: "all",
										toolExecution: "sequential",
									},
									latestAssistantEntryId: null,
									task: { taskId: OPERATION_ID, reason: "manual", boundary: { kind: "finish" } },
								}),
								setValue(operationToolArgs(OPERATION_ID, ROOT_ID, 0), {
									argument: true,
								}),
								setValue(operationPreparation(OPERATION_ID, OPERATION_ID), {
									kind: "compaction",
									messagesToSummarize: [],
									turnPrefixMessages: [],
									retainedTail: [],
									isSplitTurn: false,
									tokensBefore: 0,
									fileOps: { read: [], written: [], edited: [] },
									settings: {
										enabled: true,
										reserveTokens: 1,
										keepRecentTokens: 1,
									},
								}),
								insertUsage(usageRow()),
							],
							BACKGROUND_CONTEXT,
						),
					BACKGROUND_CONTEXT,
				);

				const fork = await repo.fork(
					source.metadata,
					{ id: "fork", scope: "branch", branch: "review", entryId: CHILD_ID, position: "at" },
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(
					(await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
					[ROOT_ID, CHILD_ID],
				);
				strictEqual(await fork.branch("main", BACKGROUND_CONTEXT), undefined);
				strictEqual(await getBranchTip(fork, "review"), CHILD_ID);
				deepStrictEqual((await fork.getValue(laneConfig("review"), BACKGROUND_CONTEXT))?.value, configuration);
				deepStrictEqual((await fork.getValue(laneState("review"), BACKGROUND_CONTEXT))?.value, idleLaneState);
				strictEqual(await fork.getValue(laneConfig("main"), BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getValue(laneState("main"), BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getName(BACKGROUND_CONTEXT), "source name");
				strictEqual(await fork.getValue(applicationValue, BACKGROUND_CONTEXT), undefined);
				deepStrictEqual(await fork.readList(applicationList, undefined, BACKGROUND_CONTEXT), []);
				strictEqual(await fork.getLabel(ROOT_ID, BACKGROUND_CONTEXT), "root label");
				strictEqual(await fork.getLabel(SIBLING_ID, BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getValue(operationResult("previous"), BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getValue(pendingEntry(PENDING_ID), BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getValue(operationMeta(OPERATION_ID), BACKGROUND_CONTEXT), undefined);
				strictEqual(await fork.getValue(operationState(OPERATION_ID), BACKGROUND_CONTEXT), undefined);
				strictEqual(
					await fork.getValue(operationToolArgs(OPERATION_ID, ROOT_ID, 0), BACKGROUND_CONTEXT),
					undefined,
				);
				strictEqual(
					await fork.getValue(operationPreparation(OPERATION_ID, OPERATION_ID), BACKGROUND_CONTEXT),
					undefined,
				);
				const stats = await fork.getStats(BACKGROUND_CONTEXT);
				strictEqual(stats.messageCount, 1);
				deepStrictEqual(stats.usage, {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				});
				await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
			},
		),
		createCase(factory, "forks", "enforces branch ancestry for at and before placement", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							insertEntry({ id: ROOT_ID, parentId: null, type: "custom", customType: "root" }),
							insertEntry({ id: CHILD_ID, parentId: ROOT_ID, type: "custom", customType: "child" }),
							insertEntry({ id: SIBLING_ID, parentId: ROOT_ID, type: "custom", customType: "sibling" }),
							setValue(branchTip("main"), CHILD_ID),
							setValue(laneConfig("main"), configuration),
							setValue(laneState("main"), idleLaneState),
							setValue(branchTip("empty"), null),
							setValue(laneConfig("empty"), configuration),
							setValue(laneState("empty"), idleLaneState),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const before = await repo.fork(
				source.metadata,
				{ id: "before", scope: "branch", branch: "main", entryId: CHILD_ID, position: "before" },
				BACKGROUND_CONTEXT,
			);
			strictEqual(await getBranchTip(before), ROOT_ID);
			deepStrictEqual(
				(await before.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
				[ROOT_ID],
			);

			const mid = await repo.fork(
				source.metadata,
				{ id: "mid", scope: "branch", branch: "main", entryId: ROOT_ID, position: "at" },
				BACKGROUND_CONTEXT,
			);
			strictEqual(await getBranchTip(mid), ROOT_ID);
			deepStrictEqual(
				(await mid.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
				[ROOT_ID],
			);

			const beforeRoot = await repo.fork(
				source.metadata,
				{ id: "before-root", scope: "branch", branch: "main", entryId: ROOT_ID, position: "before" },
				BACKGROUND_CONTEXT,
			);
			strictEqual(await getBranchTip(beforeRoot), null);
			deepStrictEqual(await beforeRoot.findEntries({ order: "asc" }, BACKGROUND_CONTEXT), []);

			const empty = await repo.fork(
				source.metadata,
				{ id: "empty", scope: "branch", branch: "empty" },
				BACKGROUND_CONTEXT,
			);
			strictEqual(await getBranchTip(empty, "empty"), null);
			deepStrictEqual(await empty.findEntries({ order: "asc" }, BACKGROUND_CONTEXT), []);

			for (const [id, branch, entryId] of [
				["off-branch", "main", SIBLING_ID],
				["unknown", "main", UNKNOWN_ID],
				["null-tip", "empty", ROOT_ID],
			] as const) {
				await rejects(repo.fork(source.metadata, { id, scope: "branch", branch, entryId }, BACKGROUND_CONTEXT));
			}
			deepStrictEqual((await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ id }) => id).sort(), [
				"before",
				"before-root",
				"empty",
				"mid",
				"source",
			]);
			await Promise.all([
				source.close(BACKGROUND_CONTEXT),
				before.close(BACKGROUND_CONTEXT),
				beforeRoot.close(BACKGROUND_CONTEXT),
				empty.close(BACKGROUND_CONTEXT),
				mid.close(BACKGROUND_CONTEXT),
			]);
		}),
		createCase(factory, "forks", "forks a closed source session", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							insertEntry({
								id: ROOT_ID,
								parentId: null,
								type: "custom",
								customType: "root",
							}),
							setValue(branchTip("main"), ROOT_ID),
							setValue(laneConfig("main"), configuration),
							setValue(laneState("main"), idleLaneState),
							setValue(applicationValue, "excluded"),
							appendList(applicationList, "excluded"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			await source.close(BACKGROUND_CONTEXT);

			const fork = await repo.fork(
				source.metadata,
				{ id: "fork", scope: "branch", branch: "main" },
				BACKGROUND_CONTEXT,
			);
			strictEqual(await getBranchTip(fork), ROOT_ID);
			deepStrictEqual((await fork.getValue(laneConfig("main"), BACKGROUND_CONTEXT))?.value, configuration);
			deepStrictEqual((await fork.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value, idleLaneState);
			strictEqual(await fork.getValue(applicationValue, BACKGROUND_CONTEXT), undefined);
			deepStrictEqual(await fork.readList(applicationList, undefined, BACKGROUND_CONTEXT), []);
			await fork.close(BACKGROUND_CONTEXT);
		}),

		createCase(factory, "forks", "forks the whole configured tree with fresh lane state", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							insertEntry({
								id: ROOT_ID,
								parentId: null,
								type: "custom",
								customType: "root",
							}),
							insertEntry({
								id: CHILD_ID,
								parentId: ROOT_ID,
								type: "custom",
								customType: "child",
							}),
							insertEntry({
								id: SIBLING_ID,
								parentId: ROOT_ID,
								type: "custom",
								customType: "sibling",
							}),
							setValue(branchTip("main"), CHILD_ID),
							setValue(laneConfig("main"), configuration),
							setValue(laneState("main"), idleLaneState),
							setValue(branchTip("review"), SIBLING_ID),
							setValue(laneConfig("review"), configuration),
							setValue(laneState("review"), idleLaneState),
							setValue(branchTip("notes"), ROOT_ID),
							setValue(applicationValue, { copied: true }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const fork = await repo.fork(source.metadata, { id: "fork", scope: "tree" }, BACKGROUND_CONTEXT);

			deepStrictEqual(
				(await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
				[ROOT_ID, CHILD_ID, SIBLING_ID],
			);
			strictEqual(await getBranchTip(fork), CHILD_ID);
			strictEqual(await getBranchTip(fork, "review"), SIBLING_ID);
			strictEqual(await getBranchTip(fork, "notes"), ROOT_ID);
			strictEqual(await fork.getValue(laneConfig("notes"), BACKGROUND_CONTEXT), undefined);
			strictEqual(await fork.getValue(laneState("notes"), BACKGROUND_CONTEXT), undefined);
			deepStrictEqual((await fork.getValue(laneConfig("review"), BACKGROUND_CONTEXT))?.value, configuration);
			deepStrictEqual((await fork.getValue(laneState("review"), BACKGROUND_CONTEXT))?.value, idleLaneState);
			deepStrictEqual((await fork.getValue(applicationValue, BACKGROUND_CONTEXT))?.value, { copied: true });
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		}),
		createCase(factory, "forks", "rejects only surviving unknown reserved scalar state", async ({ repo }) => {
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.createBranch("main", null, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[setValue(laneConfig("main"), configuration), setValue(laneState("main"), idleLaneState)],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			for (const namespace of ["pi", "pi.unknown"] as const) {
				const address = value<JsonValue>(namespace);
				await source.setValue(address, true, BACKGROUND_CONTEXT);
				await rejects(repo.fork(source.metadata, { id: "tree", scope: "tree" }, BACKGROUND_CONTEXT));
				await rejects(
					repo.fork(source.metadata, { id: "branch", scope: "branch", branch: "main" }, BACKGROUND_CONTEXT),
				);
				await source.deleteValue(address, BACKGROUND_CONTEXT);
			}
			await source.close(BACKGROUND_CONTEXT);

			const tree = await repo.fork(source.metadata, { id: "tree", scope: "tree" }, BACKGROUND_CONTEXT);
			const branch = await repo.fork(
				source.metadata,
				{ id: "branch", scope: "branch", branch: "main" },
				BACKGROUND_CONTEXT,
			);
			await Promise.all([tree.close(BACKGROUND_CONTEXT), branch.close(BACKGROUND_CONTEXT)]);
		}),
	];
}

/** Creates fork cases that require destination reservation across create and fork. */
export function createSessionRepoForkDestinationReservationConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "fork">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(
			factory,
			"fork coordination",
			"publishes create when it reserves a shared destination id first",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
				const results = await Promise.allSettled([
					repo.create({ id: "destination" }, BACKGROUND_CONTEXT),
					repo.fork(source.metadata, { id: "destination", scope: "tree" }, BACKGROUND_CONTEXT),
				]);
				strictEqual(results[0].status, "fulfilled");
				strictEqual(results[1].status, "rejected");
				if (results[0].status === "fulfilled") await results[0].value.close(BACKGROUND_CONTEXT);
				await source.close(BACKGROUND_CONTEXT);
			},
		),
		createCase(
			factory,
			"fork coordination",
			"publishes fork when it reserves a shared destination id first",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
				const results = await Promise.allSettled([
					repo.fork(source.metadata, { id: "destination", scope: "tree" }, BACKGROUND_CONTEXT),
					repo.create({ id: "destination" }, BACKGROUND_CONTEXT),
				]);
				strictEqual(results[0].status, "fulfilled");
				strictEqual(results[1].status, "rejected");
				if (results[0].status === "fulfilled") await results[0].value.close(BACKGROUND_CONTEXT);
				await source.close(BACKGROUND_CONTEXT);
			},
		),
	];
}

/** Creates fork cases that require a snapshot boundary on an active source storage queue. */
export function createSessionRepoForkSourceSnapshotConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "fork">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	const factory = prepareRepoCaseFactory(backendFactory, onClose);
	return [
		createCase(
			factory,
			"fork coordination",
			"captures one coherent boundary between source commits",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
				const firstMutation = await source.beginMutation(BACKGROUND_CONTEXT);
				const firstCommit = firstMutation.commit(
					[
						insertEntry({
							id: ROOT_ID,
							parentId: null,
							type: "custom",
							customType: "first",
						}),
						setValue(branchTip("main"), ROOT_ID),
						setValue(laneConfig("main"), configuration),
						setValue(laneState("main"), idleLaneState),
						setValue(sessionName, "first name"),
						setValue(entryLabel(ROOT_ID), "first label"),
					],
					BACKGROUND_CONTEXT,
				);
				const fork = repo.fork(
					source.metadata,
					{ id: "fork", scope: "branch", branch: "main" },
					BACKGROUND_CONTEXT,
				);
				const secondCommit = source.mutate(
					(mutator) =>
						mutator.commit(
							[
								insertEntry({
									id: CHILD_ID,
									parentId: ROOT_ID,
									type: "custom",
									customType: "second",
								}),
								setValue(branchTip("main"), CHILD_ID),
								setValue(sessionName, "second name"),
								setValue(entryLabel(ROOT_ID), "second label"),
							],
							BACKGROUND_CONTEXT,
						),
					BACKGROUND_CONTEXT,
				);

				const [, forked] = await Promise.all([firstCommit, fork]);
				await firstMutation.end(BACKGROUND_CONTEXT);
				await secondCommit;
				strictEqual(await getBranchTip(forked), ROOT_ID);
				deepStrictEqual(
					(await forked.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
					[ROOT_ID],
				);
				strictEqual(await forked.getName(BACKGROUND_CONTEXT), "first name");
				strictEqual(await forked.getLabel(ROOT_ID, BACKGROUND_CONTEXT), "first label");
				await Promise.all([source.close(BACKGROUND_CONTEXT), forked.close(BACKGROUND_CONTEXT)]);
			},
		),
	];
}

/** Creates every fork coordination case. */
export function createSessionRepoForkCoordinationConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "fork">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	return [
		...createSessionRepoForkDestinationReservationConformance(backendFactory, onClose),
		...createSessionRepoForkSourceSnapshotConformance(backendFactory, onClose),
	];
}

/** Creates every fork conformance case. */
export function createSessionRepoForkConformance<TMetadata extends SessionMetadata>(
	backendFactory: () => Promise<Pick<SessionRepo<TMetadata>, "create" | "list" | "fork">>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	return [
		...createSessionRepoForkBehaviorConformance(backendFactory, onClose),
		...createSessionRepoForkCoordinationConformance(backendFactory, onClose),
	];
}

/** Creates every SessionRepo conformance case. */
export function createSessionRepoConformance<TMetadata extends SessionMetadata>(
	factory: () => Promise<SessionRepo<TMetadata>>,
	onClose?: () => void | Promise<void>,
): readonly ConformanceCase[] {
	return [
		...createSessionRepoLifecycleConformance(factory, onClose),
		...createSessionRepoOwnershipConformance(factory, onClose),
		...createSessionRepoMessageConformance(factory, onClose),
		...createSessionRepoForkConformance(factory, onClose),
	];
}
