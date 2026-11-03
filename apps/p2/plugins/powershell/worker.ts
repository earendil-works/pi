// PowerShell where an agent works on Windows, as Pi Mobile offers it (offerPowerShell), per agent: Durable's
// `powershell` tool, deferred, is offered to each conversation whose location's machine runs Windows (this device on a
// Windows host, a remote environment once it reports Windows) and that has the shell tool `bash`. The main agent and
// each subagent are decided independently, from where each works now, and again after every move.
import { setTimeout as sleep } from "node:timers/promises";
import {
	AgentDoc,
	type AgentState,
	type ConversationId,
	defineExtension,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { defineFacet, type Location, signalOf } from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { CommitSignal, Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { Subagents } from "../subagents/contract.worker.ts";
import { POWERSHELL_EXTENSION, POWERSHELL_TOOL, PowerShell } from "./contract.ts";

/** A remote environment's connection (`RemoteExecutionEnv.connection`), which reports the remote system. */
type SystemInfo = { readonly connection?: { info(): Promise<{ readonly os: string }> } };

/** How long to wait before asking an unreachable remote environment again. */
const RETRY_MS = 30_000;

/** Whether `state` enables a tool: every tool unless an array leaves it out or `remove` names it. */
const enables = (state: AgentState | undefined, name: string): boolean =>
	Array.isArray(state?.tools) ? state.tools.includes(name) : !state?.tools?.remove.includes(name);
/** Whether the conversation is offered PowerShell now: enabled, and loaded for the model (it is deferred). */
export const offersPowerShell = (state: AgentState | undefined): boolean =>
	enables(state, POWERSHELL_TOOL) &&
	(Array.isArray(state?.modelTools)
		? state.modelTools.includes(POWERSHELL_TOOL)
		: (state?.modelTools?.add ?? []).includes(POWERSHELL_TOOL));

/** Offers PowerShell to the agent `state` or takes it away, leaving its other tool choices as they are. */
export function setPowerShell(state: AgentState, on: boolean): void {
	const without = (names: readonly string[]) => names.filter((name) => name !== POWERSHELL_TOOL);
	if (Array.isArray(state.tools)) state.tools = on ? [...without(state.tools), POWERSHELL_TOOL] : without(state.tools);
	else if (on && state.tools?.remove.includes(POWERSHELL_TOOL)) state.tools = { remove: without(state.tools.remove) };
	if (Array.isArray(state.modelTools)) {
		state.modelTools = on ? [...without(state.modelTools), POWERSHELL_TOOL] : without(state.modelTools);
		return;
	}
	const add = [...without(state.modelTools?.add ?? []), ...(on ? [POWERSHELL_TOOL] : [])];
	const remove = state.modelTools?.remove ?? [];
	state.modelTools = { ...(remove.length ? { remove } : {}), ...(add.length ? { add } : {}) };
}

export default defineFacet((host) => {
	const extension = defineExtension({
		name: POWERSHELL_EXTENSION,
		tools: [{ ...createPowerShellTool(), deferred: true }],
	});
	host.serve(PowerShell, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const offeredState = self.writable<Record<string, boolean>>({});
		self.contribute(Extensions, { [extension.name]: extension });
		// Agents' tool choices and the subagents' locations change through commits; the session's through moves.
		const commits = self.open(
			async () =>
				new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							change.type === "document" &&
							(change.record.kind === AgentDoc.definition.kind ||
								change.record.kind === Subagents.definition.kind),
					),
				),
			(signal) => signal.close(),
		);
		/** Remote systems known so far, by environment name. */
		const systems = new Map<string, boolean>();
		/** Whether `location`'s machine runs Windows; undefined while unknown (an unreachable environment). */
		const isWindows = async (location: Location): Promise<boolean | undefined> => {
			if (location.env === null) return process.platform === "win32";
			const known = systems.get(location.env);
			if (known !== undefined) return known;
			try {
				const { connection } = (await harness().environments.at(location)) as SystemInfo;
				if (!connection) return undefined;
				const windows = (await connection.info()).os === "windows";
				systems.set(location.env, windows);
				return windows;
			} catch {
				return undefined;
			}
		};
		self.onLive(async (ctx) => {
			const durable = harness().durable;
			const signal = commits.value;
			while (!signalOf(ctx).aborted) {
				const seen = signal.version;
				let unknown = false;
				try {
					const context = durableContext(ctx);
					const registry = await durable.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
					const ids: ConversationId[] = [
						ROOT_CONVERSATION_ID,
						...Object.values(registry?.agents ?? {}).map((agent) => agent.conversationId),
						...Object.values(registry?.oneShots ?? {}).map((agent) => agent.conversationId),
					];
					const offered: Record<string, boolean> = {};
					const changes: { id: ConversationId; on: boolean }[] = [];
					for (const id of ids) {
						const state = await durable.snapshot(AgentDoc, id, context);
						const windows = await isWindows(await harness().environments.locate(id, context));
						if (windows === undefined) unknown = true;
						// Unknown keeps what it has: an unreachable machine does not take PowerShell away.
						const on = windows === undefined ? offersPowerShell(state) : windows && enables(state, "bash");
						offered[String(id)] = on;
						if (on !== offersPowerShell(state)) changes.push({ id, on });
					}
					if (changes.length)
						await durable.commit(async (tx) => {
							for (const { id, on } of changes) setPowerShell(await tx.doc(AgentDoc, id), on);
						}, context);
					offeredState.set(offered);
				} catch (error) {
					if (signalOf(ctx).aborted) return;
					console.error("p2 powershell: deciding which agents are offered PowerShell failed:", error);
					unknown = true;
				}
				// Again after a relevant commit or a move (another machine may run another system), and later while a
				// remote system is unknown.
				const moved = new AbortController();
				const abort = (): void => moved.abort();
				signalOf(ctx).addEventListener("abort", abort, { once: true });
				try {
					await Promise.race([
						signal.next(seen, moved.signal),
						worker().location.next(moved.signal),
						...(unknown ? [sleep(RETRY_MS, undefined, { signal: moved.signal })] : []),
					]).catch(() => {});
				} finally {
					moved.abort();
					signalOf(ctx).removeEventListener("abort", abort);
				}
			}
		});
		return { offered: self.derive([offeredState], ([value]) => value) };
	});
});
