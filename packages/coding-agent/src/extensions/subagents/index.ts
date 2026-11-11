// Native sub-agents: independent sessions, compact parent results, and a shared /agents control view.
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { parsePaneCommand } from "../../core/panes/command.ts";
import { openPane, type PaneHandle } from "../../core/panes/host.ts";
import { getSessionRecovery } from "../../core/session-recovery.ts";
import { discoverAgentDefinitions } from "../../core/subagents/definitions.ts";
import { SubagentManager } from "../../core/subagents/manager.ts";
import { SubagentIdSchema, type SubagentResult } from "../../core/subagents/state.ts";
import {
	approveAgentDefinition,
	createSubagentToolDefinition,
	startConfiguredAgent,
} from "../../core/subagents/tool.ts";
import { SubagentsView } from "../../core/subagents/view.ts";
import { truncateHead } from "../../core/tools/truncate.ts";

const noticeValidator = Compile(Type.Object({ id: SubagentIdSchema, run: Type.Integer({ minimum: 1 }) }));

/** Register native delegation, parent-scoped controls, isolated histories, and /agents. */
export function createSubagentExtension(agentDir = getAgentDir()): ExtensionFactory {
	return (pi) => {
		let manager: SubagentManager | undefined;
		let context: ExtensionContext | undefined;
		let lifetime = new AbortController();
		let pane: PaneHandle | undefined;
		let opening: Promise<PaneHandle> | undefined;
		let scheduled = false;
		let unregisterRecovery: (() => void) | undefined;
		const delivered = new Set<string>();
		const observing = new Set<string>();
		const pending = new Map<string, SubagentResult>();

		function getManager(ctx: ExtensionContext): SubagentManager {
			context = ctx;
			if (!manager) {
				manager = new SubagentManager({
					parent: ctx.sessionManager,
					cwd: ctx.cwd,
					agentDir,
					modelRuntime: ctx.modelRegistry.runtime,
					getSettings: () => pi.getSettings(),
					getModel: () => ctx.model,
					getThinkingLevel: () => ctx.thinkingLevel ?? "off",
					getAllowedTools: () => pi.getActiveTools(),
					getSystemPrompt: () => context?.getSystemPrompt() ?? ctx.getSystemPrompt(),
				});
				const owner = manager;
				unregisterRecovery = getSessionRecovery(ctx.sessionManager).registerPeer({
					pause: () => owner.pause(),
					resume: () => owner.continuePaused(),
					pending: () => owner.recoverable().map(({ id, label }) => ({ id, label })),
					recover: async () => {
						await owner.pause();
						const agents = owner.recoverable();
						for (const agent of agents) await approveAgentDefinition(owner.definition(agent.id), context ?? ctx);
						for (const agent of agents) {
							owner.recover(agent.id);
							if (agent.async) observe(agent.id, context ?? ctx);
						}
					},
					discard: async () => {
						for (const agent of owner.recoverable()) await owner.cancel(agent.id);
					},
				});
				for (const entry of ctx.sessionManager.getEntries()) {
					if (
						entry.type === "custom_message" &&
						entry.customType === "subagent-result" &&
						noticeValidator.Check(entry.details)
					)
						delivered.add(`${entry.details.id}:${entry.details.run}`);
				}
			}
			return manager;
		}

		function scheduleDelivery() {
			if (scheduled || lifetime.signal.aborted) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (!context || lifetime.signal.aborted) return;
				const branch = new Set(context.sessionManager.getBranch().map((entry) => entry.id));
				const ready = [...pending].filter(
					([, result]) => result.agent.originEntryId === null || branch.has(result.agent.originEntryId),
				);
				for (const [key, result] of ready) {
					if (delivered.has(key)) {
						pending.delete(key);
						continue;
					}
					const agent = result.agent;
					try {
						const notice = truncateHead(
							`Sub-agent ${agent.id} (${agent.role}): ${agent.label}\nRun ${agent.run}: ${agent.status}.\nChild usage: input ${agent.usage.input}, output ${agent.usage.output}.\n${agent.historyPath ? `Independent history: ${agent.historyPath}\n` : ""}${agent.error ? `Error: ${agent.error}\n` : ""}\n${result.text}${result.truncated ? "\n[Result truncated; use paged subagent history for the full original response.]" : ""}`,
						);
						pi.sendMessage(
							{
								customType: "subagent-result",
								display: true,
								content:
									notice.content +
									(notice.truncated
										? `\n[Notice truncated; use subagent history for ${agent.id} to retrieve original evidence.]`
										: ""),
								details: { id: agent.id, run: agent.run, status: agent.status, usage: agent.usage },
							},
							{ deliverAs: "followUp", triggerTurn: false },
						);
						delivered.add(key);
						pending.delete(key);
					} catch (error) {
						context.ui.notify(`Cannot deliver sub-agent result ${agent.id}: ${String(error)}`, "error");
					}
				}
			});
		}

		function observe(id: string, ctx: ExtensionContext): void {
			const owner = getManager(ctx);
			const info = owner.inspect(id);
			const key = `${id}:${info.run}`;
			if (observing.has(key) || delivered.has(key)) return;
			observing.add(key);
			const signal = lifetime.signal;
			void owner
				.wait(id)
				.then(
					(result) => {
						if (signal.aborted || result.agent.status === "paused") return;
						pending.set(key, result);
						scheduleDelivery();
					},
					(error: unknown) => {
						if (!signal.aborted) ctx.ui.notify(`Cannot monitor sub-agent ${id}: ${String(error)}`, "error");
					},
				)
				.finally(() => {
					observing.delete(key);
				});
		}
		pi.registerTool(createSubagentToolDefinition(getManager, agentDir, observe));

		pi.registerCommand("agents", {
			description:
				"List roles and sub-agents, view independent history, and start/message/resume/stop tasks: /agents [--tui|--rex] [ID]",
			handler: async (args, ctx) => {
				if (args.trim() === "--help") {
					ctx.ui.notify(
						"/agents [--tui|--rex] [--split|--floating] [--minimized] [ID]. Choose a role with the new-agent binding. Histories are separate; edits share this working tree.",
						"info",
					);
					return;
				}
				const { options, text: id } = parsePaneCommand(args);
				const owner = getManager(ctx);
				if (id) owner.inspect(id);
				if (opening) await opening;
				if (pane) {
					await pane.close();
					pane = undefined;
				}
				const signal = lifetime.signal;
				opening = openPane(ctx, {
					...options,
					title: "Sub-agents",
					signal,
					create: (controls) =>
						new SubagentsView(
							owner,
							controls,
							{
								definitions: () => discoverAgentDefinitions(ctx.cwd, agentDir),
								start: async (name, task) => {
									const recovery = getSessionRecovery(ctx.sessionManager);
									if (recovery.isPaused || recovery.needsRecovery)
										throw new Error("Continue the parent with /pause before starting another child");
									recovery.claim();
									const role = discoverAgentDefinitions(ctx.cwd, agentDir).agents.find(
										(role) => role.name === name,
									);
									if (!role) throw new Error(`Unknown role: ${name}`);
									const agent = await startConfiguredAgent(owner, role, task, ctx, { delivery: "async" });
									observe(agent.id, ctx);
									return agent;
								},
								resume: async (id, task) => {
									const recovery = getSessionRecovery(ctx.sessionManager);
									if (recovery.isPaused || recovery.needsRecovery)
										throw new Error("Continue the parent with /pause before resuming a child");
									recovery.claim();
									await approveAgentDefinition(owner.definition(id), ctx);
									const agent = owner.resume(id, task, { delivery: "async" });
									observe(id, ctx);
									return agent;
								},
							},
							id || undefined,
						),
				});
				try {
					const created = await opening;
					pane = created;
					void created.closed.then(() => {
						if (pane === created) pane = undefined;
					});
				} finally {
					opening = undefined;
				}
			},
		});

		pi.on("session_start", (_event, ctx) => {
			if (lifetime.signal.aborted) lifetime = new AbortController();
			if (
				ctx.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "pi.subagent")
			) {
				pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "subagent"));
				return;
			}
			const owner = getManager(ctx);
			for (const agent of owner.list()) {
				if (
					agent.async &&
					(agent.status === "completed" || agent.status === "failed" || agent.status === "stopped")
				)
					observe(agent.id, ctx);
			}
		});
		pi.on("session_tree", (_event, ctx) => {
			context = ctx;
			scheduleDelivery();
		});
		pi.on("session_shutdown", async () => {
			lifetime.abort();
			try {
				await manager?.close();
				unregisterRecovery?.();
				unregisterRecovery = undefined;
			} finally {
				await opening?.catch(() => {});
				await pane?.close();
				pane = undefined;
				opening = undefined;
				manager = undefined;
				context = undefined;
				pending.clear();
				observing.clear();
				delivered.clear();
			}
		});
	};
}
export default createSubagentExtension();
