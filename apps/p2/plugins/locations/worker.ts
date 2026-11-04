// The location tools (tool.ts) and the main agent's deferred move: `location_move` in the main conversation records the
// destination (`LocationMoveDoc`); once the session's worker has nothing running (the turn ended, no subagent work), it
// asks the server to move the session (`SessionMoves`, the same as the owner's Relocate). A refusal because work started
// meanwhile is retried after the next commit; a destination that became invalid is recorded as the move's failure.
// The record is Durable: a worker that stops first applies it after its next start.
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { type Ctx, contribute, defineFacet, expectVariant, sameLocation, signalOf } from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { CommitSignal, Extensions, HarnessNative, harnessOf, locateConversation, workerOf } from "@p2/app/v1/worker";
import { AgentLocations } from "./contract.ts";
import { LocationMoveDoc } from "./contract.worker.ts";
import { createLocationExtension } from "./tool.ts";

/** How long to wait before trying a refused move again when no commit comes. */
const RETRY_MS = 2000;

const server = (ctx: Ctx) => ctx.get(AgentLocations, {}).then((ref) => expectVariant(ref, "worker"));

export default defineFacet((host) => {
	contribute(host, "p2.location-tools", (self) => {
		const worker = workerOf(self);
		const harness = self.registry(HarnessNative);
		const extension = createLocationExtension({
			server: {
				envs: (context) =>
					worker().root(
						async (ctx) => (await (await server(ctx)).envs({ origin: "owner" }, ctx)).envs,
						context.abortSignal,
					),
				directories: (env, path, context) =>
					worker().root(
						async (ctx) => (await server(ctx)).directories({ origin: "owner", env, path }, ctx),
						context.abortSignal,
					),
			},
			locate: (id, read, context) => locateConversation(harness, id, context, read),
		});
		self.contribute(Extensions, { [extension.name]: extension });
	});
	contribute(host, "p2.location-mover", (self) => {
		const harness = harnessOf(self);
		// Every commit while a move waits (a run may have ended), else only changes of the move's record.
		let waiting = false;
		const commits = self.open(
			async () =>
				new CommitSignal(
					harness().durable,
					(publication) =>
						waiting ||
						publication.changes.some(
							(change) => change.type === "document" && change.record.kind === LocationMoveDoc.definition.kind,
						),
				),
			(signal) => signal.close(),
		);
		self.onLive(async (ctx) => {
			const durable = harness().durable;
			const signal = commits.value;
			while (!signalOf(ctx).aborted) {
				const seen = signal.version;
				try {
					const context = durableContext(ctx);
					const pending = (await durable.snapshot(LocationMoveDoc, ROOT_CONVERSATION_ID, context))?.pending;
					waiting = pending !== undefined;
					const inspection = pending ? await durable.inspect(context) : undefined;
					if (!pending || !inspection) {
						await signal.next(seen, signalOf(ctx));
						continue;
					}
					if (inspection.tasks.length + inspection.submissions.length > 0) {
						// Bounded too: a commit ending the run may have come before `waiting` was set.
						await Promise.race([
							signal.next(seen, signalOf(ctx)),
							sleep(RETRY_MS, undefined, { signal: signalOf(ctx) }),
						]);
						continue;
					}
					let failure: string | undefined;
					try {
						const { refused } = await (await server(ctx)).move({ origin: "owner", ...pending }, ctx);
						if (refused !== null) {
							// Work started meanwhile: once it ends.
							await Promise.race([
								signal.next(seen, signalOf(ctx)),
								sleep(RETRY_MS, undefined, { signal: signalOf(ctx) }),
							]);
							continue;
						}
					} catch (error) {
						if (signalOf(ctx).aborted) return;
						failure = error instanceof Error ? error.message : String(error);
					}
					await durable.commit(async (tx) => {
						const state = await tx.doc(LocationMoveDoc, ROOT_CONVERSATION_ID);
						// A newer destination waits for its own turn.
						if (!state.pending || !sameLocation(state.pending, pending)) return;
						delete state.pending;
						if (failure === undefined) delete state.failed;
						else state.failed = { to: pending, error: failure };
					}, context);
					if (failure !== undefined) console.error(`p2 locations: moving the session failed: ${failure}`);
				} catch (error) {
					if (signalOf(ctx).aborted) return;
					console.error("p2 locations: the deferred move failed, retrying:", error);
					await sleep(RETRY_MS, undefined, { signal: signalOf(ctx) }).catch(() => {});
				}
			}
		});
	});
});
