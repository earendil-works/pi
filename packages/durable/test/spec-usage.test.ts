/**
 * The usage examples of docs/spec.md, compile-checked. Each block is copied as written apart from formatting, with
 * the names the spec leaves to the application declared below. Keep the two in sync; `test/examples/` runs the same
 * patterns end to end.
 */
import type { Context, Draft } from "@earendil-works/chord";
import { type AssistantMessage, type Models, type ToolCall, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	GenerationTask,
	Harness,
	type HarnessSettings,
	type HookApi,
	hook,
	LiveDoc,
	type LiveState,
	type Session,
	type Storage,
	section,
	type TaskId,
	type ToolExecutionApi,
	ToolTask,
	type Tx,
	type UserInput,
	wrapTool,
} from "@earendil-works/pi-durable";
import { expect, expectTypeOf, it } from "vitest";
import type { ExecutionEnv } from "../src/env/index.ts";
import { CodingTools, createBashTool, createEditTool, createReadTool } from "../src/tools/index.ts";

// ─── Names the spec leaves to the application ────────────────────────────────

declare const context: Context;
declare const storage: Storage;
declare const models: Models;
declare const session: Session;
declare const conversationId: ConversationId;
declare const message: { readonly kind: string };
declare const haiku: { readonly provider: string; readonly modelId: string };
declare const sonnet: { readonly provider: string; readonly modelId: string };
declare const worktree: string;
declare const name: string;
declare function localEnv(cwd: string): ExecutionEnv;
declare const containers: { env(image: string, cwd: string, context: Context): Promise<ExecutionEnv> };
declare function renderAgentsMd(): string | undefined;
declare function renderSkills(): string | undefined;
declare function isDangerous(call: ToolCall): boolean;
declare function writes(call: ToolCall): boolean;
declare function requestSecondPass(
	answer: AssistantMessage,
	api: HookApi,
	context: Context,
): Promise<{ readonly continue: UserInput } | undefined>;
declare const metrics: { record(name: string, ms: number): void };
declare function answerText(api: ToolExecutionApi, entry: EntryId, context: Context): Promise<string>;
declare const payments: {
	charge(key: string): Promise<{ id: string }>;
	cancel(checkpoint: { phase: string }): Promise<void>;
};
declare function newKey(): string;
declare function receiptEntry(receipt: { id: string }): { kind: string; data: { id: string } };
interface SettingsManager {
	get(key: "timeoutMs"): number;
	get(key: "autoCompact"): boolean;
	set(key: "autoCompact", value: boolean): void;
}
declare const manager: SettingsManager;
declare const Anchor: ReturnType<typeof defineTask<null, { phase: "hold" }, null>>;
declare const Reporter: ReturnType<typeof defineTask<null, { phase: "report" }, null>>;
declare const subagentTool: ReturnType<typeof createReadTool>;

/** Never called: the declared names above have no values. */
function examples() {
	const readTool = createReadTool();
	const editTool = createEditTool();
	const bashTool = createBashTool();

	// ─── Section 7.1: extensions and host setup ──────────────────────────────────

	const ContextFiles = defineExtension({ name: "context-files", sections: [section("agents-md", renderAgentsMd)] });
	const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
	const SkillsV2 = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
	const Coding = defineExtension({
		name: "coding",
		sections: [
			section("preamble", () => "You are an expert coding assistant.", { tag: false }),
			// The environment the host built for this conversation, in the conversation's directory.
			section("cwd", (input) => input.env && `Working directory: ${input.env.cwd}`),
		],
	});
	const Permissions = defineExtension({
		name: "permissions",
		hooks: [
			hook(ToolTask, { beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) }),
		],
	});
	// A role and a review loop, for conversations that select it.
	const Reviewer = defineExtension({
		name: "reviewer",
		sections: [section("role", () => "You review diffs. Report problems as a list. Never edit files.")],
		hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
	});

	const Timing = defineExtension({
		name: "timing",
		wraps: [
			wrapTool(bashTool, (tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const start = Date.now();
					try {
						return await tool.execute(args, api, context);
					} finally {
						metrics.record("bash", Date.now() - start);
					}
				},
			})),
		],
	});
	// A bash inside a Python virtualenv for one conversation: it replaces CodingTools' bash in place,
	// and Timing, if selected, wraps it.
	const Venv = defineExtension({
		name: "venv",
		tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
	});

	// ─── Section 7.2: hooks reading extension state ──────────────────────────────

	const PlanModeDoc = defineDoc<{ enabled: boolean }>({
		kind: "app.plan-mode",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ enabled: false }),
	});
	const PlanMode = defineExtension({
		name: "plan-mode",
		hooks: [
			hook(ToolTask, {
				// An absent document means plan mode is off.
				beforeTool: async (call, api, context) =>
					(await api.snapshot(PlanModeDoc, api.conversationId, context))?.enabled && writes(call)
						? { block: "Plan mode: read-only" }
						: undefined,
			}),
		],
	});

	// ─── Section 7.3: subagents ──────────────────────────────────────────────────

	const Subagent = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description: "Delegate a self-contained task to a subagent and get its answer back.",
				parameters: Type.Object({ task: Type.String() }),
				replay: "safe",
				execute: async (args, api, context) => {
					const { task } = args;
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						// Starts as a copy of this conversation's agent: model, thinking level, cwd, extensions, tools.
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						// Without this extension, the child is not offered this tool.
						await configure(tx, created.id, { extensions: { remove: [Subagent] } });
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input")
						throw new Error(`Subagent failed: ${settled.status}`);
					return { content: [{ type: "text", text: await answerText(api, settled.answer, context) }] };
				},
			}),
		],
	});

	const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

	// ─── Section 7.4 ─────────────────────────────────────────────────────────────

	const Chat = defineExtension({
		name: "chat",
		sections: [section("preamble", () => "You are a helpful assistant.", { tag: false })],
	});

	// ─── Section 5.1: a task with intent, effect, outcome ────────────────────────

	type Charge = { phase: "prepare" } | { phase: "charge"; key: string };
	const Payment = defineTask<null, Charge, { entryId: EntryId }>({
		name: "app.payment",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			// Intent, effect, outcome.
			prepare: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }),
					context,
				);
			},
			charge: async (task, runtime, context) => {
				const receipt = await payments.charge(task.state.checkpoint.key); // idempotent by key
				await runtime.commit(async (tx, current) => {
					const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
					return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
				}, context);
			},
		},
		// The abort handler decides the outcome; returning without one faults the task.
		abort: async (task, runtime, context) => {
			await payments.cancel(task.state.checkpoint);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }), context);
		},
	});

	const Follow = defineTask<object, { phase: "follow" }, null>({
		name: "app.follow",
		version: 1,
		initial: () => ({ phase: "follow" }),
		phases: { follow: async () => {} },
		abort: async () => {},
	});

	// ─── Sequences ───────────────────────────────────────────────────────────────

	const sequences = {
		// Section 2.2: a tool's commit creates a configured child.
		childInToolCommit: async (tx: Tx, api: { readonly taskId: TaskId }) => {
			// In a tool's commit. The child starts as a copy of this conversation's agent: model, extensions, tools, cwd.
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			// A cheaper model, only the read tool, and its own worktree; everything else stays as copied.
			await configure(tx, child.id, { model: haiku, tools: [readTool], cwd: worktree });
		},

		// Section 2.2: settings read live through getters.
		liveSettings: () => {
			// The user's settings, read live through getters.
			class UserSettings implements HarnessSettings {
				readonly manager: SettingsManager;
				constructor(manager: SettingsManager) {
					this.manager = manager;
				}
				get stream() {
					return { timeoutMs: this.manager.get("timeoutMs") };
				}
				get compaction() {
					return { enabled: this.manager.get("autoCompact") };
				}
			}
			manager.set("autoCompact", false); // no Session write; every conversation follows at its next threshold check
			return new UserSettings(manager);
		},

		// Section 2.2: an environment per conversation.
		containerEnv: async () => {
			const registry = createRegistry();
			// Absent: the conversation runs locally. Only conversations with this document run in a container.
			// Subagents do not copy it: their creator writes it too when they should run in the container.
			const ContainerDoc = defineDoc<{ image: string }>({
				kind: "app.container",
				version: 1,
				scope: "conversation",
				history: "latest",
				fork: "current",
				initial: () => ({ image: "node:22" }),
			});
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					env: async ({ conversationId, cwd, read }, context) => {
						const container = await read.snapshot(ContainerDoc, conversationId, context);
						return container !== undefined
							? containers.env(container.image, cwd ?? "/work", context)
							: localEnv(cwd ?? process.cwd()); // cached NodeExecutionEnv per directory
					},
				},
				context,
			);
			return harness;
		},

		// Sections 2.2 and 7.1: host setup, tool filters, extension selection, plan mode, and reload.
		host: async () => {
			const registry = createRegistry();
			for (const extension of [CodingTools, Coding, ContextFiles, Skills, Permissions, Reviewer]) {
				registry.install(extension);
			}
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					// Reviewer is installed but not selected by default: only conversations that select it get its role and hooks.
					settings: { extensions: [CodingTools, Coding, ContextFiles, Skills, Permissions] },
					env: ({ cwd }) => localEnv(cwd ?? process.cwd()), // cached NodeExecutionEnv per directory
				},
				context,
			);
			// The conversation remembers its model and directory; a restart elsewhere keeps both.
			const root = await harness.root(context, { agent: { model: sonnet, cwd: process.cwd() } });

			await root.configure({ tools: { remove: [editTool] } }, context);
			await root.configure({ tools: { remove: [bashTool] } }, context); // edit is offered again
			await root.configure({ tools: null }, context); // every tool of the selected extensions again

			registry.install(Timing);
			registry.install(Venv); // installed, but not in the default selection
			const conversation = root;
			await conversation.configure({ extensions: { add: [Venv] } }, context);

			registry.install(PlanMode);
			// PlanMode is in the default selection; /plan toggles this conversation's state.
			await root.commit(async (tx) => {
				(await tx.doc(PlanModeDoc, root.id)).enabled = true;
			}, context);

			registry.install(Subagent);
			registry.install(Chat);
			registry.install(SkillsV2); // same name: conversations selecting skills render v2 at their next request
			registry.uninstall(Skills); // selecting conversations get a system delta removing its section; nothing is rewritten
			// Restart: the host installs its extensions again; stored names resolve against them.
			return harness;
		},

		// Section 7.3: a named subagent's spawn commit.
		spawn: async (tx: Tx) => {
			// In subagentTool's spawn commit, after the name checks:
			const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
			// Owned by a task of the parent: starts as a copy of the parent's agent.
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: { remove: [SubagentTools] },
				instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
			});
		},

		// Section 4: table reads before the first table write; documents stay usable.
		tableRules: async () => {
			await session.commit(async (tx) => {
				const conversation = await tx.conversation(conversationId); // table read
				const live = await tx.doc(LiveDoc, conversationId);

				await tx.appendEntry(conversationId, message); // first table write
				delete live.generation; // document mutation remains valid
				await tx.createTask(Follow, {}, { ownership: { kind: "conversation" }, conversationId }); // further table writes are fine
				void conversation;
			}, context);
		},

		// Section 3.4: drafts are revoked after their commit.
		revokedDraft: async () => {
			let escaped: Draft<LiveState> | undefined;
			await session.commit(async (tx) => {
				escaped = await tx.doc(LiveDoc, conversationId);
			}, context);
			escaped!.generation = undefined; // throws: the draft was revoked
		},
	};
	return { sequences, Payment };
}

it("compiles the spec's usage examples", () => {
	expectTypeOf(examples).returns.toHaveProperty("sequences");
	expect(examples).toBeTypeOf("function");
});
